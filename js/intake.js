/**
 * Turns whatever the user picked or dropped (loose files, folders, nested
 * subfolders) into a flat list of candidate files, then sorts it into the
 * manuscript, the source PDFs and what was skipped. No DOM access, so it can
 * be tested in Node with stand-in file system entries.
 */

export const isDocx = (file) => /\.docx$/i.test(file.name);
export const isPdf = (file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf";

// Dotfiles and macOS "._name" resource forks travel inside folders but are not documents
export const isHidden = (name) => name.startsWith(".");

/**
 * An incoming file and where it came from.
 * @typedef {{file: File, path: string, inFolder: boolean}} Incoming
 */

/**
 * Reads a dropped file or folder, descending into every subfolder.
 * @param {FileSystemEntry} entry - From DataTransferItem.webkitGetAsEntry()
 * @param {Incoming[]} out - Files found are appended here
 * @param {boolean} inFolder - Whether this entry sits inside a dropped folder
 */
export async function walkEntry(entry, out, inFolder = false) {
  if (entry.isFile) {
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\/+/, "") || file.name, inFolder });
    } catch {
      // Unreadable (permissions, removed meanwhile): leave it out
    }
    return;
  }

  if (entry.isDirectory) {
    if (isHidden(entry.name)) return;
    const reader = entry.createReader();
    // readEntries hands back folders in batches (100 at a time in Chrome),
    // so keep asking until it returns an empty batch
    for (;;) {
      let batch;
      try {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      } catch {
        return;
      }
      if (batch.length === 0) return;
      for (const child of batch) await walkEntry(child, out, true);
    }
  }
}

/**
 * Reads every dropped entry.
 * @param {FileSystemEntry[]} entries
 * @returns {Promise<Incoming[]>}
 */
export async function collectEntries(entries) {
  const out = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

/**
 * Wraps files from an <input type="file">. With the folder picker each file
 * carries its path inside the chosen folder.
 * @param {FileList|File[]} files
 * @returns {Incoming[]}
 */
export function fromFileList(files) {
  return Array.from(files, (file) => ({
    file,
    path: file.webkitRelativePath || file.name,
    inFolder: Boolean(file.webkitRelativePath),
  }));
}

/**
 * Sorts incoming files.
 * - A .docx picked or dropped on its own becomes the manuscript (the last one
 *   wins). A .docx inside a folder is skipped: folders are for sources.
 * - Every PDF, loose or at any depth in a folder, becomes a source.
 * - Hidden files are ignored silently; anything else is counted as skipped.
 * @param {Incoming[]} items
 * @returns {{
 *   manuscript: Incoming|null,
 *   extraManuscripts: number,
 *   pdfs: Incoming[],
 *   pdfsFromFolders: number,
 *   folders: number,
 *   skipped: number,
 * }}
 */
export function sortIncoming(items) {
  const manuscripts = [];
  const pdfs = [];
  const folders = new Set();
  let skipped = 0;

  for (const item of items) {
    if (isHidden(item.file.name)) continue;
    if (item.inFolder) folders.add(item.path.split("/")[0]);

    if (isPdf(item.file)) pdfs.push(item);
    else if (isDocx(item.file) && !item.inFolder) manuscripts.push(item);
    else skipped++;
  }

  return {
    manuscript: manuscripts.at(-1) || null,
    extraManuscripts: Math.max(0, manuscripts.length - 1),
    pdfs,
    pdfsFromFolders: pdfs.filter((item) => item.inFolder).length,
    folders: folders.size,
    skipped,
  };
}

/**
 * Splits "Literature/2023/smith.pdf" into its folder and file name.
 * @param {string} path
 * @returns {{dir: string, base: string}}
 */
export function splitPath(path) {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}
