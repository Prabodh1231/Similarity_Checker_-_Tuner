/**
 * Remembers OCR text per PDF page in this browser's IndexedDB, keyed by the
 * file's SHA-256, so a scanned PDF is only read once. Everything stays on
 * this device. If storage is unavailable (private window, blocked), every
 * call quietly behaves as an empty cache.
 */

const DB_NAME = "similarity-check-ocr";
const STORE = "pages";
// Change when the OCR engine, language data or render resolution changes
const ENGINE_TAG = "tesseract6-eng-200dpi";

let dbPromise = null;
let openConnection = null;

function openDb() {
  if (!dbPromise) {
    const promise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        openConnection = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    dbPromise = promise;
    // A failed open must not poison every later attempt in this session
    promise.catch(() => {
      if (dbPromise === promise) dbPromise = null;
    });
  }
  return dbPromise;
}

const pageKey = (hash, page) => `${hash}|${page}|${ENGINE_TAG}`;

/**
 * Hex SHA-256 of a file's bytes, or null where Web Crypto is unavailable
 * (pages served over plain http from another machine).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string|null>}
 */
export async function fileHash(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads saved OCR text for some pages of a file.
 * @param {string|null} hash
 * @param {number[]} pages - 1-based page numbers
 * @returns {Promise<Record<number, string>>} only the pages found
 */
export async function readCachedPages(hash, pages) {
  if (!hash || pages.length === 0) return {};
  try {
    const db = await openDb();
    const store = db.transaction(STORE).objectStore(STORE);
    const found = {};
    await Promise.all(
      pages.map(
        (page) =>
          new Promise((resolve) => {
            const request = store.get(pageKey(hash, page));
            request.onsuccess = () => {
              if (typeof request.result === "string") found[page] = request.result;
              resolve();
            };
            request.onerror = () => resolve();
          })
      )
    );
    return found;
  } catch {
    return {};
  }
}

/**
 * Saves one page's OCR text.
 * @param {string|null} hash
 * @param {number} page
 * @param {string} text
 */
export async function saveCachedPage(hash, page, text) {
  if (!hash) return;
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(text, pageKey(hash, page));
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch {
    // Not saved: the page is simply read again next time
  }
}

/** Deletes all saved OCR text. */
export async function clearOcrCache() {
  // Close our own connection first, or the delete is blocked by it and the
  // saved text survives while the UI claims it was forgotten.
  if (openConnection) {
    openConnection.close();
    openConnection = null;
  }
  dbPromise = null;
  if (!globalThis.indexedDB) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Saved OCR text could not be deleted because another tab is using it."));
  });
}
