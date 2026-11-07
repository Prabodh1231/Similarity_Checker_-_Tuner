/**
 * Whether a PDF contains any image. Image objects are streams, and streams
 * can never sit inside a compressed object stream, so their "/Subtype /Image"
 * is always readable in the raw bytes. Asking PDF.js page by page would
 * decode every image (about 0.25 s per scanned page).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} chunk - Bytes decoded at a time (smaller only in tests)
 * @returns {boolean}
 */
export function containsImages(buffer, chunk = 1 << 20) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder("latin1");
  const overlap = 32; // so a marker split across two chunks is still seen
  for (let at = 0; at < bytes.length; at += chunk) {
    const text = decoder.decode(bytes.subarray(Math.max(0, at - overlap), at + chunk));
    if (/\/Subtype\s*\/Image\b/.test(text)) return true;
  }
  return false;
}
