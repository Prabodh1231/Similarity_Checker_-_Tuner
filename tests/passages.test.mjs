import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPageBoundaries,
  pageForWordOffset,
  pagesForWordOffsets,
  formatPagesList,
  groupWordIds,
  buildExcerpt,
} from "../js/passages.js";

test("page boundaries record word offsets per page, including empty pages", () => {
  const boundaries = buildPageBoundaries([3, 0, 2]);
  assert.deepEqual(boundaries, [
    { page: 1, start: 0, end: 3 },
    { page: 2, start: 3, end: 3 },
    { page: 3, start: 3, end: 5 },
  ]);
  assert.equal(pageForWordOffset(boundaries, 0), 1);
  assert.equal(pageForWordOffset(boundaries, 2), 1);
  assert.equal(pageForWordOffset(boundaries, 3), 3); // page 2 has no words
  assert.equal(pageForWordOffset(boundaries, 4), 3);
  assert.equal(pageForWordOffset(boundaries, 99), 3); // past the end: last page with words
  assert.equal(pageForWordOffset([], 0), null);
  assert.equal(pageForWordOffset(boundaries, Number.NaN), null);
});

test("pagesForWordOffsets is sorted and distinct", () => {
  const boundaries = buildPageBoundaries([2, 2, 2]);
  assert.deepEqual(pagesForWordOffsets(boundaries, [5, 0, 3, 5]), [1, 2, 3]);
  assert.deepEqual(pagesForWordOffsets(boundaries, []), []);
});

test("formatPagesList compresses consecutive pages", () => {
  assert.equal(formatPagesList([4]), "p. 4");
  assert.equal(formatPagesList([8, 3, 4, 5, 3]), "pp. 3–5, 8");
  assert.equal(formatPagesList([]), "");
});

test("groupWordIds groups consecutive ids only by default", () => {
  assert.deepEqual(groupWordIds([7, 1, 2, 3, 5]), [
    { start: 1, end: 3, ids: [1, 2, 3] },
    { start: 5, end: 5, ids: [5] },
    { start: 7, end: 7, ids: [7] },
  ]);
  assert.equal(groupWordIds([1, 3], 2).length, 1);
});

test("buildExcerpt returns about 25 words around the match with shared words flagged", () => {
  const source = Array.from({ length: 40 }, (_, i) => `w${i}`);
  const excerpt = buildExcerpt(source, 20, { sharedWords: new Set(["w20", "w21"]) });
  assert.equal(excerpt.words.length, 25);
  assert.ok(excerpt.start <= 20 && excerpt.end > 20);
  assert.equal(excerpt.words.find((word) => word.text === "w20").shared, true);
  assert.equal(excerpt.words.find((word) => word.text === "w19").shared, false);
  assert.equal(excerpt.text, excerpt.words.map((word) => word.text).join(" "));
});

test("buildExcerpt accepts joined text, clamps the match and reports its page", () => {
  const boundaries = buildPageBoundaries([2, 2]);
  const excerpt = buildExcerpt("one two three four", 3, { boundaries, contextWords: 2 });
  assert.deepEqual(excerpt.pages, [2]);
  assert.equal(excerpt.totalWords, 4);
  assert.ok(excerpt.end <= 4);
});
