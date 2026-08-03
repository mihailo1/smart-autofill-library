// Gemini API client. Called from popup (no separate background service worker in this
// extension — see manifest.json). API key is stored in chrome.storage.local.
//
// Important: ONLY field metadata (name/id/label/placeholder/type) and library entry
// keys + labels (without values!) are sent to Gemini. The actual saved values
// (email, phone, etc.) never leave the device — they are substituted locally after
// Gemini returns which library key corresponds to which field.

const AF_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** In-memory session cache: same page fields + library keys → skip repeat Gemini matching. */
const AF_GEMINI_MATCH_CACHE = new Map(); // cacheKey → { matches, at }
const AF_GEMINI_MATCH_CACHE_MAX = 24;

function afGeminiMatchCacheKey(fields, libraryConceptsBrief, model) {
  const fieldPart = (fields || [])
    .map((f) =>
      [f.afId, f.type, f.tag, f.name, f.id, f.placeholder, f.label, f.ariaLabel, f.guessedConcept, f.isEssay ? 1 : 0].join(
        "\u001f"
      )
    )
    .join("\u001e");
  const libPart = (libraryConceptsBrief || []).map((c) => `${c.key}:${c.label}`).join("\u001f");
  // Simple djb2-ish hash to keep keys short
  const raw = `${model || ""}\u001e${fieldPart}\u001e${libPart}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) h = (h * 33) ^ raw.charCodeAt(i);
  return `gm:${(h >>> 0).toString(36)}:${fields.length}:${libraryConceptsBrief.length}`;
}

function afGeminiMatchCacheGet(key) {
  const hit = AF_GEMINI_MATCH_CACHE.get(key);
  return hit ? hit.matches : null;
}

function afGeminiMatchCacheSet(key, matches) {
  if (AF_GEMINI_MATCH_CACHE.size >= AF_GEMINI_MATCH_CACHE_MAX) {
    // Drop oldest
    const first = AF_GEMINI_MATCH_CACHE.keys().next().value;
    if (first != null) AF_GEMINI_MATCH_CACHE.delete(first);
  }
  AF_GEMINI_MATCH_CACHE.set(key, { matches, at: Date.now() });
}

function afGeminiMatchCacheClear() {
  AF_GEMINI_MATCH_CACHE.clear();
}

function afBuildMatchPrompt(fields, libraryConceptsBrief) {
  return [
    "You help match web form fields to items in the user's personal data library.",
    "Given a list of form fields (without values) and a list of available library keys (key + label, also without values).",
    "For each field where you are confident in the match, return an object { afId, libraryKey }.",
    "If a field has no suitable key, simply don't include it in the response.",
    "Respond STRICTLY as a JSON array, without explanations or markdown.",
    "",
    "Matching rules (strict):",
    "- Prefer specific keys over generic ones (linkedin ≠ github ≠ portfolio ≠ website).",
    "- A field labeled LinkedIn must map only to a LinkedIn key, never to GitHub.",
    "- A field labeled GitHub must map only to a GitHub key, never to LinkedIn.",
    "- 'LinkedIn / Portfolio URL' is primarily LinkedIn; use portfolio/website only if there is no linkedin key.",
    "- Do NOT match open-ended / essay / motivation questions (why do you…, tell us…, describe…) to any URL/social/profile keys.",
    "- Do NOT match textareas that ask for written answers to website/portfolio/github/linkedin keys.",
    "- If unsure, omit the field.",
    "",
    "Form fields:",
    JSON.stringify(
      fields.map((f) => ({
        afId: f.afId,
        type: f.type,
        tag: f.tag,
        name: f.name,
        id: f.id,
        autocomplete: f.autocomplete,
        placeholder: f.placeholder,
        label: f.label,
        ariaLabel: f.ariaLabel,
        isEssay: !!f.isEssay,
        guessedConcept: f.guessedConcept || null,
      }))
    ),
    "",
    "Available library keys:",
    JSON.stringify(libraryConceptsBrief),
  ].join("\n");
}

function afParseGeminiJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const arr = cleaned.match(/\[[\s\S]*\]/);
    if (arr) {
      try {
        return JSON.parse(arr[0]);
      } catch (e2) {
        /* fall through */
      }
    }
    const obj = cleaned.match(/\{[\s\S]*\}/);
    if (obj) {
      try {
        return JSON.parse(obj[0]);
      } catch (e3) {
        return null;
      }
    }
    return null;
  }
}

async function afCallGeminiForMatching(fields, library, settings) {
  if (!settings.geminiApiKey || fields.length === 0) return [];

  const libraryConceptsBrief = Object.entries(library.entries)
    .filter(([, entry]) => !!entry.value)
    .map(([key, entry]) => ({ key, label: entry.label }));

  if (libraryConceptsBrief.length === 0) return [];

  const cacheKey = afGeminiMatchCacheKey(fields, libraryConceptsBrief, settings.geminiModel);
  const cached = afGeminiMatchCacheGet(cacheKey);
  if (cached) return cached;

  const prompt = afBuildMatchPrompt(fields, libraryConceptsBrief);
  const url = `${AF_GEMINI_ENDPOINT}/${settings.geminiModel}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "[]";
  const parsed = afParseGeminiJson(text);
  const matches = Array.isArray(parsed) ? parsed : [];
  afGeminiMatchCacheSet(cacheKey, matches);
  return matches;
}

