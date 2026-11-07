import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  isDefaultSettings,
  buildDocxTrigrams,
  finalizeMatches,
  summarize,
  similarityLevel,
  exclusionSummary,
} from "./matching.js";
import {
  buildExcerpt,
  formatPagesList,
  groupWordIds,
  pagesForWordOffsets,
} from "./passages.js";
import { serializeExportCsv, serializeExportJson } from "./export.js";
import { docxToHtml, buildManuscript } from "./manuscript.js";
import { collectEntries, fromFileList, sortIncoming, splitPath } from "./intake.js";
import { clearOcrCache } from "./ocr-cache.js";

// Highlighter inks: light enough to read dark text through, distinct side by side
const INKS = [
  "#ffe14d", "#8fe3a6", "#93ccff", "#ffadc9", "#ffb870", "#c9adff",
  "#6fded2", "#dbe86a", "#ff9f8f", "#a9b9ff", "#f2bdf7", "#b5dd9a",
  "#ffd09e", "#9adbf2", "#e9c08f", "#d7f27e",
];

/** Colour for the n-th source; beyond the curated set, step round the hue wheel. */
function inkFor(n) {
  if (n < INKS.length) return INKS[n];
  const hue = Math.round((n * 137.508) % 360);
  return `hsl(${hue} 85% 76%)`;
}

const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat();

const el = {
  trays: $("trays"),
  docxInput: $("docx-input"),
  docxDrop: $("docx-drop"),
  docxCard: $("docx-card"),
  docxName: $("docx-name"),
  docxWords: $("docx-words"),
  docxRemove: $("docx-remove"),
  pdfInput: $("pdf-input"),
  folderInput: $("folder-input"),
  pdfDrop: $("pdf-drop"),
  pdfLedger: $("pdf-ledger"),
  pdfFoot: $("pdf-foot"),
  pdfTotal: $("pdf-total"),
  pdfClear: $("pdf-clear"),
  compare: $("compare"),
  compareLabel: $("compare-label"),
  intakeStatus: $("intake-status"),
  intake: $("intake"),
  working: $("working"),
  workingTitle: $("working-title"),
  workingFill: $("working-fill"),
  workLedger: $("work-ledger"),
  ocrAsk: $("ocr-ask"),
  ocrAskTitle: $("ocr-ask-title"),
  ocrAskDetail: $("ocr-ask-detail"),
  ocrRun: $("ocr-run"),
  ocrSkip: $("ocr-skip"),
  forgetOcr: $("forget-ocr"),
  tickModerate: $("tick-moderate"),
  tickHigh: $("tick-high"),
  settingsNote: $("settings-note"),
  tuning: $("tuning"),
  tuningState: $("tuning-state"),
  tuningOpen: $("tuning-open"),
  tuningOpenState: $("tuning-open-state"),
  tuningIntakeMount: $("tuning-intake-mount"),
  tuningReportMount: $("tuning-report-mount"),
  tuningControls: $("tuning-controls"),
  tuningCompare: $("tuning-compare"),
  tuningStatus: $("tuning-status"),
  tuningReset: $("tuning-reset"),
  intakeSettings: $("intake-settings"),
  intakeReset: $("intake-reset"),
  report: $("report"),
  scoreValue: $("score-value"),
  verdict: $("verdict"),
  flagged: $("flagged"),
  spectrum: $("spectrum"),
  toggleAll: $("toggle-all"),
  sourceList: $("source-list"),
  quietSources: $("quiet-sources"),
  quietList: $("quiet-list"),
  print: $("print"),
  exportCsv: $("export-csv"),
  exportJson: $("export-json"),
  restart: $("restart"),
  pageTitle: $("page-title"),
  pageMeta: $("page-meta"),
  manuscript: $("manuscript"),
  tooltip: $("tooltip"),
};

const state = {
  docx: null, // { file, html, wordCount }
  pdfs: new Map(), // key -> { file, path } (path includes folders when picked from one)
  showAllPdfs: false,
  settings: null, // matching settings, loaded at start-up (see Tuning)
  base: null, // what the last comparison read, kept so settings changes can re-match
  report: null,
};

// How many source names the intake list shows before "+ N more"
const LEDGER_PREVIEW = 10;

if (location.protocol === "file:") $("protocol-warning").hidden = false;

/* ---------- Intake ---------- */

// The same file reached twice (loose and inside a folder) is added once
const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;
const plural = (n, word) => `${numberFormat.format(n)} ${word}${n === 1 ? "" : "s"}`;

/** Renders "Literature/2023/smith.pdf" with the folder part de-emphasised. */
function pathLabel(path) {
  const { dir, base } = splitPath(path);
  const fragment = document.createDocumentFragment();
  if (dir) {
    const folder = document.createElement("span");
    folder.className = "path-dir";
    folder.textContent = dir;
    fragment.append(folder);
  }
  fragment.append(base);
  return fragment;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(message, isError = false) {
  el.intakeStatus.textContent = message;
  el.intakeStatus.classList.toggle("error", isError);
}

/**
 * Sends picked or dropped files to the right tray: a loose .docx becomes the
 * manuscript, and every PDF (loose or anywhere inside a folder) a source.
 * @param {import("./intake.js").Incoming[]} items
 */
async function acceptFiles(items) {
  const sorted = sortIncoming(items);
  const added = addPdfs(sorted.pdfs);
  const duplicates = sorted.pdfs.length - added;

  const notes = [];
  let isError = false;
  if (sorted.folders) {
    if (sorted.pdfsFromFolders === 0) {
      notes.push(`No PDFs found in ${sorted.folders === 1 ? "that folder" : "those folders"} or below.`);
      isError = true;
    } else {
      const where = sorted.folders === 1
        ? "the folder and its subfolders"
        : `${plural(sorted.folders, "folder")} and their subfolders`;
      notes.push(`Found ${plural(sorted.pdfsFromFolders, "PDF")} in ${where}.`);
    }
  }
  if (duplicates) notes.push(`${plural(duplicates, "file")} already in the list.`);
  if (sorted.extraManuscripts) {
    notes.push("Only one manuscript is used at a time, so the last .docx was kept.");
  }
  if (sorted.skipped) {
    notes.push(
      `Skipped ${plural(sorted.skipped, "non-PDF file")}` +
        (sorted.folders ? " (a manuscript .docx has to be added on its own, not inside a folder)." : ".")
    );
  }

  // A manuscript that fails to read keeps its own error message on screen
  const manuscriptOk = sorted.manuscript ? await setDocx(sorted.manuscript.file) : true;
  if (manuscriptOk) setStatus(notes.join(" "), isError);
}

/** Reads the manuscript; returns whether it could be read. */
async function setDocx(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const html = await docxToHtml(file);
    const { words } = buildManuscript(html);
    state.docx = { file, html, wordCount: words.length };
    setStatus("");
    return true;
  } catch (error) {
    state.docx = null;
    setStatus(`Couldn't read ${file.name}. Is it a Word .docx file?`, true);
    console.error(error);
    return false;
  } finally {
    renderIntake();
  }
}

