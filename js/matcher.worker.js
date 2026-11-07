import * as pdfjsLib from "./vendor/pdf.mjs";
import {
  normalizeSettings,
  tokenizeText,
  createDocxWindows,
  buildWindowIndex,
  findWindowMatchesWithPositions,
  findTrigramPositions,
  buildDocxTrigrams,
  buildTrigramSet,
  findSharedTrigrams,
} from "./matching.js";
import { buildPageBoundaries } from "./passages.js";
import { fileHash, readCachedPages, saveCachedPage } from "./ocr-cache.js";
import { containsImages } from "./scan-detect.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdf.worker.mjs",
  import.meta.url
).href;

// In a PDF that contains images, a page with fewer letters than this in its
// text layer is treated as a scan
const MIN_TEXT_CHARS = 30;
// Scans are redrawn at this resolution for OCR, capped so huge pages stay manageable
const OCR_DPI = 200;
const OCR_MAX_SIDE = 3000;

// Manuscript data and settings, built once per worker and reused for every source
let manuscript = null;

onmessage = async ({ data }) => {
  if (data.type === "init") {
    const settings = normalizeSettings(data.settings);
    const windows = createDocxWindows(data.words, settings.docxWindow);
    manuscript = {
      settings,
      windows,
      index: buildWindowIndex(windows),
      trigramTexts: Array.from(buildDocxTrigrams(data.words).keys()),
    };
    return;
  }

  try {
    if (data.type === "source") await readSource(data);
    else if (data.type === "ocr") await ocrPages(data);
    else if (data.type === "match") {
      // Re-match text kept from an earlier read, e.g. after a settings change
      const words = data.text ? data.text.split(" ") : [];
      postMessage({
        type: "result",
        job: data.job,
        wordCount: words.length,
        pageBoundaries: data.pageBoundaries || [],
        ...matchWords(words),
      });
    }
  } catch (error) {
    // Some libraries reject with nothing at all, so never assume an Error
    const message = error?.message || (error ? String(error) : "Unknown error");
    postMessage({ type: "result", job: data.job, error: message });
  }
};

/**
 * Reads a source's text and matches it. Scanned pages use OCR text passed in
 * or saved from an earlier run; any still unread are reported as missingPages.
 */
async function readSource({ job, buffer, ocrText = {} }) {
  postMessage({ type: "stage", job, stage: "reading" });
  // Both read the raw bytes, so before PDF.js takes over the buffer
  const hash = await fileHash(buffer);
  const hasImages = containsImages(buffer);
  const pdf = await openPdf(buffer);

  let pages;
  try {
    pages = await readTextLayers(pdf, hasImages);
  } finally {
    pdf.destroy();
  }

  const scanned = pages.flatMap((page, i) => (page.scanned ? [i + 1] : []));
  const saved = await readCachedPages(hash, scanned.filter((n) => !(n in ocrText)));
  const ocr = { ...saved, ...ocrText };
  const missingPages = scanned.filter((n) => !(n in ocr));

  // Tokenise page by page (text layer or OCR alike) so every page keeps its
  // word offsets in the cleaned text; a rematch can then show page numbers
  // and excerpts without opening the PDF again.
  const pageWords = pages.map((page, i) => tokenizeText(i + 1 in ocr ? ocr[i + 1] : page.text));
  const pageBoundaries = buildPageBoundaries(pageWords.map((page) => page.length));
  const words = pageWords.flat();
  if (words.length === 0 && missingPages.length === 0) {
    throw new Error("No extractable text (blank or image-free PDF?)");
  }

  postMessage({ type: "stage", job, stage: "matching" });
  postMessage({
    type: "result",
    job,
    hash,
    wordCount: words.length,
    ...matchWords(words),
    text: words.join(" "), // kept by the page so settings changes can re-match without re-reading
    pageBoundaries, // word offsets per page, kept alongside the cleaned text
    pageCount: pages.length,
    ocrPages: Object.keys(ocr).length,
    missingPages,
  });
}

