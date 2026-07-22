// Rules for matching page fields against the library without calling Gemini.
// Used as the first (fast and free) step before falling back to Gemini API.

function afMatchFieldsToLibrary(fields, library) {
  const mapping = {}; // afId -> value
  const matchedConcepts = []; // for debug/UI: which library concepts were used
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
