/**
 * Matching core. Pure functions with no DOM access, shared by the page,
 * the PDF worker and the Node tests.
 *
 * Two signals decide which manuscript words are flagged for a source
 * (numbers are the defaults; every one is adjustable in DEFAULT_SETTINGS):
 *  A. Window overlap: a 13-word manuscript window and an 11-word source
 *     window share at least 8 distinct words (order ignored).
 *  B. Trigram overlap: 3-word runs (stop words removed) shared with a source
 *     that shares at least 21 of them overall. A shared trigram flags words
 *     only when exactly one source contains it.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  docxWindow: 13, // manuscript window, in words
  pdfWindow: 11, // source window, in words
  windowMatch: 8, // distinct words a pair of windows must share
  phrases: true, // use trigram (phrase) overlap at all
  phraseGate: 21, // trigrams a source must share before any count
  phrasesUniqueOnly: true, // credit only trigrams found in exactly one source
  dropLoneStopWords: true, // unflag stop words with no flagged neighbour
  moderateFrom: 10, // overall % where "moderate" starts
  highFrom: 25, // overall % where "high" starts
});

const clampInt = (value, low, high, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

/**
 * Fills gaps from the defaults and keeps every setting in a usable range:
 * the words-to-match can never exceed either window, and "high" never
 * starts below "moderate".
 * @param {Partial<typeof DEFAULT_SETTINGS>} input
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const d = DEFAULT_SETTINGS;
  const docxWindow = clampInt(s.docxWindow, 5, 40, d.docxWindow);
  const pdfWindow = clampInt(s.pdfWindow, 5, 40, d.pdfWindow);
  const moderateFrom = clampInt(s.moderateFrom, 0, 100, d.moderateFrom);
  const highFrom = Math.max(moderateFrom, clampInt(s.highFrom, moderateFrom, 100, d.highFrom));
  return {
    docxWindow,
    pdfWindow,
    windowMatch: clampInt(s.windowMatch, 2, Math.min(docxWindow, pdfWindow), d.windowMatch),
    phrases: Boolean(s.phrases),
    phraseGate: clampInt(s.phraseGate, 1, 200, d.phraseGate),
    phrasesUniqueOnly: Boolean(s.phrasesUniqueOnly),
    dropLoneStopWords: Boolean(s.dropLoneStopWords),
    moderateFrom,
    highFrom,
  };
}

/** Whether every setting is at its default. */
export const isDefaultSettings = (settings) =>
  Object.keys(DEFAULT_SETTINGS).every((key) => settings[key] === DEFAULT_SETTINGS[key]);

/**
 * Normalises text for comparison: strips accents and punctuation,
 * collapses whitespace and lowercases.
 * @param {string} text
 * @returns {string}
 */