/** Both matching signals for one source, with this worker's settings. */
function matchWords(words) {
  const { settings, windows, index, trigramTexts } = manuscript;
  const windowMatch = findWindowMatchesWithPositions(
    windows,
    index,
    words,
    settings.pdfWindow,
    settings.windowMatch
  );
  const sharedTrigrams = settings.phrases
    ? findSharedTrigrams(trigramTexts, buildTrigramSet(words), settings.phraseGate)
    : [];
  return {
    windowIds: windowMatch.ids,
    // Best source window per flagged manuscript word, plus where each
    // shared phrase first occurs, so highlights can show page and excerpt
    windowPositions: windowMatch.positions,
    sharedTrigrams,
    trigramPositions: settings.phrases ? findTrigramPositions(words, sharedTrigrams) : new Map(),
  };
}

/** Reads the listed pages with OCR, saving each page's text as it goes. */
async function ocrPages({ job, buffer, pages, hash }) {
  const engine = await getOcrEngine();
  const pdf = await openPdf(buffer);
  const texts = {};

  try {
    for (const n of pages) {
      const started = performance.now();
      const page = await pdf.getPage(n);
      const canvas = await renderPage(page);
      const rendered = performance.now();
      const text = looksBlank(canvas) ? "" : (await engine.recognize(canvas)).data.text;
      page.cleanup();
      texts[n] = text;
      await saveCachedPage(hash, n, text);
      const finished = performance.now();
      postMessage({
        type: "ocr-page",
        job,
        page: n,
        ms: finished - started,
        renderMs: rendered - started,
        pixels: canvas.width * canvas.height,
      });
    }
  } finally {
    pdf.destroy();
  }

  postMessage({ type: "result", job, texts });
}

/* ---------- PDF.js in a worker ---------- */

// Workers have no document, so PDF.js draws onto OffscreenCanvas
class OffscreenCanvasFactory {
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// SVG filters need a document too; scans don't use them
const noFilters = {
  addFilter: () => "none",
  addHCMFilter: () => "none",
  addAlphaFilter: () => "none",
  addLuminosityFilter: () => "none",
  addHighlightHCMFilter: () => "none",
  destroy() {},
};

function openPdf(buffer) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    canvasFactory: new OffscreenCanvasFactory(),
    filterFactory: noFilters,
  }).promise;
}

/**
 * Reads each page's text layer and flags pages that look scanned: almost no
 * text, in a file that has images.
 * @returns {Promise<Array<{text: string, scanned: boolean}>>}
 */
async function readTextLayers(pdf, hasImages) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    const scanned = hasImages && (text.match(/[a-z0-9]/gi) || []).length < MIN_TEXT_CHARS;
    pages.push({ text, scanned });
    page.cleanup();
  }
  return pages;
}

/** Whether a rendered page is essentially empty paper, so OCR can be skipped. */
function looksBlank(canvas) {
  const width = 120;
  const height = Math.max(1, Math.round((width * canvas.height) / canvas.width));
  const small = new OffscreenCanvas(width, height);
  const context = small.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  let marked = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Shrunk text becomes grey smudges, so anything clearly darker than paper counts
    if (data[i] + data[i + 1] + data[i + 2] < 690) marked++;
  }
  return marked / (width * height) < 0.005;
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

/* ---------- Tesseract ---------- */

let ocrEngine = null;

// Loaded on first use only, so text-only comparisons never download it
function getOcrEngine() {
  ocrEngine ||= (async () => {
    const started = performance.now();
    const { default: Tesseract } = await import("./vendor/tesseract/tesseract.esm.min.js");
    const base = new URL("./vendor/tesseract/", import.meta.url).href;
    const lstmOnly = Tesseract.OEM?.LSTM_ONLY ?? 1;
    // Tesseract runs in its own worker, started from a small blob script that
    // loads worker.min.js; some browsers refuse a nested worker started
    // straight from a file URL (workerBlobURL: false)
    const engine = await Tesseract.createWorker("eng", lstmOnly, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath: `${base}lang`,
      workerBlobURL: false,
    });
    postMessage({ type: "ocr-ready", ms: performance.now() - started });
    return engine;
  })();
  // A failed start must not be cached forever: let the next attempt retry
  ocrEngine.catch(() => {
    ocrEngine = null;
  });
  return ocrEngine;
}
