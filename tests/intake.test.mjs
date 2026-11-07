import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEntries, fromFileList, sortIncoming, splitPath } from "../js/intake.js";

// Stand-ins for the browser's FileSystemEntry API. Folders return their
// children a few at a time, as Chrome does (100 per readEntries call).
function fileEntry(fullPath) {
  const name = fullPath.split("/").at(-1);
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (resolve) => resolve(new File(["x"], name)),
  };
}

function dirEntry(fullPath, children, batchSize = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.split("/").at(-1),
    fullPath,
    createReader() {
      let at = 0;
      return {
        readEntries(resolve) {
          const batch = children.slice(at, at + batchSize);
          at += batch.length;
          setTimeout(() => resolve(batch));
        },
      };
    },
  };
}

const paths = (items) => items.map((i) => i.path).sort();

test("walks nested folders and reads every batch", async () => {
  const library = dirEntry("/library", [
    fileEntry("/library/a.pdf"),
    fileEntry("/library/b.pdf"),
    fileEntry("/library/c.pdf"), // third item: only reached by a second readEntries call
    dirEntry("/library/2023", [
      fileEntry("/library/2023/d.pdf"),
      dirEntry("/library/2023/deep", [fileEntry("/library/2023/deep/e.PDF")]),
    ]),
    dirEntry("/library/empty", []),
  ]);

  const items = await collectEntries([library, fileEntry("/loose.pdf")]);
  assert.deepEqual(paths(items), [
    "library/2023/d.pdf",
    "library/2023/deep/e.PDF",
    "library/a.pdf",
    "library/b.pdf",
    "library/c.pdf",
    "loose.pdf",
  ]);
  assert.equal(items.find((i) => i.path === "loose.pdf").inFolder, false);
  assert.ok(items.filter((i) => i.path !== "loose.pdf").every((i) => i.inFolder));
});

test("hidden folders are not entered", async () => {
  const root = dirEntry("/papers", [
    fileEntry("/papers/keep.pdf"),
    dirEntry("/papers/.git", [fileEntry("/papers/.git/blob.pdf")]),
  ]);
  assert.deepEqual(paths(await collectEntries([root])), ["papers/keep.pdf"]);
});

test("an unreadable file is left out instead of stopping the walk", async () => {
  const broken = { ...fileEntry("/papers/locked.pdf"), file: (_, reject) => reject(new Error("denied")) };
  const root = dirEntry("/papers", [broken, fileEntry("/papers/ok.pdf")]);
  assert.deepEqual(paths(await collectEntries([root])), ["papers/ok.pdf"]);
});

test("sortIncoming: PDFs at any depth, manuscript only when loose", () => {
  const item = (path, inFolder) => ({ file: new File(["x"], path.split("/").at(-1)), path, inFolder });
  const sorted = sortIncoming([
    item("draft-v1.docx", false),
    item("draft-v2.docx", false),
    item("lib/notes.docx", true),
    item("lib/x.pdf", true),
    item("lib/sub/y.pdf", true),
    item("lib/readme.txt", true),
    item("lib/._x.pdf", true),
    item("lib/.DS_Store", true),
    item("other/z.pdf", true),
    item("loose.pdf", false),
  ]);

  assert.equal(sorted.manuscript.path, "draft-v2.docx");
  assert.equal(sorted.extraManuscripts, 1);
  assert.deepEqual(paths(sorted.pdfs), ["lib/sub/y.pdf", "lib/x.pdf", "loose.pdf", "other/z.pdf"]);
  assert.equal(sorted.pdfsFromFolders, 3);
  assert.equal(sorted.folders, 2);
  assert.equal(sorted.skipped, 2); // notes.docx and readme.txt; hidden files are silent
});

test("fromFileList keeps the folder picker's relative paths", () => {
  const picked = new File(["x"], "y.pdf");
  Object.defineProperty(picked, "webkitRelativePath", { value: "lib/sub/y.pdf" });
  const loose = new File(["x"], "z.pdf");
  assert.deepEqual(
    fromFileList([picked, loose]).map(({ path, inFolder }) => [path, inFolder]),
    [["lib/sub/y.pdf", true], ["z.pdf", false]]
  );
});

test("splitPath", () => {
  assert.deepEqual(splitPath("lib/2023/smith.pdf"), { dir: "lib/2023/", base: "smith.pdf" });
  assert.deepEqual(splitPath("smith.pdf"), { dir: "", base: "smith.pdf" });
});
