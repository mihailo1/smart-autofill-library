// Rules for matching page fields against the library without calling Gemini.
// Used as the first (fast and free) step before falling back to Gemini API.

function afFieldTextBlob(field) {
  return [field.name, field.id, field.placeholder, field.label, field.ariaLabel, field.guessedConcept]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Detect exclusive social/platform signals on a field. */
function afFieldPlatformSignals(field) {
  const raw = afFieldTextBlob(field);
  return {
    raw,
    linkedin: /\blinkedin\b|linked-in/.test(raw),
    github: /\bgithub\b|gitlab/.test(raw),
    twitter: /\btwitter\b|\bx\.com\b/.test(raw),
    portfolio: /\bportfolio\b/.test(raw),
    website: /\bwebsite\b|homepage|home page/.test(raw),
  };
}

/**
 * Whether this library key/value is acceptable for a field with the given platform signals.
 * Prevents LinkedIn fields from receiving GitHub URLs and vice versa.
 */
function afLibraryKeyCompatibleWithField(libraryKey, entry, signals) {
  const keyL = String(libraryKey || "").toLowerCase();
  const labelL = String(entry?.label || "").toLowerCase();
  const valL = String(entry?.value || "").toLowerCase();
  const blob = `${keyL} ${labelL} ${valL}`;

  const keyIsGithub = /github|gitlab/.test(blob);
  const keyIsLinkedin = /linkedin/.test(blob);
  const keyIsTwitter = /twitter|\bx\b/.test(keyL) || /twitter\.com|x\.com/.test(valL);

  // Exclusive platforms: field asks for A → reject library entry that is clearly B.
  if (signals.linkedin && !signals.github && keyIsGithub) return false;
  if (signals.github && !signals.linkedin && keyIsLinkedin) return false;
  if (signals.linkedin && !signals.portfolio && !signals.website && keyIsGithub) return false;

  // Field is LinkedIn (optionally + portfolio): prefer linkedin; allow portfolio/website
  // only if not a pure github entry.
  if (signals.linkedin && keyIsGithub && !signals.github) return false;

  if (signals.github && !signals.linkedin && keyIsLinkedin) return false;
  if (signals.twitter && (keyIsGithub || keyIsLinkedin) && !keyIsTwitter) return false;

  return true;
}

/**
 * Match library entry key/label against field text (for custom keys like "linkedin", "github").
 * Returns best library key or null.
 */
function afMatchLibraryKeyByText(field, library) {
  const signals = afFieldPlatformSignals(field);
  const raw = signals.raw;
  const compact = raw.replace(/[^a-zа-яё0-9]+/gi, "");
  if (!raw) return null;

  // Strong platform preference: if field mentions linkedin and library has linkedin*, use it.
  if (signals.linkedin) {
    for (const [key, entry] of Object.entries(library.entries || {})) {
      if (!entry?.value) continue;
      const keyL = key.toLowerCase();
      if (/linkedin/.test(keyL) || /linkedin/.test(String(entry.label || "").toLowerCase())) {
        return key;
      }
      if (/linkedin\.com/.test(String(entry.value).toLowerCase()) && /linkedin/.test(keyL + entry.label)) {
        return key;
      }
    }
  }
  if (signals.github && !signals.linkedin) {
    for (const [key, entry] of Object.entries(library.entries || {})) {
      if (!entry?.value) continue;
      if (/github|gitlab/.test(key.toLowerCase()) || /github|gitlab/.test(String(entry.label || "").toLowerCase())) {
        return key;
      }
    }
  }

  let best = null;
  for (const [key, entry] of Object.entries(library.entries || {})) {
    if (!entry || !entry.value) continue;
    if (!afLibraryKeyCompatibleWithField(key, entry, signals)) continue;

    const keyNorm = String(key).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
    const labelNorm = String(entry.label || "")
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, "");
    if (!keyNorm && !labelNorm) continue;

    let score = 0;
    if (keyNorm && keyNorm.length >= 3 && compact.includes(keyNorm)) {
      score = Math.max(score, keyNorm.length * 3);
    }
    if (labelNorm && labelNorm.length >= 3 && compact.includes(labelNorm)) {
      score = Math.max(score, labelNorm.length * 2);
    }
    const labelWords = String(entry.label || "")
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length >= 4);
    for (const w of labelWords) {
      if (compact.includes(w)) score = Math.max(score, w.length * 2);
    }

    // Boost platform-aligned keys.
    if (signals.linkedin && /linkedin/.test(keyNorm + labelNorm)) score += 50;
    if (signals.github && /github/.test(keyNorm + labelNorm)) score += 50;
    if (signals.portfolio && /portfolio/.test(keyNorm + labelNorm)) score += 20;

    // When field mentions LinkedIn, demote pure github; mild demote for generic website.
    if (signals.linkedin && /github|gitlab/i.test(keyNorm + labelNorm)) score -= 40;
    if (signals.linkedin && /^website$/i.test(key) && !signals.website) score -= 15;

    if (score > 0 && (!best || score > best.score)) {
      best = { key, score };
    }
  }

  if (!best || best.score < 12) return null;

  // LinkedIn field without a linkedin library key:
  // - allow portfolio/website fallback when the label also says portfolio/website
  // - never fall back to github
  if (signals.linkedin && !/linkedin/i.test(best.key)) {
    if (/github|gitlab/i.test(best.key)) return null;
    if (signals.portfolio && /portfolio/i.test(best.key)) return best.key;
    if ((signals.portfolio || signals.website) && /website/i.test(best.key)) return best.key;
    return null;
  }
  return best.key;
}

