import {
  cleanWord,
  isReferenceHeadingBlock,
  quoteFlagForPart,
} from "./matching.js";

/**
 * Converts a DOCX file to sanitised HTML with Mammoth.
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function docxToHtml(file) {
  const buffer = await file.arrayBuffer();
  const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
  return value;
}

/**
 * Builds the readable manuscript and its word list from Mammoth HTML.
 * Every word becomes a <span class="w" data-i="id">, so highlights can be
 * switched on and off without rebuilding the document. Whitespace between
 * two words in the same run becomes a <span class="gap"> so a highlight can
 * bridge it when both neighbours belong to the same source.
 *
 * @param {string} html
 * @returns {{
 *   root: HTMLElement,
 *   words: Array<{id: number, content: string}>,
 *   spans: HTMLElement[],
 *   gaps: Array<{el: HTMLElement, left: number, right: number}>,
 * }}
 */
export function buildManuscript(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitize(doc.body);

  const root = document.createElement("div");
  root.className = "manuscript-body";
  root.append(...Array.from(doc.body.childNodes, (node) => document.importNode(node, true)));

  // The first reference-list heading (a heading element, or a short
  // standalone bold paragraph) excludes everything from there on. Words
  // keep the flag so the score can honour the setting without a re-read.
  const isBoldParagraph = (el) => {
    const boldText = Array.from(el.querySelectorAll("strong, b"))
      .map((node) => cleanWord(node.textContent))
      .join(" ")
      .replace(/\s+/g, "");
    return Boolean(boldText) && boldText === cleanWord(el.textContent).replace(/\s+/g, "");
  };
  const referenceStartElement =
    Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, p")).find((el) =>
      isReferenceHeadingBlock({
        tagName: el.tagName,
        text: el.textContent,
        bold: el.tagName === "P" && isBoldParagraph(el),
      })
    ) || null;

  const words = [];
  const spans = [];
  const gaps = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let pendingGap = null; // whitespace after a word, waiting for the next word (may cross nodes)
  let afterWord = false; // whether the previous emitted token was a word
  let inReferenceList = false; // everything from the reference heading on
  const quoteState = { open: false }; // inside “…” / "…" quotation marks

  for (const node of textNodes) {
    if (referenceStartElement && referenceStartElement.contains(node)) inReferenceList = true;
    let inQuotedBlock = false;
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
      if (el.tagName === "BLOCKQUOTE" || el.tagName === "Q") inQuotedBlock = true;
    }
    const fragment = document.createDocumentFragment();

    for (const part of node.data.split(/(\s+)/)) {
      if (!part) continue;

      if (/^\s+$/.test(part)) {
        if (pendingGap) {
          pendingGap.el.textContent += part;
        } else if (afterWord) {
          const el = document.createElement("span");
          el.className = "gap";
          el.textContent = part;
          el.dataset.left = words.length - 1;
          pendingGap = { el, left: words.length - 1 };
          fragment.append(el);
        } else {
          fragment.append(part);
        }
        afterWord = false;
        continue;
      }

      const quotedByMarks = quoteFlagForPart(part, quoteState);
      const content = cleanWord(part);
      if (!/[\p{L}\p{N}]/u.test(content)) {
        pendingGap = null;
        afterWord = false;
        fragment.append(part);
        continue;
      }

      const id = words.length;
      const span = document.createElement("span");
      span.className = "w";
      span.dataset.i = id;
      span.textContent = part;
      words.push({
        id,
        content,
        ...(inReferenceList ? { inReferenceList: true } : {}),
        ...(inQuotedBlock || quotedByMarks ? { inQuotedText: true } : {}),
      });
      spans.push(span);
      fragment.append(span);
      afterWord = true;

      if (pendingGap) {
        gaps.push({ ...pendingGap, right: id });
        pendingGap = null;
      }
    }
    node.replaceWith(fragment);
  }

  return { root, words, spans, gaps };
}

// Mammoth emits plain markup, but links come from the file, so strip
// anything that could run script.
function sanitize(body) {
  for (const el of body.querySelectorAll("script, style, iframe, object, embed")) {
    el.remove();
  }
  for (const el of body.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name === "srcset" ||
        name === "formaction" ||
        name === "xlink:href"
      ) {
        el.removeAttribute(attr.name);
      } else if (name === "src" && !/^(data:|blob:)/.test(value)) {
        // Linked (remote) images would fetch from the network; embedded ones stay
        el.removeAttribute(attr.name);
      } else if (name === "href" && !/^(https?:|mailto:|#)/.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
}
