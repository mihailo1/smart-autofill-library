// Field DOM actions: apply values and place files (depends on fieldDetection.js globals).
// Loaded after fieldDetection.js in content_scripts / any host that needs place/apply.

function afApplyValues(mapping) {
  let filledCount = 0;
  Object.entries(mapping).forEach(([afId, value]) => {
    if (value === undefined || value === null || value === "") return;
    const el = document.querySelector(`[${AF_FIELD_ATTR}="${CSS.escape(afId)}"]`);
    if (!el) return;

    if (el.tagName.toLowerCase() === "select") {
      const option = Array.from(el.options).find(
        (opt) => opt.value === value || opt.textContent.trim() === value
      );
      if (option) {
        el.value = option.value;
      } else {
        return;
      }
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filledCount += 1;
  });
  return filledCount;
}

// Reconstructs a File from base64 and places it into input[type=file] via DataTransfer —
// the only reliable way to programmatically "upload" a file to a file input in the browser.
function afBase64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i += 1) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

function afMakeFileFromBase64(base64, fileName, mimeType) {
  const blob = afBase64ToBlob(base64, mimeType);
  return new File([blob], fileName, { type: mimeType || blob.type || "application/octet-stream" });
}

function afAssignFilesToInput(inputEl, file) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  inputEl.files = dataTransfer.files;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Form.io listens for drop on [ref=fileDrop] / .fileSelector with dataTransfer.files.
 * Synthetic DragEvent often strips dataTransfer — defineProperty works in Chromium.
 */
function afDispatchDropWithFile(targetEl, file) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  const tryDispatch = (type) => {
    let evt;
    try {
      evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
    } catch (_) {
      evt = new Event(type, { bubbles: true, cancelable: true });
    }
    try {
      Object.defineProperty(evt, "dataTransfer", {
        get: () => dataTransfer,
        configurable: true,
      });
    } catch (_) {
      /* some engines make dataTransfer read-only after construct */
    }
    targetEl.dispatchEvent(evt);
  };

  ["dragenter", "dragover", "drop"].forEach(tryDispatch);
}

/**
 * Place a file onto a classic file input OR a Form.io-style dropzone (no input in DOM).
 */
function afPlaceFile(afId, base64, fileName, mimeType) {
  const el = document.querySelector(`[${AF_FIELD_ATTR}="${CSS.escape(afId)}"]`);
  if (!el) return false;

  const file = afMakeFileFromBase64(base64, fileName, mimeType);

  // Classic path
  if (el.tagName.toLowerCase() === "input" && el.type === "file") {
    afAssignFilesToInput(el, file);
    return true;
  }

  // Dropzone path (Form.io / Sourceflow / similar)
  const dropTarget =
    el.matches?.('[ref="fileDrop"], .fileSelector')
      ? el
      : el.querySelector?.('[ref="fileDrop"], .fileSelector, [class*="fileSelector"]') || el;

  // Prefer an existing nested file input if Form.io created one
  let input =
    el.querySelector?.('input[type="file"]') ||
    dropTarget.querySelector?.('input[type="file"]') ||
    null;

  if (!input) {
    // Inject a hidden file input Form.io-style components often still listen to via change bubbling
    input = document.createElement("input");
    input.type = "file";
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px;";
    input.setAttribute("data-af-injected", "1");
    (dropTarget || el).appendChild(input);
  }

  afAssignFilesToInput(input, file);
  afDispatchDropWithFile(dropTarget, file);

  // Also fire drop on component root (some handlers bind there)
  if (dropTarget !== el) afDispatchDropWithFile(el, file);

  return true;
}

if (typeof self !== "undefined") {
  self.afApplyValues = afApplyValues;
  self.afPlaceFile = afPlaceFile;
  self.afBase64ToBlob = afBase64ToBlob;
  self.afMakeFileFromBase64 = afMakeFileFromBase64;
}
