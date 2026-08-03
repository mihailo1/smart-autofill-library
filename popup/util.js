// AF.popup.util — classic-script module (no bundler).
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function escapeAttr(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

  AF.popup.util = { setStatus, escapeAttr, escapeHtml };
  global.setStatus = setStatus;
  global.escapeAttr = escapeAttr;
  global.escapeHtml = escapeHtml;
})(typeof self !== "undefined" ? self : window);
