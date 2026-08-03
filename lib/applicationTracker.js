// Job application tracker helpers (content-script + options).
// Detects form submits / thank-you pages and extracts job meta + Q&A from the page.

/**
 * Scrape job title / company / description heuristics from the current document.
 */
function afScrapeJobMeta(doc) {
  const d = doc || document;
  const pickText = (el) => (el && el.textContent ? String(el.textContent).replace(/\s+/g, " ").trim() : "");

  let title =
    pickText(d.querySelector("h1")) ||
    pickText(d.querySelector('[data-testid*="job-title" i], [class*="job-title" i], [class*="jobTitle" i]')) ||
    pickText(d.querySelector(".posting-headline h2, .app-title, .job-header h1")) ||
    "";

  if (!title && d.title) {
    title = String(d.title).split(/[|\-–—]/)[0].trim();
  }

  let company =
    pickText(d.querySelector('[data-testid*="company" i], [class*="company-name" i], .company-name, .employer-name')) ||
    "";

  // Prefer og:description / meta description / first long paragraph in main
  let description = "";
  const og = d.querySelector('meta[property="og:description"]');
  const md = d.querySelector('meta[name="description"]');
  if (og && og.getAttribute("content")) description = og.getAttribute("content").trim();
  else if (md && md.getAttribute("content")) description = md.getAttribute("content").trim();

  if (!description) {
    const main = d.querySelector("main, [role='main'], .job-description, #content, .posting-page") || d.body;
    if (main) {
      const paras = Array.from(main.querySelectorAll("p"))
        .map(pickText)
        .filter((t) => t.length > 80);
      if (paras[0]) description = paras[0].slice(0, 600);
    }
  }
  if (description.length > 800) description = description.slice(0, 800) + "…";

  return { title, company, description, url: (d.defaultView || window).location.href };
}

/**
 * Collect visible Q&A pairs: labels + filled values (text/textarea/select).
 */
function afScrapeApplicationAnswers(doc) {
  const d = doc || document;
  const answers = [];
  const seen = new Set();

  const controls = d.querySelectorAll("input, textarea, select");
  controls.forEach((el) => {
    if (!el || el.disabled) return;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "password", "submit", "button", "reset", "file", "checkbox", "radio", "image"].includes(type)) {
      return;
    }
    const value = (el.value || "").trim();
    if (!value || value.length > 4000) return;

    let q = "";
    if (typeof afFindLabelText === "function") {
      q = afFindLabelText(el) || "";
    }
    if (!q) {
      q = el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "";
    }
    q = String(q).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!q || q.length < 2) return;

    const key = `${q}\u0000${value.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    answers.push({ q, a: value.slice(0, 2000) });
  });

  return answers.slice(0, 40);
}

function afLooksLikeApplicationSuccess(doc) {
  const d = doc || document;
  const text = (d.body && d.body.innerText ? d.body.innerText : "").toLowerCase().slice(0, 8000);
  const patterns = [
    /thank you for (your )?appl/i,
    /application (has been )?submitted/i,
    /successfully applied/i,
    /we('ve| have) received your (application|resume|cv)/i,
    /application received/i,
    /your application is on its way/i,
  ];
  return patterns.some((re) => re.test(text));
}

function afLooksLikeApplicationForm(form) {
  if (!form) return false;
  const html = (form.innerText || "").toLowerCase().slice(0, 4000);
  const hasFile = !!form.querySelector('input[type="file"], .formio-component-file, .fileSelector, [ref="fileDrop"]');
  const hasContact =
    /email|phone|resume|cv|first name|last name|cover letter|apply/i.test(html) ||
    !!form.querySelector('input[type="email"], input[name*="email" i], input[name*="resume" i]');
  return hasFile || hasContact;
}

/**
 * Install submit + success-page hooks (top frame). Sends AF_APPLICATION_TRACKED to background.
 */
function afInstallApplicationTracker() {
  if (typeof window === "undefined" || window !== window.top) return;
  if (self.__AF_APP_TRACKER__) return;
  self.__AF_APP_TRACKER__ = true;

  const report = (source) => {
    try {
      const meta = afScrapeJobMeta(document);
      const answers = afScrapeApplicationAnswers(document);
      chrome.runtime
        .sendMessage({
          type: "AF_APPLICATION_TRACKED",
          application: {
            url: meta.url,
            title: meta.title,
            company: meta.company,
            description: meta.description,
            answers,
            source,
          },
        })
        .catch(() => {});
    } catch (e) {
      console.warn("AF application track failed", e);
    }
  };

  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!afLooksLikeApplicationForm(form)) return;
      // Capture after a short delay so last field values are committed
      setTimeout(() => report("form-submit"), 400);
    },
    true
  );

  // Buttons that submit without native form submit
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest("button, input[type=submit], a");
      if (!btn) return;
      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`.toLowerCase();
      if (!/\b(submit|apply|send application|send resume)\b/i.test(label)) return;
      const form = btn.closest("form") || document.querySelector("form");
      if (form && !afLooksLikeApplicationForm(form) && !/\bapply\b/i.test(label)) return;
      setTimeout(() => report("apply-click"), 600);
    },
    true
  );

  // Thank-you / success pages (SPA or full navigation)
  const checkSuccess = () => {
    if (afLooksLikeApplicationSuccess(document)) {
      report("success-page");
    }
  };
  setTimeout(checkSuccess, 1200);
  // Re-check after SPA history changes (patched watcher may call scan; we hook once more)
  window.addEventListener("popstate", () => setTimeout(checkSuccess, 800));
}

if (typeof self !== "undefined") {
  self.afScrapeJobMeta = afScrapeJobMeta;
  self.afScrapeApplicationAnswers = afScrapeApplicationAnswers;
  self.afLooksLikeApplicationSuccess = afLooksLikeApplicationSuccess;
  self.afInstallApplicationTracker = afInstallApplicationTracker;
  self.afAddApplication = self.afAddApplication; // may be undefined in content (storage not loaded)
}
