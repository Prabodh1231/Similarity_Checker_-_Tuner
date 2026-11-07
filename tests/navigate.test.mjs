import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassages,
  clampPassageIndex,
  resolvePassageIndex,
  nextPassageIndex,
  previousPassageIndex,
  passageIndexForWord,
  matchCounterText,
  shortcutAction,
  scrollBehavior,
} from "../js/navigate.js";

test("buildPassages groups flagged ids like the exporter, in order", () => {
  assert.deepEqual(buildPassages([7, 1, 2, 3, 5]), [
    { start: 1, end: 3, ids: [1, 2, 3], index: 0 },
    { start: 5, end: 5, ids: [5], index: 1 },
    { start: 7, end: 7, ids: [7], index: 2 },
  ]);
  assert.deepEqual(buildPassages([]), []);
  assert.deepEqual(buildPassages(new Set([4, 2, 3])).map((p) => p.ids), [[2, 3, 4]]);
});

test("next and previous wrap, and start sensibly from no position", () => {
  assert.equal(nextPassageIndex(-1, 3), 0);
  assert.equal(nextPassageIndex(0, 3), 1);
  assert.equal(nextPassageIndex(2, 3), 0);
  assert.equal(previousPassageIndex(-1, 3), 2);
  assert.equal(previousPassageIndex(0, 3), 2);
  assert.equal(previousPassageIndex(2, 3), 1);
  assert.equal(nextPassageIndex(0, 0), -1);
  assert.equal(previousPassageIndex(0, 0), -1);
});

test("resolvePassageIndex keeps the position sensible after a re-render", () => {
  const passages = buildPassages([10, 11, 30, 50, 51]);
  // Same passage still there: stay on it, wherever it moved to
  assert.equal(resolvePassageIndex(passages, 0, 30), 1);
  // Current passage switched off: land on the next one after it
  assert.equal(resolvePassageIndex(buildPassages([10, 50]), 1, 30), 1);
  // Everything after the anchor gone: land on the last passage
  assert.equal(resolvePassageIndex(buildPassages([10]), 2, 30), 0);
  // No anchor: keep the numeric position, clamped to the shorter list
  assert.equal(resolvePassageIndex(passages, 9, null), 2);
  assert.equal(resolvePassageIndex(passages, -1, null), -1);
  assert.equal(resolvePassageIndex([], 2, 30), -1);
  assert.equal(clampPassageIndex(5, 3), 2);
  assert.equal(clampPassageIndex(-2, 3), 0);
  assert.equal(clampPassageIndex(1, 0), -1);
});

test("passageIndexForWord and the counter text", () => {
  const passages = buildPassages([1, 2, 3, 9]);
  assert.equal(passageIndexForWord(passages, 2), 0);
  assert.equal(passageIndexForWord(passages, 9), 1);
  assert.equal(passageIndexForWord(passages, 5), -1);
  assert.equal(matchCounterText(-1, 0), "No matches");
  assert.equal(matchCounterText(-1, 1), "1 match");
  assert.equal(matchCounterText(-1, 12), "12 matches");
  assert.equal(matchCounterText(2, 12), "Match 3 of 12");
});

test("shortcuts navigate only outside form fields; Escape always closes", () => {
  assert.equal(shortcutAction("n", { tagName: "BODY" }), "next");
  assert.equal(shortcutAction("j", { tagName: "BUTTON" }), "next");
  assert.equal(shortcutAction("p", { tagName: "DIV" }), "previous");
  assert.equal(shortcutAction("K", { tagName: "A" }), "previous");
  assert.equal(shortcutAction("n", { tagName: "INPUT" }), null);
  assert.equal(shortcutAction("n", { tagName: "textarea" }), null);
  assert.equal(shortcutAction("n", { tagName: "SELECT" }), null);
  assert.equal(shortcutAction("n", { tagName: "DIV", isContentEditable: true }), null);
  assert.equal(shortcutAction("n", { tagName: "BODY", ctrlKey: true }), null);
  assert.equal(shortcutAction("n", { tagName: "BODY", metaKey: true }), null);
  assert.equal(shortcutAction("x", { tagName: "BODY" }), null);
  assert.equal(shortcutAction("Escape", { tagName: "INPUT" }), "close");
  assert.equal(shortcutAction("Escape", { tagName: "BODY" }), "close");
});

test("scroll behaviour respects reduced motion", () => {
  assert.equal(scrollBehavior(true), "auto");
  assert.equal(scrollBehavior(false), "smooth");
});
