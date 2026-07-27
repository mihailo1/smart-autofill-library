// Gemini API client. Called from popup (no separate background service worker in this
// extension — see manifest.json). API key is stored in chrome.storage.local.
//
// Important: ONLY field metadata (name/id/label/placeholder/type) and library entry
// keys + labels (without values!) are sent to Gemini. The actual saved values
// (email, phone, etc.) never leave the device — they are substituted locally after
// Gemini returns which library key corresponds to which field.

const AF_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

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
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
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
  return Array.isArray(parsed) ? parsed : [];
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

// Generate a short answer to a "complex" job application question (e.g.
// "Why do you want to work here?"), based on the user's text context
// (how they describe their experience) and the selected resume text, preserving writing style.
function afBuildEssayPrompt(question, contextText, resumeContent) {
  return [
    "You help the user answer a job application question. The question is in English.",
    "",
    "Question from the form:",
    question,
    "",
    "Context about the user and their experience (the user may have written this in Russian — focus on facts and writing style, but do NOT translate literally):",
    contextText || "(not provided)",
    "",
    "User's resume:",
    resumeContent || "(not provided)",
    "",
    "Write a short natural answer in English (2-5 sentences), first person,",
    "in a conversational professional tone. Try to match the tone and manner from the context above",
    "(e.g., if the user writes simply and directly — don't use pompous cliches).",
    "Don't invent facts not present in the context or resume.",
    "Respond with only the answer text, no introductions, explanations, or quotes.",
  ].join("\n");
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
      generationConfig: { temperature: 0.7 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return text.trim();
}

if (typeof self !== "undefined") {
  self.afCallGeminiForMatching = afCallGeminiForMatching;
  self.afCallGeminiForClassification = afCallGeminiForClassification;
  self.afCallGeminiForEssayAnswer = afCallGeminiForEssayAnswer;
}
