import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { containsImages } from "../js/scan-detect.js";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const bytes = (text) => new TextEncoder().encode(text);

test("finds an image marker with or without a space", () => {
  assert.ok(containsImages(bytes("<< /Type /XObject /Subtype /Image /Width 10 >>")));
  assert.ok(containsImages(bytes("<</Subtype/Image/Width 10>>")));
  assert.ok(!containsImages(bytes("<< /Subtype /ImageMaskish >> /Type /Font")));
  assert.ok(!containsImages(bytes("plain text with no images")));
});

test("finds a marker split across a chunk boundary", () => {
  const text = "x".repeat(95) + "/Subtype /Image /Width 10" + "y".repeat(100);
  assert.ok(containsImages(bytes(text), 100)); // boundary falls inside the marker
});

test("real fixtures: scans have images, text PDFs and the blank handout do not", (t) => {
  if (!existsSync(fixture("scanned-wetlands-report.pdf"))) {
    t.skip("run python tests/make_fixtures.py first");
    return;
  }
  assert.ok(containsImages(readFileSync(fixture("scanned-wetlands-report.pdf"))));
  assert.ok(containsImages(readFileSync(fixture("mixed-text-and-scan.pdf"))));
  assert.ok(!containsImages(readFileSync(fixture("coastal-risk-review.pdf"))));
  assert.ok(!containsImages(readFileSync(fixture("scanned-handout.pdf"))));
});
