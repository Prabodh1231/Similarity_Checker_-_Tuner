# Private Similarity Check

(Working title; the product name and icon are still to be decided.)

Compares one Word manuscript (`.docx`) with any number of source PDFs, entirely
in the browser. Nothing is uploaded: PDFs are read with PDF.js and the
manuscript with Mammoth, inside the tab.

## Running it

The page uses module Web Workers, which browsers block on `file://`, so serve
the folder:

```bash
python -m http.server 5510
```

Then open <http://localhost:5510>. (`npx serve .` works too.)

To try it without your own files, run `python tests/make_fixtures.py`. It writes a
sample manuscript, text PDFs, a nested `library/` folder and, if Pillow is
installed, scanned PDFs (including a 30-page one in `ocr-benchmark/`) to
`tests/fixtures/`.

## Adding files

- **Manuscript:** one `.docx`, dropped or chosen on its own.
- **Sources:** PDFs, chosen as files, or as a whole folder with **choose a
  folder**, or dragged in as files or folders. Folders are searched through
  every subfolder.
  - Only PDFs are taken from folders. Other files are counted and reported as
    skipped. A `.docx` inside a folder is not used as the manuscript.
  - Hidden files and folders (`.DS_Store`, `._name.pdf`, `.git/`) are ignored.
  - A file reached twice (on its own and inside a folder) is listed once.
  - Sources are shown with their folder path, so two `summary.pdf` files from
    different folders can be told apart.
- Chrome's folder picker asks to confirm an "upload". Nothing is sent anywhere;
  the files are read in the tab.

## Scanned PDFs (OCR)

Pages with no text layer, such as photocopies and scans, are read with
Tesseract, running in the tab like everything else.

1. **Find.** While reading text layers, a page counts as scanned when it has
   fewer than 30 letters and the PDF contains images. The image check reads
   the file's raw bytes for `/Subtype /Image` rather than asking PDF.js, which
   would decode every image. That makes the first pass 0.4 s instead of 7.7 s
   for 30 scanned pages.
2. **Ask.** If scanned pages are found, the progress screen says how many and
   estimates the time, using the speed measured on this computer after the
   first run. **Skip them** lists fully scanned PDFs as "Scanned, not read".
3. **Read.** Pages are drawn at 200 DPI and recognised by up to 8 OCR engines
   in parallel (2 on machines with 4 GB of memory or less). Large PDFs are split
   into page ranges so one long scan uses every engine. Blank sheets are
   detected and skipped (about 0.2 s instead of several seconds).
4. **Remember.** Each page's text is saved in this browser's IndexedDB, keyed
   by the file's SHA-256, so a scan is only ever read once. **Forget it** in
   the footer deletes it all.

The OCR engine is loaded only when it's first needed. It adds about 7 MB the
first time: a 3.9 MB engine build for the CPU, plus 2.9 MB of English data
from `js/vendor/tesseract/`. Nothing is fetched from a CDN.

Measured on a 20-core / 16 GB Windows machine, with clean 200 DPI test scans
of about 380 words per page:

| | Time |
|---|---|
| One page, one engine | about 3–4 s |
| 30 pages, 4 engines | 34.6 s (1.15 s per page) |
| 24 pages, 8 engines | 18.8 s (0.79 s per page) |
| Word accuracy, 1,520 words | 100% |
| Starting the engine | about 0.8 s |

Runs in a background or hidden browser tab can be about 3× slower. Real
photocopies, small print and handwriting will be less accurate; the matcher
tolerates a few wrong words because a match needs 8 shared words out of 11.

## Using the report

- **Hover** any highlight to see the PDF(s) it was found in. On touch screens,
  tap it.
- **Switch a source off** with its toggle. Its highlights disappear, its
  percentage is replaced by "off", and the overall score is recalculated
  without it. Words it shared with another source switch to that source's
  colour.
- **Hover a source row** to light up only that source's passages; click its
  name to jump to its first match. Sources partly read by OCR say so under
  their name.
- **Save as PDF** prints the report (switched-off sources are left out).

## Tune matching (settings sandbox)

The same **Tune matching** panel appears on the start screen, above
**Compare**, and in the report, where the **Tune matching** button under the
score opens it. You can adjust it before a comparison or afterwards. In the
report, every change re-runs only the matching on the text already read, so it
takes tens of milliseconds; PDFs aren't read again and OCR isn't repeated. The
app keeps each source's cleaned text after a comparison for this.