function afMatchFieldsToLibrary(fields, library) {
  const mapping = {}; // afId -> value
  const matchedConcepts = [];
  const unmatched = [];

  for (const field of fields) {
    // Open-ended essay questions → ✨ AI panel, never profile library auto-fill.
    if (field.isEssay) {
      unmatched.push(field);
      continue;
    }

    const signals = afFieldPlatformSignals(field);
    let libraryKey = null;
    let via = null;

    // 1) Concept guess (linkedin beats website).
    if (field.guessedConcept && field.guessedConfidence >= 0.6) {
      const entry = library.entries[field.guessedConcept];
      if (
        entry &&
        entry.value &&
        afLibraryKeyCompatibleWithField(field.guessedConcept, entry, signals)
      ) {
        libraryKey = field.guessedConcept;
        via = "rules-concept";
      }
    }

    // 2) Direct key/label text match.
    if (!libraryKey) {
      const byText = afMatchLibraryKeyByText(field, library);
      if (byText && library.entries[byText]?.value) {
        libraryKey = byText;
        via = "rules-text";
      }
    }

    if (libraryKey && library.entries[libraryKey]?.value) {
      const value = library.entries[libraryKey].value;
      if (
        field.tag === "textarea" &&
        typeof afValueLooksLikeUrlOrHandle === "function" &&
        afValueLooksLikeUrlOrHandle(value)
      ) {
        unmatched.push(field);
        continue;
      }
      mapping[field.afId] = value;
      matchedConcepts.push({ afId: field.afId, key: libraryKey, via });
    } else {
      unmatched.push(field);
    }
  }

  return { mapping, matchedConcepts, unmatched };
}

/**
 * Fields that should be sent to Gemini for library matching.
 * Essays are excluded — they use AI answer generation, not key matching.
 */
function afFieldsForGeminiMatching(fields) {
  return (fields || []).filter((f) => !f.isEssay);
}

/**
 * Filter Gemini match results: drop unsafe pairs (essay ← URL, LinkedIn ← GitHub, etc.).
 */
function afFilterGeminiMatches(matches, fields, library) {
  const byId = new Map((fields || []).map((f) => [f.afId, f]));
  const out = [];

  for (const match of matches || []) {
    const { afId, libraryKey } = match || {};
    if (!afId || !libraryKey) continue;
    const field = byId.get(afId);
    const entry = library?.entries?.[libraryKey];
    if (!field || !entry?.value) continue;
    if (field.isEssay) continue;

    if (
      field.tag === "textarea" &&
      typeof afValueLooksLikeUrlOrHandle === "function" &&
      afValueLooksLikeUrlOrHandle(entry.value)
    ) {
      continue;
    }

    const signals = afFieldPlatformSignals(field);
    if (!afLibraryKeyCompatibleWithField(libraryKey, entry, signals)) continue;

    // Extra: LinkedIn-only field must not get github.com values.
    if (signals.linkedin && !signals.github && /github\.com/i.test(entry.value)) continue;
    if (signals.github && !signals.linkedin && /linkedin\.com/i.test(entry.value)) continue;

    out.push(match);
  }

  return out;
}

if (typeof self !== "undefined") {
  self.afMatchFieldsToLibrary = afMatchFieldsToLibrary;
  self.afMatchLibraryKeyByText = afMatchLibraryKeyByText;
  self.afFieldsForGeminiMatching = afFieldsForGeminiMatching;
  self.afFilterGeminiMatches = afFilterGeminiMatches;
  self.afFieldPlatformSignals = afFieldPlatformSignals;
}
