// Общий словарь "концептов" полей — используется в content-script (для угадывания концепта
// поля на странице по правилам) и в popup (для сопоставления с библиотекой и подписи полей).
// Работает как обычный script (не ES module), поэтому просто объявляет глобальные функции/объекты.

const AF_CONCEPTS = [
  { key: "email", label: "Email", autocomplete: ["email"], keywords: ["email", "e-mail", "почта", "mail"] },
  { key: "firstName", label: "Имя", autocomplete: ["given-name"], keywords: ["firstname", "first_name", "fname", "имя", "givenname"] },
  { key: "lastName", label: "Фамилия", autocomplete: ["family-name"], keywords: ["lastname", "last_name", "lname", "surname", "фамилия", "familyname"] },
  { key: "middleName", label: "Отчество", autocomplete: ["additional-name"], keywords: ["middlename", "middle_name", "отчество", "patronymic"] },
  { key: "fullName", label: "Полное имя", autocomplete: ["name"], keywords: ["fullname", "full_name", "yourname", "полноеимя", "фио", "name"] },
  { key: "phone", label: "Телефон", autocomplete: ["tel"], keywords: ["phone", "tel", "mobile", "телефон", "cell"] },
  { key: "company", label: "Компания", autocomplete: ["organization"], keywords: ["company", "organization", "org", "компания", "организация"] },
  { key: "jobTitle", label: "Должность", autocomplete: ["organization-title"], keywords: ["jobtitle", "position", "должность", "title"] },
  { key: "website", label: "Веб-сайт", autocomplete: ["url"], keywords: ["website", "url", "сайт", "homepage"] },
  { key: "username", label: "Имя пользователя", autocomplete: ["username"], keywords: ["username", "login", "user_name", "логин", "никнейм", "nickname"] },
  { key: "addressLine1", label: "Адрес (строка 1)", autocomplete: ["address-line1"], keywords: ["address1", "address_line1", "street", "адрес", "улица"] },
  { key: "addressLine2", label: "Адрес (строка 2)", autocomplete: ["address-line2"], keywords: ["address2", "address_line2", "apt", "suite", "квартира"] },
  { key: "city", label: "Город", autocomplete: ["address-level2"], keywords: ["city", "town", "город"] },
  { key: "state", label: "Регион/область", autocomplete: ["address-level1"], keywords: ["state", "region", "province", "область", "регион"] },
  { key: "zip", label: "Почтовый индекс", autocomplete: ["postal-code"], keywords: ["zip", "postal", "postcode", "индекс"] },
  { key: "country", label: "Страна", autocomplete: ["country", "country-name"], keywords: ["country", "страна"] },
  { key: "birthDate", label: "Дата рождения", autocomplete: ["bday"], keywords: ["birthdate", "birthday", "dob", "дата_рождения", "днюродения"] },
  { key: "gender", label: "Пол", autocomplete: ["sex"], keywords: ["gender", "sex", "пол"] },
];

// Ищем совпадение по attribute autocomplete в первую очередь, затем по ключевым словам
// в name/id/placeholder/label. Возвращает { key, confidence } или null.
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

// Экспортируем в глобальную область (для content-script) и, если модульная среда есть,
// оставляем доступным также через self/globalThis для background service worker.
if (typeof self !== "undefined") {
  self.AF_CONCEPTS = AF_CONCEPTS;
  self.afGuessConcept = afGuessConcept;
  self.afConceptLabel = afConceptLabel;
}
