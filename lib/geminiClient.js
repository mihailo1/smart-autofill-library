// Клиент для Gemini API. Вызывается из popup (отдельного background service worker в этом
// расширении нет — см. manifest.json). API-ключ хранится в chrome.storage.local.
//
// Важно: в Gemini отправляются ТОЛЬКО метаданные полей (name/id/label/placeholder/type)
// и ключи+подписи (без значений!) записей библиотеки. Реальные сохранённые значения
// (email, телефон и т.д.) наружу не уходят — они подставляются локально после того,
// как Gemini вернёт, какой ключ библиотеки соответствует какому полю.

const AF_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function afBuildMatchPrompt(fields, libraryConceptsBrief) {
  return [
    "Ты помогаешь сопоставить поля веб-формы с элементами личной библиотеки данных пользователя.",
    "Дан список полей формы (без значений) и список доступных ключей библиотеки (key + label, тоже без значений).",
    "Для каждого поля, для которого ты уверен в соответствии, верни объект { afId, libraryKey }.",
    "Если для поля нет подходящего ключа — просто не включай его в ответ.",
    "Отвечай СТРОГО в формате JSON-массива, без пояснений и markdown.",
    "",
    "Поля формы:",
    JSON.stringify(fields.map((f) => ({
      afId: f.afId,
      type: f.type,
      name: f.name,
      id: f.id,
      autocomplete: f.autocomplete,
      placeholder: f.placeholder,
      label: f.label,
      ariaLabel: f.ariaLabel,
    }))),
    "",
    "Доступные ключи библиотеки:",
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

// Классификация полей при сохранении: помогает подобрать понятный ключ/подпись для полей,
// которые не распознали правила (afGuessConcept вернул null).
async function afCallGeminiForClassification(fields, settings) {
  if (!settings.geminiApiKey || fields.length === 0) return [];

  const prompt = [
    "Дан список полей веб-формы (без значений). Для каждого поля предложи короткий machine-readable",
    "ключ на английском в camelCase (например customerNotes, taxId) и человекочитаемую подпись на русском.",
    "Отвечай строго JSON-массивом объектов { afId, key, label }, без пояснений.",
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

// Генерация короткого ответа на "сложный" вопрос анкеты вакансии (например
// "Why do you want to work here?"), с опорой на текстовый контекст пользователя
// (как он сам описывает свой опыт) и текст выбранного резюме, сохраняя стиль письма.
function afBuildEssayPrompt(question, contextText, resumeContent) {
  return [
    "Ты помогаешь пользователю отвечать на вопрос из анкеты о трудоустройстве. Вопрос задан на английском.",
    "",
    "Вопрос из формы:",
    question,
    "",
    "Контекст о пользователе и его опыте (пользователь мог написать это на русском — ориентируйся на факты и стиль изложения, но НЕ переводи дословно):",
    contextText || "(не указано)",
    "",
    "Резюме пользователя:",
    resumeContent || "(не указано)",
    "",
    "Напиши короткий естественный ответ на английском языке (2-5 предложений), от первого лица,",
    "в разговорном деловом стиле. Старайся передать тот же тон и манеру речи, что и в контексте выше",
    "(например, если пользователь пишет просто и по делу — не используй пафосные штампы).",
    "Не выдумывай факты, которых нет в контексте или резюме.",
    "Ответь только текстом самого ответа, без вступлений, пояснений и кавычек.",
  ].join("\n");
}

async function afCallGeminiForEssayAnswer(question, contextText, resumeContent, settings) {
  if (!settings.geminiApiKey) throw new Error("Не указан API-ключ Gemini");

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
