import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PALETTE,
  COLOUR_BLIND_SAFE_PALETTE,
  PATTERNS,
  paletteFor,
  patternFor,
  sourceColor,
  sourceLabel,
  sourceMark,
} from "../js/palette.js";

// WCAG relative luminance and contrast, as a reader's text would meet them
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test("source labels are 1-based numbers in list order", () => {
  assert.equal(sourceLabel(0), "1");
  assert.equal(sourceLabel(1), "2");
  assert.equal(sourceLabel(9), "10");
  assert.equal(sourceLabel(-3), "1");
});

test("each palette colour keeps dark text at WCAG AA contrast", () => {
  for (const palette of [DEFAULT_PALETTE, COLOUR_BLIND_SAFE_PALETTE]) {
    assert.ok(palette.length >= 7);
    assert.equal(new Set(palette).size, palette.length);
    for (const colour of palette) {
      assert.ok(contrast(colour, "#1f1b16") >= 4.5, `${colour} on ink`);
    }
  }
});

test("sourceColor serves the palettes, then keeps generating light colours", () => {
  assert.equal(paletteFor(false), DEFAULT_PALETTE);
  assert.equal(paletteFor(true), COLOUR_BLIND_SAFE_PALETTE);
  assert.equal(sourceColor(0), DEFAULT_PALETTE[0]);
  assert.equal(sourceColor(0, true), COLOUR_BLIND_SAFE_PALETTE[0]);
  assert.equal(sourceColor(2, true), COLOUR_BLIND_SAFE_PALETTE[2]);
  const beyond = sourceColor(DEFAULT_PALETTE.length);
  assert.match(beyond, /^hsl\(\d+ 85% 78%\)$/);
  assert.equal(sourceColor(DEFAULT_PALETTE.length), beyond); // deterministic
  assert.notEqual(sourceColor(DEFAULT_PALETTE.length + 1), beyond);
});

test("patterns are distinct, subtle and cycle for more sources than patterns", () => {
  assert.ok(PATTERNS.length >= 6);
  assert.equal(new Set(PATTERNS.map((p) => p.id)).size, PATTERNS.length);
  for (const pattern of PATTERNS) {
    assert.match(pattern.backgroundImage, /gradient/);
    for (const [, alpha] of pattern.backgroundImage.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)) {
      assert.ok(Number(alpha) <= 0.2, `${pattern.id} alpha ${alpha}`);
    }
  }
  assert.equal(patternFor(0), PATTERNS[0]);
  assert.equal(patternFor(PATTERNS.length), PATTERNS[0]);
  assert.equal(patternFor(PATTERNS.length + 1), PATTERNS[1]);
  assert.equal(patternFor(-1), PATTERNS[0]);
});

test("sourceMark bundles label, colour and pattern for one source", () => {
  const mark = sourceMark(1, { colourBlindSafe: true });
  assert.equal(mark.label, "2");
  assert.equal(mark.color, COLOUR_BLIND_SAFE_PALETTE[1]);
  assert.equal(mark.pattern, PATTERNS[1]);
  assert.equal(sourceMark(1, { patterns: false }).pattern, null);
  assert.equal(sourceMark(0).color, DEFAULT_PALETTE[0]);
});