// Field classification when saving: helps pick a readable key/label for fields
// that rules didn't recognize (afGuessConcept returned null).
async function afCallGeminiForClassification(fields, settings) {
  if (!settings.geminiApiKey || fields.length === 0) return [];

  const prompt = [
    "Given a list of web form fields (without values). For each field, suggest a short machine-readable",
    "key in English camelCase (e.g. customerNotes, taxId) and a human-readable label in English.",
    "Respond strictly as a JSON array of objects { afId, key, label }, without explanations.",
    "",
    JSON.stringify(fields.map((f) => ({
      afId: f.afId,
      type: f.type,
      name: f.name,
      id: f.id,
      placeholder: f.placeholder,
      label: f.label,
      ariaLabel: f.ariaLabel,
    }))),
  ].join("\n");

  const url = `${AF_GEMINI_ENDPOINT}/${settings.geminiModel}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "[]";
  const parsed = afParseGeminiJson(text);
  return Array.isArray(parsed) ? parsed : [];
}

// Generate a short answer to a "complex" job application question with grounding sources.
// Returns { answer: string, sources: [{ source: "resume"|"context", quote: string }] }
function afBuildEssayPrompt(question, contextText, resumeContent) {
  return [
    "You help the user answer a job application question. The question is in English.",
    "",
    "Question from the form:",
    question,
    "",
    "Context about the user and their experience (may be in Russian — use facts/style, do not invent):",
    contextText || "(not provided)",
    "",
    "User's resume:",
    resumeContent || "(not provided)",
    "",
    "Write a short natural answer in English (2-5 sentences), first person,",
    "conversational professional tone. Match the user's style from context.",
    "Do NOT invent facts not present in the context or resume.",
    "",
    "Respond STRICTLY as JSON (no markdown) with this shape:",
    '{ "answer": "<answer text only>", "sources": [ { "source": "resume"|"context", "quote": "<short verbatim snippet you relied on>" } ] }',
    "Include 1-4 sources. Quotes must be short (≤180 chars) and copied from the provided resume/context.",
    "If a source section was empty, omit sources from that section.",
  ].join("\n");
}

function afNormalizeEssayResult(parsed, fallbackText) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const answer = String(parsed.answer || parsed.text || "").trim();
    let sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    sources = sources
      .map((s) => ({
        source: s && (s.source === "resume" || s.source === "context") ? s.source : "context",
        quote: String((s && (s.quote || s.excerpt || s.text)) || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
      }))
      .filter((s) => s.quote.length > 0)
      .slice(0, 6);
    if (answer) return { answer, sources };
  }
  const text = typeof parsed === "string" ? parsed : fallbackText || "";
  return { answer: String(text).trim(), sources: [] };
}

async function afCallGeminiForEssayAnswer(question, contextText, resumeContent, settings) {
  if (!settings.geminiApiKey) throw new Error("Gemini API key not set");

  const prompt = afBuildEssayPrompt(question, contextText, resumeContent);
  const url = `${AF_GEMINI_ENDPOINT}/${settings.geminiModel}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const parsed = afParseGeminiJson(text);
  // afParseGeminiJson expects arrays for matching; also accept object for essay
  let obj = parsed;
  if (!obj) {
    try {
      obj = JSON.parse(String(text).replace(/```json|```/g, "").trim());
    } catch (_) {
      obj = null;
    }
  }
  return afNormalizeEssayResult(obj, text);
}

if (typeof self !== "undefined") {
  self.afCallGeminiForMatching = afCallGeminiForMatching;
  self.afCallGeminiForClassification = afCallGeminiForClassification;
  self.afCallGeminiForEssayAnswer = afCallGeminiForEssayAnswer;
  self.afGeminiMatchCacheClear = afGeminiMatchCacheClear;
}
