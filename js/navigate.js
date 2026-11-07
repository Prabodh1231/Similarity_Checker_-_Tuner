/**
 * Pure logic for the match navigator: which passages can be visited, where
 * "next" and "previous" go, how the current position survives a re-render,
 * and which keyboard shortcuts apply. No DOM access, so it can be tested in
 * Node. Passage grouping itself is reused from passages.js, exactly as the
 * exporter groups flagged words into passages.
 */
import { groupWordIds } from "./passages.js";

/**
 * Groups flagged word ids into navigable passages, in manuscript order.
 * @param {Iterable<number>} flaggedIds
 * @returns {Array<{start: number, end: number, ids: number[], index: number}>}
 */
export function buildPassages(flaggedIds = []) {
  return groupWordIds(Array.from(flaggedIds || [])).map((group, index) => ({
    ...group,
    index,
  }));
}

/** Keeps an index inside a passage list, or -1 when there is nowhere to go. */
export function clampPassageIndex(index, count) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  if (!Number.isFinite(index)) return -1;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/**
 * Chooses the current passage after the list has been recomputed (a source
 * switched off, a rematch, a settings change). Prefers the passage starting
 * at the remembered anchor word, then the next passage after it, then the
 * last one; without an anchor it keeps the numeric position, clamped.
 * @param {Array<{start: number}>} passages
 * @param {number} preferredIndex - Previous index, or -1 for none yet
 * @param {number|null} anchorStart - Start word id of the previous passage
 */
export function resolvePassageIndex(passages = [], preferredIndex = -1, anchorStart = null) {
  const list = Array.from(passages || []);
  if (list.length === 0) return -1;
  if (anchorStart !== null && anchorStart !== undefined && Number.isFinite(Number(anchorStart))) {
    const anchor = Number(anchorStart);
    const exact = list.findIndex((passage) => passage.start === anchor);
    if (exact >= 0) return exact;
    const next = list.findIndex((passage) => passage.start > anchor);
    return next >= 0 ? next : list.length - 1;
  }
  if (!Number.isFinite(preferredIndex) || preferredIndex < 0) return -1;
  return clampPassageIndex(preferredIndex, list.length);
}

/** Index after `current`, wrapping; from no position it goes to the first. */
export function nextPassageIndex(current, count) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  if (!Number.isFinite(current) || current < 0 || current >= count) return 0;
  return (current + 1) % count;
}

/** Index before `current`, wrapping; from no position it goes to the last. */
export function previousPassageIndex(current, count) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  if (!Number.isFinite(current) || current < 0 || current >= count) return count - 1;
  return (current - 1 + count) % count;
}

/** Which passage a word belongs to, or -1. */
export function passageIndexForWord(passages = [], wordId) {
  const id = Number(wordId);
  if (!Number.isFinite(id)) return -1;
  return Array.from(passages || []).findIndex((passage) =>
    Array.isArray(passage.ids)
      ? passage.ids.includes(id)
      : passage.start <= id && id <= passage.end
  );
}

/** The live counter text for the navigator. */
export function matchCounterText(index, count) {
  if (!Number.isFinite(count) || count <= 0) return "No matches";
  if (!Number.isFinite(index) || index < 0) {
    return `${count} match${count === 1 ? "" : "es"}`;
  }
  return `Match ${index + 1} of ${count}`;
}

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Maps a keydown to a navigator action, or null. Escape always closes the
 * tooltip; n/j and p/k navigate only outside form fields and without
 * modifiers, so typing and browser shortcuts are never hijacked.
 * @param {string} key
 * @param {{tagName?: string, isContentEditable?: boolean, ctrlKey?: boolean,
 *   metaKey?: boolean, altKey?: boolean}} context
 * @returns {"next"|"previous"|"close"|null}
 */
export function shortcutAction(key, context = {}) {
  if (key === "Escape") return "close";
  if (context.ctrlKey || context.metaKey || context.altKey) return null;
  if (context.isContentEditable) return null;
  if (FORM_TAGS.has(String(context.tagName || "").toUpperCase())) return null;
  const pressed = String(key || "").toLowerCase();
  if (pressed === "n" || pressed === "j") return "next";
  if (pressed === "p" || pressed === "k") return "previous";
  return null;
}

/** Scroll behaviour honouring prefers-reduced-motion. */
export function scrollBehavior(prefersReducedMotion) {
  return prefersReducedMotion ? "auto" : "smooth";
}
