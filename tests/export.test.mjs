import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExportData,
  serializeExportJson,
  serializeExportCsv,
  escapeCsvCell,
} from "../js/export.js";

const input = {
  manuscriptName: "draft.docx",
  date: new Date("2024-05-06T07:08:09.000Z"),
  settings: { windowMatch: 6 },
  overallPercent: 12.345,
  countedWords: 90,
  ignoredWords: 10,
  totalWords: 100,
  sources: [
    { name: "smith.pdf", enabled: true, percent: 10, flaggedWords: 9, pages: [3, 1, 3] },
    { name: "jones.pdf", enabled: false, percent: null, flaggedWords: 4, pages: [2] },
  ],
  matchedPassages: [
    {
      manuscriptExcerpt: "rising sea levels",
      startWordIndex: 42,
      sources: [{ name: "smith.pdf", pages: [1, 3] }],
    },
  ],
};

test("buildExportData normalises the JSON shape", () => {
  const data = buildExportData(input);
  assert.equal(data.manuscriptName, "draft.docx");
  assert.equal(data.date, "2024-05-06T07:08:09.000Z");
  assert.equal(data.settings.windowMatch, 6);
  assert.equal(data.settings.ignoreReferenceList, true); // defaults fill the rest
  assert.equal(data.overallSimilarityPercent, 12.35);
  assert.equal(data.countedWords, 90);
  assert.equal(data.ignoredWords, 10);
  assert.equal(data.level, "moderate");
  assert.deepEqual(data.sources[0], {
    name: "smith.pdf",
    enabled: true,
    percent: 10,
    flaggedWords: 9,
    pages: [1, 3],
  });
  assert.equal(data.sources[1].enabled, false);
  assert.equal(data.sources[1].percent, null);
  assert.deepEqual(data.matchedPassages[0], {
    manuscriptExcerpt: "rising sea levels",
    startWordIndex: 42,
    sources: [{ name: "smith.pdf", pages: [1, 3] }],
  });
  // Serialising the built data again changes nothing but the date default
  assert.deepEqual(buildExportData(data), data);
});

test("JSON export is parseable and carries passages and settings", () => {
  const parsed = JSON.parse(serializeExportJson(input));
  assert.equal(parsed.manuscriptName, "draft.docx");
  assert.equal(parsed.matchedPassages[0].sources[0].pages.join(","), "1,3");
});

test("CSV has only a header then one row per source, RFC 4180 quoted", () => {
  const csv = serializeExportCsv({
    ...input,
    sources: [
      { name: 'weird, "quoted".pdf', enabled: true, percent: 5, flaggedWords: 2, pages: [1, 2] },
      { name: "off.pdf", enabled: false, percent: 7, flaggedWords: 3, pages: [] },
    ],
  });
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "name,enabled,percent,flagged_words,pages");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '"weird, ""quoted"".pdf",true,5.00,2,"1, 2"');
  assert.equal(lines[2], "off.pdf,false,0.00,3,");
});

test("CSV cells are guarded against formula injection", () => {
  assert.equal(escapeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(escapeCsvCell("+cmd"), "'+cmd");
  assert.equal(escapeCsvCell("-2+3"), "'-2+3");
  assert.equal(escapeCsvCell("@handle"), "'@handle");
  // The apostrophe goes first, so the cell can't start a formula even with leading spaces
  assert.equal(escapeCsvCell("  =SUM(A1)"), "'  =SUM(A1)");
  assert.equal(escapeCsvCell("plain.pdf"), "plain.pdf");
  const csv = serializeExportCsv({
    manuscriptName: "d.docx",
    sources: [{ name: "=evil.pdf", enabled: true, percent: 1, flaggedWords: 1, pages: [1] }],
  });
  assert.ok(csv.split("\r\n")[1].startsWith("'=evil.pdf,true,"));
});
