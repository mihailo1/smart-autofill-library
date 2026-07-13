// Правила сопоставления полей страницы с библиотекой без обращения к Gemini.
// Используется как первый (быстрый и бесплатный) шаг перед fallback на Gemini API.

function afMatchFieldsToLibrary(fields, library) {
  const mapping = {}; // afId -> value
  const matchedConcepts = []; // для отладки/UI: какие концепты library были использованы
  const unmatched = [];

  for (const field of fields) {
    const entry = field.guessedConcept ? library.entries[field.guessedConcept] : null;
    if (entry && field.guessedConfidence >= 0.6 && entry.value) {
      mapping[field.afId] = entry.value;
      matchedConcepts.push({ afId: field.afId, key: field.guessedConcept, via: "rules" });
    } else {
      unmatched.push(field);
    }
  }

  return { mapping, matchedConcepts, unmatched };
}

if (typeof self !== "undefined") {
  self.afMatchFieldsToLibrary = afMatchFieldsToLibrary;
}