export function cleanWord(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]|[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Stored in cleaned form ("don't" -> "dont") so they match cleaned text
export const STOP_WORDS = new Set(
  [
    "a", "about", "above", "after", "again", "against", "ain", "al", "all",
    "am", "an", "and", "any", "are", "aren", "aren't", "as", "at", "be",
    "because", "been", "before", "being", "below", "between", "both", "but",
    "by", "can", "couldn", "couldn't", "d", "did", "didn", "didn't", "do",
    "does", "doesn", "doesn't", "doing", "don", "don't", "down", "during",
    "each", "et", "few", "for", "from", "further", "had", "hadn", "hadn't",
    "has", "hasn", "hasn't", "have", "haven", "haven't", "having", "he",
    "her", "here", "hers", "herself", "him", "himself", "his", "how", "i",
    "if", "in", "into", "is", "isn", "isn't", "it", "it's", "its", "itself",
    "just", "ll", "m", "ma", "me", "mightn", "mightn't", "more", "most",
    "mustn", "mustn't", "my", "myself", "needn", "needn't", "no", "nor",
    "not", "now", "o", "of", "off", "on", "once", "only", "or", "other",
    "our", "ours", "ourselves", "out", "over", "own", "re", "s", "same",
    "shan", "shan't", "she", "she's", "should", "should've", "shouldn",
    "shouldn't", "so", "some", "such", "t", "than", "that", "that'll", "the",
    "their", "theirs", "them", "themselves", "there", "these", "they", "this",
    "those", "through", "to", "too", "under", "until", "up", "ve", "very",
    "was", "wasn", "wasn't", "we", "were", "weren", "weren't", "what", "when",
    "where", "which", "while", "who", "whom", "why", "will", "with", "won",
    "won't", "wouldn", "wouldn't", "y", "you", "you'd", "you'll", "you're",
    "you've", "your", "yours", "yourself", "yourselves",
  ].map(cleanWord)
);

/**
 * Splits raw source text into cleaned words.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeText(text) {
  // Join words split by a line-break hyphen ("exam-\nple" -> "example")
  const cleaned = cleanWord(text.replace(/(\p{L})-\s+(\p{L})/gu, "$1$2"));
  return cleaned ? cleaned.split(" ") : [];
}

/**
 * Cuts the manuscript into overlapping windows. Each window keeps its
 * distinct words and, for each, the ids of every occurrence in the window,
 * so a repeated word ("by the middle of the century") is flagged each time.
 * A manuscript shorter than one window becomes a single window.
 * @param {Array<{id: number, content: string}>} words
 * @param {number} size
 * @returns {Array<{contents: string[], ids: number[][]}>}
 */
export function createDocxWindows(words, size = DEFAULT_SETTINGS.docxWindow) {
  if (words.length === 0) return [];
  const windows = [];
  const last = Math.max(0, words.length - size);

  for (let start = 0; start <= last; start++) {
    const slot = new Map(); // content -> index in contents
    const contents = [];
    const ids = [];
    const end = Math.min(start + size, words.length);
    for (let i = start; i < end; i++) {
      const { id, content } = words[i];
      const at = slot.get(content);
      if (at === undefined) {
        slot.set(content, contents.length);
        contents.push(content);
        ids.push([id]);
      } else {
        ids[at].push(id);
      }
    }
    windows.push({ contents, ids });
  }
  return windows;
}

/**
 * Builds an index from each word to the manuscript windows that contain it.
 * @param {Array<{contents: string[]}>} windows
 * @returns {Map<string, number[]>}
 */
export function buildWindowIndex(windows) {
  const index = new Map();
  windows.forEach((window, w) => {
    for (const term of window.contents) {
      let postings = index.get(term);
      if (!postings) {
        postings = [];
        index.set(term, postings);
      }
      postings.push(w);
    }
  });
  return index;
}

/**
 * Slides a window over every position of the source text and collects the
 * ids of manuscript words in any manuscript window sharing at least
 * `threshold` distinct words with it.
 *
 * Overlap counts are updated incrementally: when the source window moves by
 * one word, only the manuscript windows containing the word that left or the
 * word that entered change. Every position is checked; nothing is sampled.
 *
 * @param {Array<{contents: string[], ids: number[][]}>} windows
 * @param {Map<string, number[]>} index - From buildWindowIndex
 * @param {string[]} sourceWords - Cleaned source words
 * @param {number} windowSize - Source window size
 * @param {number} threshold - Minimum number of shared distinct words
 * @returns {number[]} Distinct manuscript word ids that matched
 */
export function findWindowMatches(
  windows,
  index,
  sourceWords,
  windowSize = DEFAULT_SETTINGS.pdfWindow,
  threshold = DEFAULT_SETTINGS.windowMatch
) {
  const overlap = new Int32Array(windows.length);
  const inWindow = new Map(); // source word -> occurrences in current window
  const active = new Set(); // manuscript windows at or above the threshold
  const matched = new Set();

  const add = (word) => {
    const count = inWindow.get(word) || 0;
    inWindow.set(word, count + 1);
    if (count > 0) return; // repeated word, already counted
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (++overlap[w] === threshold) active.add(w);
    }
  };

  const remove = (word) => {
    const count = inWindow.get(word);
    if (count > 1) {
      inWindow.set(word, count - 1);
      return;
    }
    inWindow.delete(word);
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (overlap[w]-- === threshold) active.delete(w);
    }
  };

  // Flag the manuscript words the current source window actually shares
  const collect = () => {
    for (const w of active) {
      const { contents, ids } = windows[w];
      for (let i = 0; i < contents.length; i++) {
        if (inWindow.has(contents[i])) for (const id of ids[i]) matched.add(id);
      }
    }
  };

  const firstEnd = Math.min(windowSize, sourceWords.length);
  for (let i = 0; i < firstEnd; i++) add(sourceWords[i]);
  collect();

  for (let i = windowSize; i < sourceWords.length; i++) {
    remove(sourceWords[i - windowSize]);
    add(sourceWords[i]);
    collect();
  }

  return Array.from(matched);
}

/**
 * Builds the manuscript's trigrams (stop words removed). Every occurrence of a
 * repeated trigram is kept, so all copies can be highlighted.
 * @param {Array<{id: number, content: string}>} words
 * @returns {Map<string, number[]>} trigram text -> distinct word ids
 */
export function buildDocxTrigrams(words) {
  const content = words.filter((w) => !STOP_WORDS.has(w.content));
  const trigrams = new Map();

  for (let i = 0; i + 2 < content.length; i++) {
    const text = `${content[i].content} ${content[i + 1].content} ${content[i + 2].content}`;
    let ids = trigrams.get(text);
    if (!ids) {
      ids = new Set();
      trigrams.set(text, ids);
    }
    ids.add(content[i].id).add(content[i + 1].id).add(content[i + 2].id);
  }

  const result = new Map();
  for (const [text, ids] of trigrams) result.set(text, Array.from(ids));
  return result;
}

/**
 * Builds the set of a source's trigrams (stop words removed).
 * @param {string[]} sourceWords
 * @returns {Set<string>}
 */
