// Content script: единственная точка контакта с DOM страницы. Отвечает только на
// сообщения от popup — сам не хранит состояние и не обращается к сети/Gemini.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AF_SCAN_FIELDS") {
    const { fields, resumeUploadFields } = afCollectFields();
    sendResponse({ fields, resumeUploadFields, url: window.location.href });
    return true;
  }

  if (message.type === "AF_APPLY_VALUES") {
    const filledCount = afApplyValues(message.mapping || {});
    sendResponse({ filledCount });
    return true;
  }

  if (message.type === "AF_PLACE_FILE") {
    const { afId, base64, fileName, mimeType } = message;
    const ok = afPlaceFile(afId, base64, fileName, mimeType);
    sendResponse({ ok });
    return true;
  }

  return false;
});