| Setting | Default | Effect |
|---|---|---|
| Words that must match | 8 | Distinct words a draft stretch and a source stretch must share. Never more than the smaller stretch. |
| Draft stretch | 13 words | Manuscript window size (5–40) |
| Source stretch | 11 words | PDF window size (5–40) |
| Phrase check | on | Use 3-word phrase (trigram) overlap at all |
| Phrases a source must share | 21 | Below this, a source's shared phrases are ignored |
| Only phrases unique to one source | on | Off credits a shared phrase to every source containing it |
| Ignore lone common words | on | Unmark a lone "the"/"of" next to a real passage |
| Moderate from / High from | 10% / 25% | Where the level labels change; applied instantly, no re-match |

- Sources keep their colour and on/off state while you adjust.
- In the report, with custom settings, the panel shows what the **default
  settings would give**, for the same sources switched on. That comparison is
  hidden on the start screen, where no comparison has run yet.
- Settings are remembered in this browser and used for future comparisons.
  The start screen's panel (and its note) says when custom settings are on,
  with a one-click way back.
- With custom settings, the report shows (and prints) a note listing them, so a
  shared report always says how it was made.
- Settings are checked and clamped (`normalizeSettings` in `js/matching.js`),
  so saved values from an older version or impossible combinations can't break
  matching.

## How matching works

All steps live in [js/matching.js](js/matching.js).

1. **Clean.** Text is lowercased and stripped of accents and punctuation.
2. **Window overlap (main signal).** The manuscript is cut into overlapping
   13-word windows and each PDF into 11-word windows. Repeated words count once,
   but every occurrence is remembered. When a manuscript window and a PDF window
   share at least **8 distinct words, in any order**, the shared manuscript
   words are flagged.
   - Every position of every PDF is checked. An index from each word to the
     manuscript windows containing it, plus running overlap counts that change
     only for the word leaving and the word entering as the PDF window slides,
     keeps this fast: about 90 ms for a 100,000-word PDF against a 5,000-word
     manuscript.
3. **Phrase overlap.** With stop words removed, every 3-word phrase (trigram) is
   compared. A PDF that shares at least **21** trigrams with the manuscript is
   credited with the trigrams that **no other PDF** shares, so phrasing that is
   common across the field isn't attributed to everyone.
4. **Tidy.** A flagged stop word ("the", "of"…) with no flagged neighbour is
   dropped. Window matching sweeps these in from next to a real passage.
5. **Score.** Overall similarity = flagged words ÷ manuscript words, counting
   only the sources switched on. Below 10% is low, below 25% moderate, and
   above that high. Each source's own percentage can overlap with another's,
   because one passage can appear in several PDFs. The bar under the score
   gives each word to one source only, so its segments add up to the total.

## Changes from the original checker

| Original | Here |
|---|---|
| PDFs over 10,000 words were sampled, skipping most of the text | Every window of every PDF is checked |
| Each PDF window flagged only the first matching manuscript window | All matching windows are flagged, so a passage copied twice is marked twice |
| A word repeated inside a window was flagged once, leaving holes ("by the middle of ___ century") | Every occurrence is flagged |
| Trigrams only affected results when more than 15 PDFs were uploaded | Always used |
| A repeated trigram highlighted only its first position; trigram keys could collide ("ab"+"c" = "a"+"bc") | Every position; keys are space-separated |
| Lone stop words next to a passage were highlighted | Dropped |
| Hover showed only the first matching file | Hover lists every source that contains the word |
| Fixed batches of 2 PDFs per worker with polling | A worker pool that takes PDFs from a queue and reuses the manuscript index |
| Scanned PDFs gave no text | Read with OCR, on request |

Known limits: it finds copied and lightly reworded text, not paraphrase or
translation. OCR reads English only. A PDF with no text and no images (a blank
document) is listed as unreadable.

## Files

```
index.html               page markup
css/styles.css           styles (light and dark, print)
js/app.js                file intake, worker pool, report, toggles, tooltip
js/intake.js             walks dropped folders, sorts files into manuscript/sources/skipped
js/manuscript.js         DOCX → HTML → one <span> per word
js/matcher.worker.js     PDF text extraction, OCR of scanned pages and matching, off the main thread
js/matching.js           the matching algorithm (pure functions)
js/ocr-cache.js          remembers OCR text per page in IndexedDB
js/scan-detect.js        finds whether a PDF contains images, from its raw bytes
js/vendor/               PDF.js 4.6.82, Mammoth, Tesseract.js 6.0.1 (core 6.1.2, English data)
tests/matching.test.mjs  unit tests, including exact checks against brute force across settings
tests/intake.test.mjs    folder walking (nested, batched, unreadable files) and sorting
tests/scan-detect.test.mjs  image detection, including real fixture PDFs
tests/make_fixtures.py   builds sample files (scanned ones need Pillow)
```

Run the tests with `npm test` (Node 18+, no dependencies).