export function buildTrigramSet(sourceWords) {
  const content = sourceWords.filter((w) => !STOP_WORDS.has(w));
  const set = new Set();
  for (let i = 0; i + 2 < content.length; i++) {
    set.add(`${content[i]} ${content[i + 1]} ${content[i + 2]}`);
  }
  return set;
}

/**
 * Lists the manuscript trigrams a source shares, or none when it shares
 * fewer than `threshold` of them.
 * @param {Iterable<string>} docxTrigramTexts
 * @param {Set<string>} sourceTrigrams
 * @param {number} threshold
 * @returns {string[]}
 */
export function findSharedTrigrams(
  docxTrigramTexts,
  sourceTrigrams,
  threshold = DEFAULT_SETTINGS.phraseGate
) {
  const shared = [];
  for (const text of docxTrigramTexts) {
    if (sourceTrigrams.has(text)) shared.push(text);
  }
  return shared.length >= threshold ? shared : [];
}

/**
 * Combines both signals into one set of flagged word ids per source.
 * By default a shared trigram adds its words only when exactly one source
 * has it, so phrasing common to the field is not credited to every source.
 * @param {Array<{windowIds: number[], sharedTrigrams: string[]}>} results
 * @param {Map<string, number[]>} docxTrigrams - From buildDocxTrigrams
 * @param {{uniqueOnly?: boolean}} options - false credits every shared trigram
 * @returns {Array<Set<number>>}
 */
export function combineMatches(results, docxTrigrams, { uniqueOnly = true } = {}) {
  const frequency = new Map();
  for (const result of results) {
    for (const text of new Set(result.sharedTrigrams)) {
      frequency.set(text, (frequency.get(text) || 0) + 1);
    }
  }

  return results.map((result) => {
    const ids = new Set(result.windowIds);
    for (const text of result.sharedTrigrams) {
      if (uniqueOnly && frequency.get(text) !== 1) continue;
      for (const id of docxTrigrams.get(text) || []) ids.add(id);
    }
    return ids;
  });
}

/**
 * Everything after the per-source matching, for a given set of settings:
 * combine both signals, then optionally drop lone stop words.
 * @param {Array<{windowIds: number[], sharedTrigrams: string[]}>} results
 * @param {Map<string, number[]>} docxTrigrams
 * @param {Array<{content: string}>} words - Manuscript words, indexed by id
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Array<Set<number>>}
 */
export function finalizeMatches(results, docxTrigrams, words, settings) {
  const combined = combineMatches(
    settings.phrases ? results : results.map((r) => ({ ...r, sharedTrigrams: [] })),
    docxTrigrams,
    { uniqueOnly: settings.phrasesUniqueOnly }
  );
  return settings.dropLoneStopWords
    ? combined.map((ids) => dropStrayStopWords(ids, words))
    : combined;
}

/**
 * Removes flagged stop words with no flagged neighbour. A window match marks
 * every shared word, so a lone "the" or "of" next to a copied passage can be
 * swept in; inside a passage its neighbours keep it.
 * @param {Set<number>} ids - Flagged word ids for one source
 * @param {Array<{content: string}>} words - Manuscript words, indexed by id
 * @returns {Set<number>}
 */
export function dropStrayStopWords(ids, words) {
  const kept = new Set();
  for (const id of ids) {
    const isStray =
      STOP_WORDS.has(words[id].content) && !ids.has(id - 1) && !ids.has(id + 1);
    if (!isStray) kept.add(id);
  }
  return kept;
}

/**
 * Works out what to show for the current on/off state of the sources.
 * Sources are in priority order: a word found in several enabled sources is
 * attributed to the first of them.
 * @param {Array<Set<number>>} sourceIds
 * @param {boolean[]} enabled
 * @param {number} totalWords
 * @returns {{
 *   primary: Map<number, number>,
 *   flaggedWords: number,
 *   overallPercent: number,
 *   sourcePercent: Array<number|null>,
 *   attributedPercent: number[],
 * }}
 */
export function summarize(sourceIds, enabled, totalWords) {
  const primary = new Map();
  sourceIds.forEach((ids, s) => {
    if (!enabled[s]) return;
    for (const id of ids) {
      if (!primary.has(id)) primary.set(id, s);
    }
  });

  const attributed = new Array(sourceIds.length).fill(0);
  for (const s of primary.values()) attributed[s]++;

  const percent = (count) => (totalWords ? (count / totalWords) * 100 : 0);
  return {
    primary,
    flaggedWords: primary.size,
    overallPercent: percent(primary.size),
    sourcePercent: sourceIds.map((ids, s) => (enabled[s] ? percent(ids.size) : null)),
    attributedPercent: attributed.map(percent),
  };
}

/**
 * Names the level for an overall percentage.
 * @param {number} percent
 * @param {{moderateFrom: number, highFrom: number}} settings
 * @returns {"low"|"moderate"|"high"}
 */
export function similarityLevel(percent, settings = DEFAULT_SETTINGS) {
  if (percent < settings.moderateFrom) return "low";
  if (percent < settings.highFrom) return "moderate";
  return "high";
}
