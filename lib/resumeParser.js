// Обёртка над вендоренными pdf.js и mammoth.js для извлечения текста из загруженных
// резюме (PDF / DOCX). Используется в options.js в контексте страницы настроек (не в
// service worker), поэтому может свободно использовать window/document.

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

// Возвращает { text, warning } — warning заполняется, если формат не поддержан или
// извлечение текста не удалось (файл всё равно сохраняется, просто без текста для Gemini).
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
      return { text: "", warning: "Старый формат .doc не поддерживается для извлечения текста — используйте .docx или .pdf. Файл сохранён, но не будет учтён при генерации ответов." };
    }
    return { text: "", warning: "Неизвестный формат файла — текст не извлечён." };
  } catch (e) {
    console.warn("Resume text extraction failed", e);
    return { text: "", warning: `Не удалось извлечь текст из файла (${e.message}). Файл сохранён, но не будет учтён при генерации ответов.` };
  }
}

if (typeof window !== "undefined") {
  window.afExtractResumeText = afExtractResumeText;
}
