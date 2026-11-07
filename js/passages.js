/**
 * Page and passage helpers. Pure functions with no DOM access, shared by the
 * page and the Node tests. A source's kept data carries its cleaned words
 * (as one space-joined string) plus pageBoundaries: one {page, start, end}
 * entry per PDF page, where start/end are word offsets in the cleaned word
 * list (end exclusive). That is enough to show page numbers and excerpts
 * after a rematch, without re-reading the PDF.
 */

import { cleanWord } from "./matching.js";

/**
 * Builds page boundaries from per-page cleaned word counts.
 * @param {number[]} pageWordCounts - In page order; page numbers are 1-based
 * @returns {Array<{page: number, start: number, end: number}>}
 */
export function buildPageBoundaries(pageWordCounts = []) {
  const boundaries = [];
  let start = 0;
  pageWordCounts.forEach((count, i) => {
    const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    boundaries.push({ page: i + 1, start, end: start + safe });
    start += safe;
  });
  return boundaries;
}

/**
 * Page number containing a word offset, or null when there is none.
 * An offset at or past the end falls back to the last page that has words.
 * @param {Array<{page: number, start: number, end: number}>} boundaries
 * @param {number} offset
 * @returns {number|null}
 */
export function pageForWordOffset(boundaries = [], offset) {
  if (!boundaries.length || !Number.isFinite(offset)) return null;
  const at = Math.max(0, Math.floor(offset));
  let fallback = null;
  for (const boundary of boundaries) {
    if (at >= boundary.start && at < boundary.end) return boundary.page;
    if (boundary.end > boundary.start && boundary.start <= at) fallback = boundary.page;
  }
  return fallback;
}

/**
 * Sorted, distinct page numbers for a list of word offsets.
 * @param {Array<{page: number, start: number, end: number}>} boundaries
 * @param {Iterable<number>} offsets
 * @returns {number[]}
 */
export function pagesForWordOffsets(boundaries = [], offsets = []) {
  const pages = new Set();
  for (const offset of offsets) {
    const page = pageForWordOffset(boundaries, offset);
    if (page !== null) pages.add(page);
  }
  return Array.from(pages).sort((a, b) => a - b);
}

/** "p. 4", "pp. 3–5, 8" style label for a list of page numbers. */
export function formatPagesList(pages = []) {
  const unique = Array.from(new Set(pages.filter((p) => Number.isFinite(p)))).sort((a, b) => a - b);
  if (unique.length === 0) return "";
  const ranges = [];
  let start = unique[0];
  let previous = unique[0];
  for (const page of unique.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = previous = page;
  }
  ranges.push(start === previous ? `${start}` : `${start}–${previous}`);
  return `${unique.length === 1 ? "p." : "pp."} ${ranges.join(", ")}`;
}

/**
 * Groups sorted word ids into passages. Ids differing by at most maxGap
 * stay in one passage (the default, 1, means strictly consecutive).
 * @param {Iterable<number>} ids
 * @returns {Array<{start: number, end: number, ids: number[]}>}
 */
export function groupWordIds(ids = [], maxGap = 1) {
  const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
  const groups = [];
  for (const id of sorted) {
    const last = groups.at(-1);
    if (last && id - last.end <= maxGap) {
      last.end = id;
      last.ids.push(id);
    } else {
      groups.push({ start: id, end: id, ids: [id] });
    }
  }
  return groups;
}

/**
 * A short excerpt of source text around a match: about contextWords words
 * (25 by default) centred a little before the match, with the words shared
 * with the manuscript flagged so the caller can emphasise them.
 * @param {string|string[]} sourceWords - Cleaned source words (array or joined string)
 * @param {number} matchOffset - Source word offset of the match
 * @param {{contextWords?: number, sharedWords?: Iterable<string>,
 *          boundaries?: Array<{page: number, start: number, end: number}>}} options
 * @returns {{text: string, start: number, end: number, totalWords: number,
 *            words: Array<{text: string, shared: boolean}>, pages: number[]}}
 */
export function buildExcerpt(sourceWords, matchOffset, options = {}) {
  const all = Array.isArray(sourceWords)
    ? sourceWords
    : String(sourceWords || "").split(/\s+/).filter(Boolean);
  const total = Math.max(1, Math.floor(options.contextWords) || 25);
  const shared = new Set(Array.from(options.sharedWords || [], (word) => cleanWord(word)));
  const at = Number.isFinite(matchOffset)
    ? Math.min(Math.max(0, Math.floor(matchOffset)), Math.max(0, all.length - 1))
    : 0;

  let start = 0;
  if (all.length > total) {
    start = Math.min(Math.max(0, at - Math.floor(total / 3)), all.length - total);
  }
  const end = Math.min(all.length, start + total);
  const words = all.slice(start, end).map((text) => ({ text, shared: shared.has(cleanWord(text)) }));

  return {
    text: words.map((word) => word.text).join(" "),
    start,
    end,
    totalWords: all.length,
    words,
    pages: options.boundaries ? pagesForWordOffsets(options.boundaries, [at]) : [],
  };
}
