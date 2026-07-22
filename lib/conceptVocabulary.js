// Shared dictionary of field "concepts" — used in content-script (for guessing field concepts
// on the page via rules) and in popup (for matching against library and field labeling).
// Works as a regular script (not ES module), so it just declares global functions/objects.

const AF_CONCEPTS = [
  { key: "email", label: "Email", autocomplete: ["email"], keywords: ["email", "e-mail", "почта", "mail"] },
  { key: "firstName", label: "First name", autocomplete: ["given-name"], keywords: ["firstname", "first_name", "fname", "имя", "givenname"] },
  { key: "lastName", label: "Last name", autocomplete: ["family-name"], keywords: ["lastname", "last_name", "lname", "surname", "фамилия", "familyname"] },
  { key: "middleName", label: "Middle name", autocomplete: ["additional-name"], keywords: ["middlename", "middle_name", "отчество", "patronymic"] },
  { key: "fullName", label: "Full name", autocomplete: ["name"], keywords: ["fullname", "full_name", "yourname", "полноеимя", "фио", "name"] },
  { key: "phone", label: "Phone", autocomplete: ["tel"], keywords: ["phone", "tel", "mobile", "телефон", "cell"] },
  { key: "company", label: "Company", autocomplete: ["organization"], keywords: ["company", "organization", "org", "компания", "организация"] },
  { key: "jobTitle", label: "Job title", autocomplete: ["organization-title"], keywords: ["jobtitle", "position", "должность", "title"] },
  { key: "website", label: "Website", autocomplete: ["url"], keywords: ["website", "url", "сайт", "homepage"] },
  { key: "username", label: "Username", autocomplete: ["username"], keywords: ["username", "login", "user_name", "логин", "никнейм", "nickname"] },
  { key: "addressLine1", label: "Address line 1", autocomplete: ["address-line1"], keywords: ["address1", "address_line1", "street", "адрес", "улица"] },
  { key: "addressLine2", label: "Address line 2", autocomplete: ["address-line2"], keywords: ["address2", "address_line2", "apt", "suite", "квартира"] },
  { key: "city", label: "City", autocomplete: ["address-level2"], keywords: ["city", "town", "город"] },
  { key: "state", label: "State / Region", autocomplete: ["address-level1"], keywords: ["state", "region", "province", "область", "регион"] },
  { key: "zip", label: "ZIP / Postal code", autocomplete: ["postal-code"], keywords: ["zip", "postal", "postcode", "индекс"] },
  { key: "country", label: "Country", autocomplete: ["country", "country-name"], keywords: ["country", "страна"] },
  { key: "birthDate", label: "Date of birth", autocomplete: ["bday"], keywords: ["birthdate", "birthday", "dob", "дата_рождения", "днюродения"] },
  { key: "gender", label: "Gender", autocomplete: ["sex"], keywords: ["gender", "sex", "пол"] },
];

// Match by autocomplete attribute first, then by keywords in name/id/placeholder/label.
// Returns { key, confidence } or null.
function afGuessConcept(fieldMeta) {
  const autocomplete = (fieldMeta.autocomplete || "").toLowerCase().trim();
  if (autocomplete) {
    const lastToken = autocomplete.split(" ").pop();
    const byAutocomplete = AF_CONCEPTS.find((c) => c.autocomplete.includes(lastToken));
    if (byAutocomplete) return { key: byAutocomplete.key, confidence: 0.95 };
  }

  const haystack = [fieldMeta.name, fieldMeta.id, fieldMeta.placeholder, fieldMeta.label, fieldMeta.ariaLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "");

  if (!haystack) return null;

  let best = null;
  for (const concept of AF_CONCEPTS) {
    for (const kw of concept.keywords) {
      const normalizedKw = kw.replace(/[^a-zа-яё0-9]+/gi, "");
      if (normalizedKw && haystack.includes(normalizedKw)) {
        const confidence = normalizedKw.length / haystack.length > 0.4 ? 0.85 : 0.7;
        if (!best || confidence > best.confidence) best = { key: concept.key, confidence };
      }
    }
  }
  return best;
}

function afConceptLabel(key) {
  const found = AF_CONCEPTS.find((c) => c.key === key);
  return found ? found.label : key;
}

// Export to global scope (for content-script) and, if module environment exists,
// also via self/globalThis for background service worker.
if (typeof self !== "undefined") {
  self.AF_CONCEPTS = AF_CONCEPTS;
  self.afGuessConcept = afGuessConcept;
  self.afConceptLabel = afConceptLabel;
}