/** Adds sources, skipping files already listed. Returns how many were new. */
function addPdfs(items) {
  let added = 0;
  for (const { file, path } of items) {
    const key = fileKey(file);
    if (state.pdfs.has(key)) continue;
    state.pdfs.set(key, { file, path });
    added++;
  }
  renderIntake();
  return added;
}

function renderIntake() {
  const { docx, pdfs } = state;

  el.docxDrop.hidden = Boolean(docx);
  el.docxCard.hidden = !docx;
  if (docx) {
    el.docxName.textContent = docx.file.name;
    el.docxWords.textContent = `${numberFormat.format(docx.wordCount)} words · ${formatSize(docx.file.size)}`;
  }

  // Long lists (whole folders) show the first few names until expanded
  const all = Array.from(pdfs);
  const shown = state.showAllPdfs ? all : all.slice(0, LEDGER_PREVIEW);
  const hiddenCount = all.length - shown.length;

  el.pdfLedger.replaceChildren(
    ...shown.map(([key, { file, path }], i) => {
      const li = document.createElement("li");
      const num = document.createElement("span");
      num.className = "ledger-num";
      num.textContent = String(i + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "ledger-name";
      name.append(pathLabel(path));
      name.title = path;
      const size = document.createElement("span");
      size.className = "ledger-size";
      size.textContent = formatSize(file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${path}`);
      remove.addEventListener("click", () => {
        pdfs.delete(key);
        renderIntake();
      });
      li.append(num, name, size, remove);
      return li;
    })
  );

  if (all.length > LEDGER_PREVIEW) {
    const li = document.createElement("li");
    li.className = "ledger-more";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "text-btn";
    toggle.textContent = hiddenCount
      ? `+ ${numberFormat.format(hiddenCount)} more · show all`
      : "Show only the first 10";
    toggle.setAttribute("aria-expanded", String(!hiddenCount));
    toggle.addEventListener("click", () => {
      state.showAllPdfs = !state.showAllPdfs;
      renderIntake();
    });
    li.append(toggle);
    el.pdfLedger.append(li);
  }

  const totalBytes = Array.from(pdfs.values()).reduce((sum, { file }) => sum + file.size, 0);
  el.pdfFoot.hidden = pdfs.size === 0;
  el.pdfTotal.textContent = `${pdfs.size} source${pdfs.size === 1 ? "" : "s"} · ${formatSize(totalBytes)}`;
  el.pdfDrop.classList.toggle("filled", pdfs.size > 0);

  const ready = Boolean(docx) && pdfs.size > 0;
  el.compare.disabled = !ready;
  el.compareLabel.textContent = ready
    ? `Compare with ${pdfs.size} source${pdfs.size === 1 ? "" : "s"}`
    : !docx && !pdfs.size
      ? "Add a manuscript and sources"
      : !docx
        ? "Add a manuscript"
        : "Add at least one source";
}

for (const input of [el.docxInput, el.pdfInput, el.folderInput]) {
  input.addEventListener("change", () => {
    if (input.files.length) acceptFiles(fromFileList(input.files));
    input.value = "";
  });
}

// The sources box opens the file picker; its "choose a folder" link opens the folder picker
el.pdfDrop.addEventListener("click", (e) => {
  if (!e.target.closest("label, input")) el.pdfInput.click();
});
el.pdfDrop.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target === el.pdfDrop) {
    e.preventDefault();
    el.pdfInput.click();
  }
});

el.docxRemove.addEventListener("click", () => {
  state.docx = null;
  renderIntake();
});

el.pdfClear.addEventListener("click", () => {
  state.pdfs.clear();
  state.showAllPdfs = false;
  renderIntake();
});

// Drop anywhere on the trays; files are sorted by type
let dragDepth = 0;
el.trays.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  el.trays.classList.add("dragging");
});
el.trays.addEventListener("dragover", (e) => e.preventDefault());
el.trays.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.trays.classList.remove("dragging");
  }
});
el.trays.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.trays.classList.remove("dragging");
  const transfer = e.dataTransfer;
  if (!transfer) return;

  // Entries must be taken during the event; they are gone after the first await
  const entries = Array.from(transfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);

  if (entries.length) {
    setStatus("Looking through folders…");
    acceptFiles(await collectEntries(entries));
  } else if (transfer.files?.length) {
    acceptFiles(fromFileList(transfer.files));
  }
});

// Stop a stray drop elsewhere from navigating away from the page
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

/* ---------- Comparison ---------- */

el.compare.addEventListener("click", async () => {
  try {
    await compare();
  } catch (error) {
    console.error(error);
    showView("intake");
    setStatus(`Couldn't finish the comparison. ${error?.message || error || ""}`.trim(), true);
  }
});

function showView(view) {
  el.intake.hidden = view !== "intake";
  el.working.hidden = view !== "working";
  el.report.hidden = view !== "report";
  if (view === "intake" || view === "report") placeTuning(view);
  const heading =
    view === "intake" ? $("intake-title") : view === "working" ? el.workingTitle : $("findings-title");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

async function compare() {
  const entries = Array.from(state.pdfs.values());
  const manuscript = buildManuscript(state.docx.html);
  const settings = state.settings;

  if (manuscript.words.length < settings.windowMatch) {
    setStatus(`The manuscript needs at least ${settings.windowMatch} words to compare.`, true);
    return;
  }

  showView("working");
  el.ocrAsk.hidden = true;
  const stages = renderWorkLedger(entries);

  // 1. Text layers, plus OCR text saved from earlier runs
  let read = 0;
  const showRead = () =>
    setWorking(`${read} of ${plural(entries.length, "source")} read`, read / entries.length);
  showRead();
  const results = await runPool(
    entries.map(({ file }) => ({ file, message: { type: "source" } })),
    manuscript.words,
    (job, event) => {
      if (event.type === "stage") setStage(stages[job], event.stage);
      if (event.type === "done") {
        setStage(stages[job], "done", event.result);
        read++;
        showRead();
      }
    }
  );

  // 2. Scanned pages nobody has read yet: ask, then OCR them
  const scanned = results.flatMap((r, i) => (!r.error && r.missingPages?.length ? [i] : []));
  if (scanned.length && (await askForOcr(scanned.map((i) => results[i])))) {
    const ocrText = await readScannedPages(scanned, entries, results, stages, manuscript.words);

    // 3. Match those sources again, now with their OCR text
    const redo = scanned.filter((i) => ocrText.has(i));
    setWorking("Matching scanned sources", 1);
    const again = await runPool(
      redo.map((i) => ({
        file: entries[i].file,
        message: { type: "source", ocrText: ocrText.get(i) },
      })),
      manuscript.words,
      (job, event) => {
        if (event.type === "done") setStage(stages[redo[job]], "done", event.result);
      }
    );
    again.forEach((result, k) => (results[redo[k]] = result));
  }

  const withPaths = results.map((result, i) => ({ ...result, path: entries[i].path }));

  // Everything the tuning panel needs to re-match without reading PDFs again
  state.base = {
    manuscript,
    docxTrigrams: buildDocxTrigrams(manuscript.words),
    readable: withPaths.filter((result) => !result.error && result.wordCount > 0),
    unread: [
      ...withPaths
        .filter((result) => !result.error && result.missingPages?.length)
        .map((result) => ({
          path: result.path,
          why: result.wordCount ? "Partly read" : "Scanned, not read",
          detail: `${plural(result.missingPages.length, "scanned page")} not read`,
        })),
      ...withPaths
        .filter((result) => result.error)
        .map((result) => ({ path: result.path, why: "Unreadable", detail: result.error, failed: true })),
    ],
    settings,
    defaultIds: null, // path -> flagged ids under the default settings, for comparison
  };

  const { sources, noOverlap } = buildSources(state.base.readable, settings);
  if (isDefaultSettings(settings)) state.base.defaultIds = idsByPath(sources);
  renderReport(manuscript, sources, [...noOverlap, ...state.base.unread]);
  showView("report");
  if (!state.base.defaultIds) computeDefaultIds();
}

/**
 * Turns per-source match results into report sources (largest first) plus
 * the "no overlap" list. Sources already shown keep their colour and on/off
 * state, so a settings change doesn't reshuffle the report.
 */
function buildSources(readable, settings, previous = []) {
  const { manuscript, docxTrigrams } = state.base;
  const idSets = finalizeMatches(readable, docxTrigrams, manuscript.words, settings);

  const before = new Map(previous.map((source) => [source.path, source]));
  const used = new Set(previous.map((source) => source.color));
  let nextInk = 0;
  const freshInk = () => {
    while (used.has(inkFor(nextInk))) nextInk++;
    used.add(inkFor(nextInk));
    return inkFor(nextInk);
  };

  const sources = readable
    .map((result, i) => ({
      path: result.path,
      ids: idSets[i],
      wordCount: result.wordCount,
      ocrPages: result.ocrPages || 0,
      text: result.text || "",
      pageBoundaries: result.pageBoundaries || [],
      windowPositions: result.windowPositions,
      trigramPositions: result.trigramPositions,
      sharedTrigrams: result.sharedTrigrams || [],
    }))
    .filter((source) => source.ids.size > 0)
    .sort((a, b) => b.ids.size - a.ids.size || a.path.localeCompare(b.path))
    .map((source) => {
      const positions = matchPositions(source, docxTrigrams);
      const groups = groupWordIds(Array.from(source.ids));
      const groupById = new Map();
      for (const group of groups) {
        for (const id of group.ids) groupById.set(id, group);
      }
      return {
        ...source,
        positions,
        groups,
        groupById,
        pages: pagesForWordOffsets(
          source.pageBoundaries,
          Array.from(source.ids, (id) => positions.get(id)).filter((v) => v !== undefined)
        ),
        color: before.get(source.path)?.color ?? freshInk(),
        enabled: before.get(source.path)?.enabled ?? true,
      };
    });

  const noOverlap = readable
    .filter((result, i) => idSets[i].size === 0 && !result.missingPages?.length)
    .map((result) => ({ path: result.path, why: "No overlap" }));
  return { sources, noOverlap };
}

const idsByPath = (sources) => new Map(sources.map((source) => [source.path, source.ids]));

const mapOrObjectEntries = (value) =>
  value instanceof Map ? value.entries() : Object.entries(value || {});

/**
 * Best source word offset for each flagged manuscript word of a source:
 * shared-phrase positions first, then window positions (which win, as they
 * are the stronger signal).
 */
function matchPositions(result, docxTrigrams) {
  const positions = new Map();
  const put = (id, value, overwrite = false) => {
    const wordId = Number(id);
    const sourceStart = Number(value?.sourceStart ?? value);
    if (!Number.isFinite(wordId) || !Number.isFinite(sourceStart)) return;
    if (overwrite || !positions.has(wordId)) positions.set(wordId, sourceStart);
  };
  for (const [text, offset] of mapOrObjectEntries(result.trigramPositions)) {
    for (const id of docxTrigrams.get(text) || []) put(id, offset);
  }
  for (const [id, position] of mapOrObjectEntries(result.windowPositions)) {
    put(id, position, true);
  }
  return positions;
}

/** A source's kept cleaned words as a list, split once and cached. */
function sourceWordList(source) {
  if (!source.wordListCache) {
    source.wordListCache = source.text ? source.text.split(" ") : [];
  }
  return source.wordListCache;
}

function setWorking(title, fraction) {
  el.workingTitle.textContent = title;
  el.workingFill.style.width = `${Math.min(1, fraction) * 100}%`;
}

/** Updates one row of the progress list. */
function setStage(node, stage, info) {
  node.removeAttribute("title");
  if (stage === "done" && info.error) stage = "failed";
  node.className = `stage ${stage}`;

  if (stage === "reading") node.textContent = "Reading text";
  else if (stage === "matching") node.textContent = "Matching";
  else if (stage === "ocr") node.textContent = `OCR ${info.done} of ${plural(info.total, "page")}`;
  else if (stage === "failed") {
    node.textContent = "Couldn't read";
    node.title = info.error;
  } else if (info.missingPages?.length) {
    node.className = "stage scanned";
    node.textContent = [
      plural(info.missingPages.length, "scanned page"),
      info.wordCount ? plural(info.wordCount, "word") : "",
    ].filter(Boolean).join(" · ");
  } else {
    node.textContent = [
      plural(info.wordCount, "word"),
      info.ocrPages ? `${info.ocrPages} by OCR` : "",
    ].filter(Boolean).join(" · ");
  }
}

/* ---------- OCR for scanned pages ---------- */

const OCR_RATE_KEY = "similarity-check.ocrSecondsPerPage";
const DEFAULT_SECONDS_PER_PAGE = 2;

/** Seconds per page measured on this computer last time, if any. */
function savedOcrRate() {
  try {
    const value = Number(localStorage.getItem(OCR_RATE_KEY));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

// Each OCR engine holds 100–200 MB, so memory sets the ceiling. Measured on
// a 20-core machine: 4 engines read a page every 1.15 s, 8 every 0.79 s.
function ocrPoolSize() {
  const cores = (navigator.hardwareConcurrency || 4) - 1;
  const memory = navigator.deviceMemory || 8; // GB, reported up to 8
  const ceiling = memory <= 2 ? 1 : memory <= 4 ? 2 : 8;
  return Math.max(1, Math.min(cores, ceiling));
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Shows the OCR question in the progress view and waits for an answer. */
function askForOcr(scannedResults) {
  const pages = scannedResults.reduce((n, r) => n + r.missingPages.length, 0);
  const rate = savedOcrRate();
  const seconds =
    (pages * (rate || DEFAULT_SECONDS_PER_PAGE)) / Math.min(ocrPoolSize(), pages) +
    (rate ? 0 : 4); // first run also loads the OCR engine

  el.ocrAskTitle.textContent = `${plural(scannedResults.length, "PDF")} ${
    scannedResults.length === 1 ? "has" : "have"
  } scanned pages`;
  el.ocrAskDetail.textContent =
    `${plural(pages, "page")} ${pages === 1 ? "has" : "have"} no text layer and can only be read with OCR. ` +
    `That takes about ${formatDuration(seconds)}${rate ? " on this computer" : ""}. ` +
    "The text stays on this device and is remembered, so these pages are never read twice.";
  setWorking("Waiting for your choice", 1);
  el.ocrAsk.hidden = false;
  el.ocrRun.focus();

  return new Promise((resolve) => {
    const answer = (yes) => {
      el.ocrAsk.hidden = true;
      el.ocrRun.onclick = el.ocrSkip.onclick = null;
      resolve(yes);
    };
    el.ocrRun.onclick = () => answer(true);
    el.ocrSkip.onclick = () => answer(false);
  });
}

/**
 * OCRs every missing page. Big PDFs are split into page ranges so one long
 * scan still uses every worker.
 * @returns {Promise<Map<number, Record<number, string>>>} source index -> page texts
 */
async function readScannedPages(scanned, entries, results, stages, words) {
  const pool = ocrPoolSize();
  const tasks = [];
  const counts = new Map();
  let total = 0;

  for (const i of scanned) {
    const pages = results[i].missingPages;
    total += pages.length;
    counts.set(i, { done: 0, total: pages.length });
    setStage(stages[i], "ocr", counts.get(i));
    const size = Math.ceil(pages.length / Math.min(pool, pages.length));
    for (let k = 0; k < pages.length; k += size) {
      tasks.push({
        file: entries[i].file,
        source: i,
        message: { type: "ocr", pages: pages.slice(k, k + size), hash: results[i].hash },
      });
    }
  }

  let done = 0;
  let pageMs = 0;
  let renderMs = 0;
  let engineMs = 0;
  const started = performance.now();
  const texts = new Map();
  const show = () => setWorking(`Reading scanned pages: ${done} of ${total}`, done / total);
  show();

  await runPool(
    tasks,
    words,
    (job, event) => {
      const i = tasks[job]?.source;
      if (event.type === "ocr-ready") {
        engineMs = Math.max(engineMs, event.ms);
      } else if (event.type === "ocr-page") {
        done++;
        pageMs += event.ms;
        renderMs += event.renderMs;
        counts.get(i).done++;
        setStage(stages[i], "ocr", counts.get(i));
        show();
      } else if (event.type === "done") {
        if (event.result.error) setStage(stages[i], "failed", event.result);
        else texts.set(i, { ...texts.get(i), ...event.result.texts });
      }
    },
    { maxWorkers: pool }
  );

  if (done > 0) {
    const secondsPerPage = pageMs / done / 1000;
    state.ocrStats = {
      pages: done,
      workers: Math.min(pool, tasks.length),
      wallSeconds: (performance.now() - started) / 1000,
      secondsPerPage,
      renderSecondsPerPage: renderMs / done / 1000,
      engineLoadSeconds: engineMs / 1000,
      cores: navigator.hardwareConcurrency,
    };
    console.info("OCR timing", state.ocrStats);
    try {
      localStorage.setItem(OCR_RATE_KEY, String(secondsPerPage));
    } catch {
      // Estimate falls back to the default next time
    }
  }
  return texts;
}

function renderWorkLedger(entries) {
  const stages = [];
  el.workLedger.replaceChildren(
    ...entries.map(({ path }, i) => {
      const li = document.createElement("li");
      const num = document.createElement("span");
      num.className = "ledger-num";
      num.textContent = String(i + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "ledger-name";
      name.append(pathLabel(path));
      name.title = path;
      const stage = document.createElement("span");
      stage.className = "stage";
      stage.textContent = "Queued";
      stages.push(stage);
      li.append(num, name, stage);
      return li;
    })
  );
  return stages;
}

/**
 * Runs tasks on a small pool of workers. Each worker builds the manuscript
 * index once, then takes tasks from a shared queue. A task is a PDF plus the
 * message to send with it ("source" to read and match, "ocr" to read pages).
 * Progress events go to onEvent(taskIndex, event); each finished task also
 * produces { type: "done", result }.
 * @param {Array<{file: File, message: object}>} tasks
 * @returns {Promise<object[]>} one result per task
 */
function runPool(tasks, words, onEvent, { maxWorkers = 4, settings = state.settings } = {}) {
  const poolSize = Math.max(1, Math.min(tasks.length, maxWorkers, (navigator.hardwareConcurrency || 4) - 1));
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let failedStarts = 0;
  if (tasks.length === 0) return Promise.resolve(results);

  return new Promise((resolve) => {
    const finish = (job, result) => {
      if (results[job]) return;
      results[job] = result;
      done++;
      onEvent(job, { type: "done", result });
      if (done === tasks.length) resolve(results);
    };

    const spawn = () => {
      const worker = new Worker(new URL("./matcher.worker.js", import.meta.url), { type: "module" });
      worker.postMessage({ type: "init", words, settings });
      let current = -1;
      let completedAny = false;

      const feed = async () => {
        if (next >= tasks.length) {
          worker.terminate();
          return;
        }
        current = next++;
        if (!tasks[current].file) {
          // Text-only task (re-matching): nothing to read from disk
          worker.postMessage({ ...tasks[current].message, job: current });
          return;
        }
        try {
          const buffer = await tasks[current].file.arrayBuffer();
          worker.postMessage({ ...tasks[current].message, job: current, buffer }, [buffer]);
        } catch {
          finish(current, { error: "The file could not be opened" });
          feed();
        }
      };

      worker.onmessage = ({ data }) => {
        if (data.type === "result") {
          completedAny = true;
          finish(data.job, data);
          feed();
        } else {
          onEvent(data.job, data);
        }
      };

      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        if (current >= 0) finish(current, { error: "The reader stopped on this file" });
        if (completedAny) {
          spawn(); // one bad file: carry on with a fresh worker
        } else if (++failedStarts >= poolSize) {
          // No worker ever ran (blocked or unsupported): fail what's left
          while (next < tasks.length) finish(next++, { error: "Background reader could not start" });
        }
        // Otherwise a healthy sibling will pick up the remaining queue
      };

      feed();
    };

    for (let i = 0; i < poolSize; i++) spawn();
  });
}

/* ---------- Report ---------- */

function renderReport(manuscript, sources, quiet) {
  state.report = null;
  el.forgetOcr.disabled = false;
  el.forgetOcr.textContent = "Forget it";
  el.manuscript.replaceChildren(manuscript.root);
  el.pageTitle.textContent = state.docx.file.name;
  el.pageMeta.textContent = `${numberFormat.format(manuscript.words.length)} words`;
  renderTuning();
  showSources(sources, quiet);
}

/** Shows a set of sources on the already-rendered manuscript. */
function showSources(sources, quiet) {
  const { words, spans, gaps } = state.base.manuscript;
  clearSpotlight();
  clearHighlights();

  // Which sources contain each flagged word, in priority order
  const sourcesOf = new Map();
  sources.forEach((source, s) => {
    for (const id of source.ids) {
      if (!sourcesOf.has(id)) sourcesOf.set(id, []);
      sourcesOf.get(id).push(s);
    }
  });

  state.report = {
    words,
    spans,
    sources,
    sourcesOf,
    // Only gaps between two flagged words can ever be highlighted
    gaps: gaps.filter((gap) => sourcesOf.has(gap.left) && sourcesOf.has(gap.right)),
    primary: new Map(),
  };

  el.sourceList.replaceChildren(...sources.map(renderSourceRow));
  el.quietSources.hidden = quiet.length === 0;
  el.quietList.replaceChildren(
    ...quiet.map(({ path, why, detail, failed }) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "quiet-name";
      label.append(pathLabel(path));
      label.title = path;
      const reason = document.createElement("span");
      reason.className = `quiet-why${failed ? " failed" : ""}`;
      reason.textContent = why;
      if (detail) reason.title = detail;
      li.append(label, reason);
      return li;
    })
  );

  applyToggles();
}

function renderSourceRow(source, s) {
  const li = document.createElement("li");
  li.className = "source";
  li.style.setProperty("--hl", source.color);

  const toggle = document.createElement("label");
  toggle.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = source.enabled;
  input.setAttribute("aria-label", `Show matches from ${source.path}`);
  const track = document.createElement("span");
  track.className = "track";
  toggle.append(input, track);
  input.addEventListener("change", () => {
    source.enabled = input.checked;
    clearSpotlight();
    applyToggles();
    if (source.enabled) spotlight(s);
  });

  const chip = document.createElement("span");
  chip.className = "chip";

  const name = document.createElement("button");
  name.type = "button";
  name.className = "source-name";
  // File name first; the line underneath gives its folder (to tell
  // same-named files apart) and whether OCR supplied some of its text
  const { dir, base } = splitPath(source.path);
  name.textContent = base;
  const notes = [
    dir,
    source.ocrPages ? `${plural(source.ocrPages, "page")} read by OCR` : "",
    source.pages?.length ? `matched ${formatPagesList(source.pages)}` : "",
  ];
  if (notes.some(Boolean)) {
    const folder = document.createElement("span");
    folder.className = "path-dir source-dir";
    folder.textContent = notes.filter(Boolean).join(" · ");
    name.append(folder);
  }
  name.title = `${source.path}\nClick to jump to its first match`;
  name.addEventListener("click", () => jumpTo(s));

  const pct = document.createElement("span");
  pct.className = "source-pct";

  li.append(toggle, chip, name, pct);
  li.addEventListener("mouseenter", () => spotlight(s));
  li.addEventListener("mouseleave", clearSpotlight);
  li.addEventListener("focusin", () => spotlight(s));
  li.addEventListener("focusout", clearSpotlight);
  source.row = { li, input, name, pct };
  return li;
}

/** Removes every highlight the current report put on the manuscript. */
function clearHighlights() {
  const report = state.report;
  if (!report) return;
  for (const id of report.sourcesOf.keys()) {
    const span = report.spans[id];
    span.classList.remove("hit", "multi", "lit");
    span.style.removeProperty("--hl");
    span.removeAttribute("tabindex");
    span.removeAttribute("aria-label");
  }
  for (const gap of report.gaps) {
    gap.el.classList.remove("hit", "lit");
    gap.el.style.removeProperty("--hl");
  }
}

const formatPercent = (value) =>
  value > 0 && value < 0.1 ? "<0.1" : value.toFixed(1).replace(/\.0$/, "");

/** Re-applies highlights and figures for the current on/off state. */
function applyToggles() {
  const report = state.report;
  const { spans, sources, sourcesOf, words } = report;
  const exclusion = exclusionSummary(words, state.base.settings);
  const summary = summarize(
    sources.map((s) => s.ids),
    sources.map((s) => s.enabled),
    exclusion.countedWords
  );
  report.primary = summary.primary;
  report.summary = summary;
  report.exclusion = exclusion;
  words.forEach((word, id) => {
    spans[id]?.classList.toggle("excluded", exclusion.excludedIds.has(word.id ?? id));
  });

  for (const [id, list] of sourcesOf) {
    const span = spans[id];
    const s = summary.primary.get(id);
    if (s === undefined) {
      span.classList.remove("hit", "multi");
      span.style.removeProperty("--hl");
      span.removeAttribute("tabindex");
      span.removeAttribute("aria-label");
      continue;
    }
    span.classList.add("hit");
    span.style.setProperty("--hl", sources[s].color);
    span.classList.toggle("multi", list.filter((i) => sources[i].enabled).length > 1);
    const names = list
      .filter((i) => sources[i].enabled)
      .map((i) => splitPath(sources[i].path).base);
    span.tabIndex = 0;
    span.setAttribute("aria-label", `${span.textContent} — found in ${names.join(", ")}`);
  }

  for (const gap of report.gaps) {
    const left = summary.primary.get(gap.left);
    const same = left !== undefined && left === summary.primary.get(gap.right);
    gap.el.classList.toggle("hit", same);
    if (same) gap.el.style.setProperty("--hl", sources[left].color);
    else gap.el.style.removeProperty("--hl");
  }

  // Figures
  const settings = state.base.settings;
  const level = similarityLevel(summary.overallPercent, settings);
  el.tickModerate.style.left = `${settings.moderateFrom}%`;
  el.tickModerate.textContent = settings.moderateFrom;
  el.tickHigh.style.left = `${settings.highFrom}%`;
  el.tickHigh.textContent = settings.highFrom;
  el.tickHigh.hidden = settings.highFrom === settings.moderateFrom;
  showSettingsComparison(sources, exclusion.countedWords);
  el.scoreValue.textContent = formatPercent(summary.overallPercent);
  el.verdict.className = `verdict-tag ${level}`;
  el.verdict.textContent = level;
  const ignoredReasons = [];
  if (exclusion.referenceListIgnoredWords) ignoredReasons.push("reference list");
  if (exclusion.quotedIgnoredWords) ignoredReasons.push("quoted text");
  el.flagged.textContent =
    `${numberFormat.format(summary.flaggedWords)} of ${numberFormat.format(exclusion.countedWords)} words match the sources switched on.` +
    (exclusion.ignoredWords
      ? ` ${plural(exclusion.ignoredWords, "word")} ignored (${ignoredReasons.join(" and ")}).`
      : "");
  el.pageMeta.textContent =
    `${numberFormat.format(exclusion.countedWords)} counted words` +
    (exclusion.ignoredWords ? ` · ${plural(exclusion.ignoredWords, "word")} ignored` : "");

  el.spectrum.replaceChildren(
    ...sources
      .map((source, s) => ({ source, width: summary.attributedPercent[s] }))
      .filter(({ width }) => width > 0)
      .map(({ source, width }) => {
        const seg = document.createElement("span");
        seg.style.width = `${width}%`;
        seg.style.background = source.color;
        return seg;
      })
  );

  sources.forEach((source, s) => {
    const { li, input, name, pct } = source.row;
    li.classList.toggle("off", !source.enabled);
    input.checked = source.enabled;
    name.disabled = !source.enabled;
    const value = summary.sourcePercent[s];
    pct.textContent = value === null ? "off" : `${formatPercent(value)}%`;
  });

  const anyOn = sources.some((s) => s.enabled);
  el.toggleAll.textContent = anyOn ? "Hide all" : "Show all";
  el.toggleAll.hidden = sources.length === 0;
}

el.toggleAll.addEventListener("click", () => {
  const sources = state.report.sources;
  const turnOn = !sources.some((s) => s.enabled);
  sources.forEach((s) => (s.enabled = turnOn));
  applyToggles();
});

/* Hovering a source row lights only that source's passages */
function spotlight(s) {
  const { sources, spans, gaps } = state.report;
  const source = sources[s];
  if (!source.enabled) return;
  el.manuscript.classList.add("spotlight");
  el.manuscript.style.setProperty("--spot", source.color);
  for (const id of source.ids) spans[id].classList.add("lit");
  for (const gap of gaps) {
    if (source.ids.has(gap.left) && source.ids.has(gap.right)) gap.el.classList.add("lit");
  }
}

function clearSpotlight() {
  if (!el.manuscript.classList.contains("spotlight")) return;
  el.manuscript.classList.remove("spotlight");
  for (const node of el.manuscript.querySelectorAll(".lit")) node.classList.remove("lit");
}

function jumpTo(s) {
  const source = state.report.sources[s];
  if (!source.enabled) return;
  let first = Infinity;
  for (const id of source.ids) if (id < first) first = id;
  const span = state.report.spans[first];
  span.scrollIntoView({ behavior: "smooth", block: "center" });
  span.classList.remove("flash");
  void span.offsetWidth; // restart the animation
  span.classList.add("flash");
}

/* ---------- Export: CSV / JSON downloads built from the live report ---------- */

/** Raw export input honouring the sources currently switched on and the current settings. */
function currentExportInput() {
  const report = state.report;
  if (!report?.summary) return null;
  const { sources, summary, exclusion } = report;

  const enabled = sources.map((source) => source.enabled);
  const flaggedIds = new Set();
  sources.forEach((source, s) => {
    if (enabled[s]) for (const id of source.ids) flaggedIds.add(id);
  });

  const matchedPassages = groupWordIds(Array.from(flaggedIds)).map((group) => ({
    manuscriptExcerpt: group.ids.map((id) => report.spans[id].textContent).join(" "),
    startWordIndex: group.start,
    sources: sources.flatMap((source, s) => {
      if (!enabled[s]) return [];
      const ids = group.ids.filter((id) => source.ids.has(id));
      if (!ids.length) return [];
      return [
        {
          name: source.path,
          pages: pagesForWordOffsets(
            source.pageBoundaries,
            ids.map((id) => source.positions.get(id)).filter((v) => v !== undefined)
          ),
        },
      ];
    }),
  }));

  return {
    manuscriptName: state.docx.file.name,
    date: new Date(),
    settings: { ...state.base.settings },
    settingsDescription: describeSettings(state.base.settings),
    overallPercent: summary.overallPercent,
    countedWords: exclusion.countedWords,
    ignoredWords: exclusion.ignoredWords,
    totalWords: exclusion.totalWords,
    ignoredBreakdown: {
      referenceList: exclusion.referenceListIgnoredWords,
      quotedText: exclusion.quotedIgnoredWords,
    },
    level: similarityLevel(summary.overallPercent, state.base.settings),
    sources: sources.map((source, s) => ({
      name: source.path,
      enabled: source.enabled,
      percent: summary.sourcePercent[s],
      flaggedWords: source.ids.size,
      pages: source.pages,
    })),
    matchedPassages,
  };
}

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFilename(extension) {
  const base = state.docx.file.name.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]/g, "-");
  return `${base || "manuscript"}-similarity.${extension}`;
}

/* ---------- Tooltip: which PDF a highlight came from ---------- */

// A gap shows the sources of the word before it
const wordIdFor = (node) => Number(node.classList.contains("w") ? node.dataset.i : node.dataset.left);

function showTooltip(target) {
  const id = wordIdFor(target);
  const report = state.report;
  const list = (report.sourcesOf.get(id) || []).filter((s) => report.sources[s].enabled);
  if (!list.length) return hideTooltip();

  const label = document.createElement("span");
  label.className = "tooltip-label";
  label.textContent = list.length > 1 ? `Found in ${list.length} sources` : "Found in";
  const ul = document.createElement("ul");
  for (const s of list) {
    const source = report.sources[s];
    const group = source.groupById?.get(id) || { start: id, end: id, ids: [id] };
    const pages = pagesForWordOffsets(
      source.pageBoundaries,
      group.ids.map((gid) => source.positions?.get(gid)).filter((v) => v !== undefined)
    );

    const li = document.createElement("li");
    li.className = "tooltip-source";
    li.style.setProperty("--hl", source.color);

    const head = document.createElement("span");
    head.className = "tooltip-source-head";
    const swatch = document.createElement("i");
    const name = document.createElement("span");
    name.append(pathLabel(source.path));
    const page = document.createElement("span");
    page.className = "tooltip-page";
    page.textContent = pages.length ? formatPagesList(pages) : "page unknown";
    head.append(swatch, name, page);
    li.append(head);

    const at = source.positions?.get(id);
    if (at !== undefined) {
      const excerpt = buildExcerpt(sourceWordList(source), at, {
        sharedWords: new Set(group.ids.map((gid) => report.words[gid].content)),
        boundaries: source.pageBoundaries,
      });
      const p = document.createElement("p");
      p.className = "tooltip-excerpt";
      if (excerpt.start > 0) p.append("… ");
      excerpt.words.forEach((word, i) => {
        if (i) p.append(document.createTextNode(" "));
        if (word.shared) {
          const strong = document.createElement("strong");
          strong.textContent = word.text;
          p.append(strong);
        } else {
          p.append(document.createTextNode(word.text));
        }
      });
      if (excerpt.end < excerpt.totalWords) p.append(" …");
      li.append(p);
    }
    ul.append(li);
  }
  el.tooltip.replaceChildren(label, ul);
  el.tooltip.hidden = false;

  const rect = target.getBoundingClientRect();
  const tip = el.tooltip.getBoundingClientRect();
  const margin = 12;
  let left = rect.left + rect.width / 2 - tip.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
  let top = rect.top - tip.height - 8;
  if (top < margin) top = rect.bottom + 8;
  el.tooltip.style.left = `${left}px`;
  el.tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  el.tooltip.hidden = true;
}

el.manuscript.addEventListener("mouseover", (e) => {
  const target = e.target.closest?.(".hit");
  if (target) showTooltip(target);
  else hideTooltip();
});
el.manuscript.addEventListener("mouseleave", hideTooltip);
// Touch screens have no hover: tap a highlight to see its source
el.manuscript.addEventListener("click", (e) => {
  const target = e.target.closest?.(".hit");
  if (target) showTooltip(target);
  else hideTooltip();
});
el.manuscript.addEventListener("focusin", (e) => {
  const target = e.target.closest?.(".hit");
  if (target) showTooltip(target);
});
el.manuscript.addEventListener("focusout", hideTooltip);
document.addEventListener("scroll", hideTooltip, { capture: true, passive: true });
window.addEventListener("resize", hideTooltip);

/* ---------- Tuning: adjustable matching settings ---------- */

const SETTINGS_KEY = "similarity-check.settings";

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch {
    return normalizeSettings();
  }
}

function saveSettings(settings) {
  try {
    if (isDefaultSettings(settings)) localStorage.removeItem(SETTINGS_KEY);
    else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered: the settings still apply to this report
  }
}

// The panel's controls, in order. Settings marked rematch: false only change
// how the score is labelled, so they apply instantly without re-matching.
const TUNING_CONTROLS = [
  {
    key: "windowMatch",
    type: "range",
    min: 2,
    label: "Words that must match",
    hint: "Distinct words a stretch of your draft and a stretch of a source must share, in any order. Lower catches looser rewording, and more everyday phrasing too.",
  },
  {
    key: "docxWindow",
    type: "range",
    min: 5,
    max: 40,
    label: "Draft stretch",
    unit: "words",
    hint: "How many words of your draft are compared at a time.",
  },
  {
    key: "pdfWindow",
    type: "range",
    min: 5,
    max: 40,
    label: "Source stretch",
    unit: "words",
    hint: "How many words of each PDF are compared at a time.",
  },
  {
    key: "phrases",
    type: "check",
    label: "Phrase check",
    hint: "Also compare 3-word phrases, with common words left out.",
  },
  {
    key: "phraseGate",
    type: "range",
    min: 1,
    max: 200,
    label: "Phrases a source must share",
    hint: "Below this, a source's shared phrases are treated as coincidence.",
    dependsOn: "phrases",
  },
  {
    key: "phrasesUniqueOnly",
    type: "check",
    label: "Only phrases unique to one source",
    hint: "Off credits a shared phrase to every source that contains it.",
    dependsOn: "phrases",
  },
  {
    key: "dropLoneStopWords",
    type: "check",
    label: "Ignore lone common words",
    hint: "Unmark a single “the” or “of” caught next to a real passage.",
  },
  {
    key: "ignoreReferenceList",
    type: "check",
    label: "Ignore the reference list",
    hint: "Everything from a References, Bibliography, Works Cited, Reference List, Sources or Literature Cited heading onwards stays visible but is never highlighted or counted.",
  },
  {
    key: "ignoreQuotedText",
    type: "check",
    label: "Ignore quoted text",
    hint: "Words inside quotation marks or block quotes stay visible but are never highlighted or counted.",
  },
  { key: "moderateFrom", type: "number", min: 0, max: 100, label: "Moderate from", rematch: false },
  { key: "highFrom", type: "number", min: 0, max: 100, label: "High from", rematch: false },
];

const tuningInputs = new Map(); // key -> { input, output, row }

/** Builds the panel's controls once, from TUNING_CONTROLS. */
function buildTuning() {
  const levels = document.createElement("div");
  levels.className = "tune tune-levels";
  const levelsLabel = document.createElement("span");
  levelsLabel.className = "tune-label";
  levelsLabel.textContent = "Levels";
  levels.append(levelsLabel);

  for (const control of TUNING_CONTROLS) {
    const id = `tune-${control.key}`;
    const input = document.createElement("input");
    input.id = id;
    input.dataset.key = control.key;

    if (control.type === "number") {
      input.type = "number";
      input.min = control.min;
      input.max = control.max;
      input.inputMode = "numeric";
      const label = document.createElement("label");
      label.className = "tune-number";
      label.append(`${control.label} `, input, "%");
      levels.append(label);
      tuningInputs.set(control.key, { input });
      continue;
    }

    const row = document.createElement("div");
    row.className = `tune${control.dependsOn ? " tune-dependent" : ""}`;
    const hint = document.createElement("p");
    hint.className = "tune-hint";
    hint.id = `${id}-hint`;
    hint.textContent = control.hint;
    input.setAttribute("aria-describedby", hint.id);

    if (control.type === "check") {
      input.type = "checkbox";
      const label = document.createElement("label");
      label.className = "tune-check";
      const text = document.createElement("span");
      text.textContent = control.label;
      label.append(input, text);
      row.append(label, hint);
      tuningInputs.set(control.key, { input, row });
    } else {
      input.type = "range";
      input.min = control.min;
      if (control.max) input.max = control.max;
      const head = document.createElement("div");
      head.className = "tune-head";
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = control.label;
      const output = document.createElement("output");
      output.htmlFor = id;
      head.append(label, output);
      row.append(head, input, hint);
      tuningInputs.set(control.key, { input, output, row, unit: control.unit });
    }
    el.tuningControls.append(row);
  }
  el.tuningControls.append(levels);
}

/**
 * Puts a settings object into the controls. A number box being typed in is
 * left alone (so "5" on the way to "50" isn't corrected mid-typing) unless
 * force is set.
 */
function syncTuning(settings, { force = false } = {}) {
  // The words-to-match can never exceed the smaller window
  tuningInputs.get("windowMatch").input.max = Math.min(settings.docxWindow, settings.pdfWindow);

  for (const [key, { input, output, row, unit }] of tuningInputs) {
    if (input.type === "checkbox") input.checked = settings[key];
    else if (force || input.type === "range" || document.activeElement !== input) input.value = settings[key];
    if (output) {
      output.textContent =
        key === "windowMatch"
          ? `${settings.windowMatch} of ${Math.min(settings.docxWindow, settings.pdfWindow)}`
          : `${settings[key]}${unit ? ` ${unit}` : ""}`;
    }
    const control = TUNING_CONTROLS.find((c) => c.key === key);
    if (control.dependsOn) {
      input.disabled = !settings[control.dependsOn];
      row.classList.toggle("disabled", input.disabled);
    }
  }
}

function readTuning() {
  const read = {};
  for (const [key, { input }] of tuningInputs) {
    read[key] = input.type === "checkbox" ? input.checked : Number(input.value);
  }
  return normalizeSettings(read);
}

/**
 * Moves the single Tune matching panel between its intake and report homes,
 * so both screens share the same controls, ids and settings store. On the
 * intake screen the "default settings would give" line (which needs a
 * finished comparison) is hidden; every actual control stays live.
 */
function placeTuning(view) {
  const onIntake = view === "intake";
  const mount = onIntake ? el.tuningIntakeMount : el.tuningReportMount;
  if (el.tuning.parentNode !== mount) mount.append(el.tuning);
  el.tuning.classList.toggle("on-intake", onIntake);
  el.tuningCompare.hidden = onIntake;
  if (onIntake) el.tuningStatus.textContent = "";
  el.tuningOpen.setAttribute("aria-expanded", String(el.tuning.open));
}

/** Readies the panel for a new report. */
function renderTuning() {
  syncTuning(state.base.settings);
  el.tuningStatus.textContent = "";
  updateSettingsNotes();
}

/** Short, printable description of a settings object. */
function describeSettings(s) {
  return [
    `${s.windowMatch} shared words in ${s.docxWindow}- and ${s.pdfWindow}-word stretches`,
    s.phrases
      ? `phrase check from ${s.phraseGate} shared phrases${s.phrasesUniqueOnly ? "" : ", credited to every source"}`
      : "phrase check off",
    s.dropLoneStopWords ? "lone common words ignored" : "lone common words kept",
    s.ignoreReferenceList ? "reference list ignored" : "reference list counted",
    s.ignoreQuotedText ? "quoted text ignored" : "quoted text counted",
    `moderate from ${s.moderateFrom}%, high from ${s.highFrom}%`,
  ].join("; ");
}

/** Shows whether custom settings are in use, wherever that matters. */
function updateSettingsNotes() {
  const custom = !isDefaultSettings(state.settings);
  el.intakeSettings.hidden = !custom;
  el.tuningState.textContent = custom ? "Custom settings" : "Default settings";
  el.tuningState.classList.toggle("custom", custom);
  el.tuningOpenState.textContent = custom ? "Custom settings" : "Default settings";
  el.tuningReset.disabled = !custom;
}

/** Adopts new settings: remembers them and updates the open report. */
function applySettings(next) {
  state.settings = next;
  saveSettings(next);
  updateSettingsNotes();

  syncTuning(next);

  const base = state.base;
  if (!base || !state.report) return;
  const previous = base.settings;
  base.settings = next;
  syncTuning(next);
  const needsRematch = TUNING_CONTROLS.some(
    (control) => control.rematch !== false && previous[control.key] !== next[control.key]
  );
  if (needsRematch) scheduleRematch();
  else applyToggles();
}

let rematchTimer = 0;
let rematchRun = 0;

function scheduleRematch() {
  clearTimeout(rematchTimer);
  el.tuningStatus.textContent = "Updating…";
  rematchTimer = setTimeout(rematch, 250);
}

/** Matches the kept text of every source again with the current settings. */
async function rematch() {
  const run = ++rematchRun;
  const base = state.base;
  const settings = base.settings;
  const started = performance.now();

  const matched = await matchTexts(base.readable, settings);
  // A newer change or a new comparison has taken over
  if (run !== rematchRun || state.base !== base || !state.report) return;

  base.readable = base.readable.map((result, i) => ({
    ...result,
    windowIds: matched[i].windowIds || [],
    sharedTrigrams: matched[i].sharedTrigrams || [],
    windowPositions: matched[i].windowPositions,
    trigramPositions: matched[i].trigramPositions,
    pageBoundaries: matched[i].pageBoundaries || result.pageBoundaries || [],
  }));
  const { sources, noOverlap } = buildSources(base.readable, settings, state.report.sources);
  showSources(sources, [...noOverlap, ...base.unread]);
  el.tuningStatus.textContent = `Updated in ${Math.round(performance.now() - started)} ms`;
}

/** Runs matching on kept source text, without reading any PDF. */
function matchTexts(readable, settings) {
  return runPool(
    readable.map((result) => ({
      message: { type: "match", text: result.text, pageBoundaries: result.pageBoundaries || [] },
    })),
    state.base.manuscript.words,
    () => {},
    { settings }
  );
}

/** Works out the default-settings result once, for the "defaults would give" line. */
async function computeDefaultIds() {
  const base = state.base;
  const matched = await matchTexts(base.readable, DEFAULT_SETTINGS);
  if (state.base !== base) return;
  const results = base.readable.map((result, i) => ({
    ...result,
    windowIds: matched[i].windowIds || [],
    sharedTrigrams: matched[i].sharedTrigrams || [],
  }));
  const idSets = finalizeMatches(results, base.docxTrigrams, base.manuscript.words, DEFAULT_SETTINGS);
  base.defaultIds = new Map(results.map((result, i) => [result.path, idSets[i]]));
  if (state.report) applyToggles();
}

/** The custom-settings note and the comparison with the default score. */
function showSettingsComparison(sources, totalWords) {
  const base = state.base;
  const custom = !isDefaultSettings(base.settings);
  el.settingsNote.hidden = !custom;
  if (custom) el.settingsNote.textContent = `Custom matching settings: ${describeSettings(base.settings)}.`;

  if (!custom) {
    el.tuningCompare.textContent = "These are the default settings.";
  } else if (!base.defaultIds) {
    el.tuningCompare.textContent = "Working out the default score…";
  } else {
    // Same sources switched on, matched with the defaults
    const enabled = new Map(sources.map((source) => [source.path, source.enabled]));
    const flagged = new Set();
    for (const [path, ids] of base.defaultIds) {
      if (enabled.get(path) !== true) continue;
      for (const id of ids) flagged.add(id);
    }
    const defaultCounted = exclusionSummary(state.base.manuscript.words, DEFAULT_SETTINGS).countedWords;
    const percent = defaultCounted ? (flagged.size / defaultCounted) * 100 : 0;
    el.tuningCompare.textContent = `Default settings would give ${formatPercent(percent)}%.`;
  }
}

el.tuningControls.addEventListener("input", () => applySettings(readTuning()));
// A number box isn't corrected while being typed in; show the adjusted value once left
el.tuningControls.addEventListener("change", () => syncTuning(state.settings, { force: true }));
el.tuningReset.addEventListener("click", () => {
  applySettings(normalizeSettings());
  syncTuning(state.settings);
});
el.tuningOpen.addEventListener("click", () => {
  placeTuning("report");
  el.tuning.open = true;
  el.tuningOpen.setAttribute("aria-expanded", "true");
  el.tuning.querySelector("summary").focus();
});
el.tuning.addEventListener("toggle", () => {
  el.tuningOpen.setAttribute("aria-expanded", String(el.tuning.open));
});
el.intakeReset.addEventListener("click", () => applySettings(normalizeSettings()));

/* ---------- Report actions ---------- */

el.print.addEventListener("click", () => window.print());

el.exportCsv.addEventListener("click", () => {
  const input = currentExportInput();
  if (input) downloadText(exportFilename("csv"), serializeExportCsv(input), "text/csv;charset=utf-8");
});

el.exportJson.addEventListener("click", () => {
  const input = currentExportInput();
  if (input) {
    downloadText(exportFilename("json"), serializeExportJson(input), "application/json;charset=utf-8");
  }
});

el.forgetOcr.addEventListener("click", async () => {
  try {
    await clearOcrCache();
    el.forgetOcr.textContent = "Forgotten";
    el.forgetOcr.disabled = true;
  } catch (error) {
    console.error(error);
    el.forgetOcr.textContent = "Couldn't forget it — try again";
  }
});

el.restart.addEventListener("click", () => {
  state.report = null;
  state.base = null;
  rematchRun++;
  clearTimeout(rematchTimer);
  el.manuscript.replaceChildren();
  hideTooltip();
  setStatus("");
  renderIntake();
  showView("intake");
});

state.settings = loadSettings();
buildTuning();
syncTuning(state.settings);
placeTuning("intake");
updateSettingsNotes();
renderIntake();
