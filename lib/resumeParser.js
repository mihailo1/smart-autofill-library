// Wrapper around vendored pdf.js and mammoth.js for extracting text from uploaded
// resumes (PDF / DOCX). Used in options.js in the settings page context (not in
// service worker), so it can freely use window/document.

function afInitPdfWorker() {
  if (typeof pdfjsLib === "undefined") return;
  if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/vendor/pdf.worker.min.js");
}

async function afExtractTextFromPdf(arrayBuffer) {
  afInitPdfWorker();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    pageTexts.push(pageText);
  }
  return pageTexts.join("\n\n").trim();
}

async function afExtractTextFromDocx(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer });
  return (result.value || "").trim();
}

// Returns { text, warning } — warning is populated if the format is unsupported or
// text extraction fails (the file is still saved, just without text for Gemini).
async function afExtractResumeText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const lowerName = (file.name || "").toLowerCase();

  try {
    if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
      return { text: await afExtractTextFromPdf(arrayBuffer) };
    }
    if (
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lowerName.endsWith(".docx")
    ) {
      return { text: await afExtractTextFromDocx(arrayBuffer) };
    }
    if (lowerName.endsWith(".doc")) {
      return { text: "", warning: "Old .doc format not supported for text extraction — use .docx or .pdf. File saved but won't be used for answer generation." };
    }
    return { text: "", warning: "Unknown file format — text not extracted." };
  } catch (e) {
    console.warn("Resume text extraction failed", e);
    return { text: "", warning: `Failed to extract text from file (${e.message}). File saved but won't be used for answer generation.` };
  }
}

if (typeof window !== "undefined") {
  window.afExtractResumeText = afExtractResumeText;
}
