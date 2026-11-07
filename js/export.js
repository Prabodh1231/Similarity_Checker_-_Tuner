/**
 * Serialises a finished report to JSON or CSV. Pure functions with no DOM
 * access: the page builds the download Blob, everything testable lives here.
 */

import { DEFAULT_SETTINGS, normalizeSettings, similarityLevel } from "./matching.js";

const firstDefined = (...values) => values.find((value) => value !== undefined);
const roundPercent = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 100) / 100;
const uniquePages = (pages) =>
  Array.from(new Set(Array.from(pages || []).filter((p) => Number.isFinite(p)))).sort((a, b) => a - b);
const flaggedCount = (source) =>
  source.ids instanceof Set || Array.isArray(source.ids)
    ? source.ids.size ?? source.ids.length
    : Number(firstDefined(source.flaggedWords, source.flaggedWordCount, 0)) || 0;

function normaliseSource(source = {}) {
  return {
    name: String(firstDefined(source.name, source.path, "")),
    enabled: source.enabled !== false,
    percent: roundPercent(firstDefined(source.percent, source.percentValue)),
    flaggedWords: flaggedCount(source),
    pages: uniquePages(firstDefined(source.pages, source.pagesMatched, source.matchedPages)),
  };
}

function normalisePassage(passage = {}) {
  return {
    manuscriptExcerpt: String(firstDefined(passage.manuscriptExcerpt, passage.excerpt, "")),
    startWordIndex: Number(firstDefined(passage.startWordIndex, passage.start, 0)) || 0,
    sources: Array.from(passage.sources || [], (source) => ({
      name: String(firstDefined(source.name, source.path, "")),
      pages: uniquePages(source.pages),
    })),
  };
}

/**
 * Normalises report data into the exported JSON shape. Accepts the raw
 * report figures (overallPercent, matchedPassages, ...) or its own output,
 * so serialising an already-built export is a no-op.
 */
export function buildExportData(input = {}) {
  const settings = input.settings ? normalizeSettings(input.settings) : {};
  const overall = roundPercent(
    firstDefined(input.overallSimilarityPercent, input.overallPercent, input.similarityPercent)
  );
  const totalWords = firstDefined(input.totalWords, input.wordCount);
  const ignoredWords = Number(firstDefined(input.ignoredWords, 0)) || 0;
  const countedWords = Number(
    firstDefined(
      input.countedWords,
      totalWords !== undefined ? Math.max(0, totalWords - ignoredWords) : undefined,
      0
    )
  );

  const data = {
    manuscriptName: String(
      firstDefined(input.manuscriptName, input.manuscript, input.name, "")
    ),
    date:
      input.date instanceof Date
        ? input.date.toISOString()
        : String(firstDefined(input.date, new Date().toISOString())),
    settings,
    overallSimilarityPercent: overall,
    countedWords,
    ignoredWords,
    level:
      typeof input.level === "string"
        ? input.level
        : overall === null
          ? null
          : similarityLevel(overall, input.settings ? settings : DEFAULT_SETTINGS),
    sources: Array.from(input.sources || [], normaliseSource),
    matchedPassages: Array.from(
      firstDefined(input.matchedPassages, input.passages, []),
      normalisePassage
    ),
  };
  if (input.settingsDescription) data.settingsDescription = String(input.settingsDescription);
  if (totalWords !== undefined) data.totalWords = Number(totalWords) || 0;
  if (input.ignoredBreakdown) {
    data.ignoredBreakdown = {
      referenceList: Number(input.ignoredBreakdown.referenceList) || 0,
      quotedText: Number(input.ignoredBreakdown.quotedText) || 0,
    };
  }
  return data;
}

/** JSON download text for a report. */
export function serializeExportJson(input = {}) {
  return `${JSON.stringify(buildExportData(input), null, 2)}\n`;
}

/**
 * One RFC 4180 CSV cell. Cells whose text starts (after any spaces) with
 * =, +, - or @ are prefixed with an apostrophe so a spreadsheet cannot
 * treat a file name or excerpt as a formula.
 */
export function escapeCsvCell(value) {
  let cell = value === null || value === undefined ? "" : String(value);
  if (/^\s*[=+\-@]/.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell) || /^\s|\s$/.test(cell)) {
    cell = `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

/**
 * CSV download text: a header row, then one row per source and nothing
 * else. Switched-off sources keep their row, marked enabled=false with a
 * 0.00 percent, so the file always mirrors the report's source list.
 */
export function serializeExportCsv(input = {}) {
  const data = buildExportData(input);
  const header = ["name", "enabled", "percent", "flagged_words", "pages"];
  const rows = data.sources.map((source) =>
    [
      escapeCsvCell(source.name),
      source.enabled ? "true" : "false",
      source.enabled && source.percent !== null ? source.percent.toFixed(2) : "0.00",
      String(source.flaggedWords),
      escapeCsvCell(source.pages.join(", ")),
    ].join(",")
  );
  return `${[header.join(","), ...rows].join("\r\n")}\r\n`;
}

export const buildJsonExport = serializeExportJson;
export const buildCsvExport = serializeExportCsv;
export const toJsonExport = serializeExportJson;
export const toCsvExport = serializeExportCsv;
