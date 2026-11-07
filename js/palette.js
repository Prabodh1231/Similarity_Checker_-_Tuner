/**
 * Source colours, labels and patterns. Pure definitions and lookups with no
 * DOM access, so the report can tell sources apart without relying on colour
 * alone and the choices can be tested in Node.
 *
 * Every colour is a light tint, so the dark manuscript text (#1f1b16) keeps
 * at least WCAG AA contrast (4.5:1) through it. Patterns are drawn in a
 * translucent dark ink over the tint for the same reason.
 */

export const INK = "#1f1b16";

export const DEFAULT_PALETTE = Object.freeze([
  "#ffe14d", "#8fe3a6", "#93ccff", "#ffadc9", "#ffb870", "#c9adff",
  "#6fded2", "#dbe86a", "#ff9f8f", "#a9b9ff", "#f2bdf7", "#b5dd9a",
  "#ffd09e", "#9adbf2", "#e9c08f", "#d7f27e",
]);

// Light tints of the Okabe-Ito palette: orange, sky blue, bluish green,
// yellow, blue, vermillion, reddish purple and grey.
export const COLOUR_BLIND_SAFE_PALETTE = Object.freeze([
  "#f2c14e",
  "#9fd3ef",
  "#86cdb5",
  "#f7ef8a",
  "#93b8d8",
  "#f49e73",
  "#dfa8c8",
  "#cccccc",
]);

export const COLOR_BLIND_SAFE_PALETTE = COLOUR_BLIND_SAFE_PALETTE;

export const PATTERNS = Object.freeze([
  Object.freeze({
    id: "diagonal",
    label: "Diagonal stripes",
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(31, 27, 22, 0.16) 0 1px, transparent 1px 7px)",
  }),
  Object.freeze({
    id: "dots",
    label: "Dots",
    backgroundImage:
      "radial-gradient(circle, rgba(31, 27, 22, 0.18) 1px, transparent 1.3px)",
    backgroundSize: "7px 7px",
  }),
  Object.freeze({
    id: "crosshatch",
    label: "Crosshatch",
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(31, 27, 22, 0.10) 0 1px, transparent 1px 7px), " +
      "repeating-linear-gradient(-45deg, rgba(31, 27, 22, 0.10) 0 1px, transparent 1px 7px)",
  }),
  Object.freeze({
    id: "vertical",
    label: "Vertical stripes",
    backgroundImage:
      "repeating-linear-gradient(90deg, rgba(31, 27, 22, 0.15) 0 1px, transparent 1px 7px)",
  }),
  Object.freeze({
    id: "horizontal",
    label: "Horizontal stripes",
    backgroundImage:
      "repeating-linear-gradient(0deg, rgba(31, 27, 22, 0.15) 0 1px, transparent 1px 7px)",
  }),
  Object.freeze({
    id: "diagonal-reverse",
    label: "Reverse diagonal stripes",
    backgroundImage:
      "repeating-linear-gradient(-45deg, rgba(31, 27, 22, 0.16) 0 1px, transparent 1px 7px)",
  }),
]);

const indexOf = (index) => {
  const n = Math.floor(Number(index));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The palette in use: colour-blind safe when asked, otherwise the default. */
export function paletteFor(colourBlindSafe = false) {
  return colourBlindSafe ? COLOUR_BLIND_SAFE_PALETTE : DEFAULT_PALETTE;
}

/**
 * Colour for the n-th source (0-based). Beyond the curated palette the hue
 * steps round the wheel at the same light tint, so contrast is kept.
 */
export function sourceColor(index, colourBlindSafe = false) {
  const palette = paletteFor(colourBlindSafe);
  const n = indexOf(index);
  if (n < palette.length) return palette[n];
  const hue = Math.round((n * 137.508) % 360);
  return `hsl(${hue} 85% 78%)`;
}

/** Short label for the n-th source (0-based): "1", "2", "3", … */
export function sourceLabel(index) {
  return String(indexOf(index) + 1);
}

/** Pattern for the n-th source (0-based), cycling through PATTERNS. */
export function patternFor(index) {
  return PATTERNS[indexOf(index) % PATTERNS.length];
}

/** Everything that identifies one source without relying on colour alone. */
export function sourceMark(index, { colourBlindSafe = false, patterns = true } = {}) {
  return {
    label: sourceLabel(index),
    color: sourceColor(index, colourBlindSafe),
    pattern: patterns ? patternFor(index) : null,
  };
}
