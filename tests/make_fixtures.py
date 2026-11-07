"""Builds sample files for trying the app: one manuscript and five PDFs.

Standard library only. Run from the project folder:
    python tests/make_fixtures.py
Files are written to tests/fixtures/.
"""

import random
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).parent / "fixtures"

COASTAL = [
    "Rising sea levels now pose a serious threat to coastal infrastructure across the developing world.",
    "Storm surges that once arrived every fifty years are projected to occur every decade by the middle of the century.",
    "Municipal drainage networks were designed for a climate that no longer exists, and retrofitting them is costly.",
    "Mangrove restoration has emerged as a low cost buffer that also supports fisheries and stores carbon.",
    "Insurance markets are already withdrawing from the most exposed districts, leaving households to carry the risk alone.",
    "Managed retreat remains politically difficult because it asks communities to abandon land their families have held for generations.",
]

URBAN = [
    "Compact neighbourhoods with mixed land use reduce car dependence and shorten the daily commute.",
    "Transit oriented development concentrates housing within walking distance of frequent rail and bus services.",
    "Green roofs lower building temperatures in summer and slow the release of rainwater into overloaded sewers.",
    "Participatory budgeting gives residents direct control over a share of public spending in their district.",
    "Zoning reform that permits small apartment buildings has increased housing supply without large public subsidies.",
]

SHARED = (
    "Adaptation planning works best when engineers, ecologists and residents agree on which places "
    "must be defended and which can be allowed to change."
)

BOOK_SENTENCE = (
    "The archive of tidal gauge readings kept by harbour masters since the eighteen forties "
    "offers the longest continuous record of local sea level change."
)

# Only readable with OCR: these appear in the manuscript and in scanned pages
SCANNED_WETLANDS = (
    "Coastal wetlands absorb wave energy and can reduce flood depths behind them "
    "by a measurable margin during moderate storms."
)
SCANNED_FISHERS = (
    "Local knowledge from fishing cooperatives often anticipates erosion hot spots "
    "years before formal surveys detect them."
)

FILLER_VOCAB = (
    "account history river market winter garden letter village season record merchant "
    "voyage harvest charter council ledger parish weather journey bridge lantern orchard "
    "quarry tavern meadow chapel granary foundry estate canal mill ferry lighthouse "
    "custom treaty survey colony frontier cargo festival cathedral harbour"
).split()


# ---------- PDF ----------

def pdf_bytes(pages):
    """Writes a minimal PDF. Each page is either a list of text lines (set in
    Helvetica, with a real text layer) or a scanned page {"jpeg", "w", "h"}
    (an image only, no text layer)."""
    objects = []

    def add(body):
        objects.append(body)
        return len(objects)

    def stream(header, data):
        return header % len(data) + b"\nstream\n" + data + b"\nendstream"

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = len(objects) + 1
    objects.append(None)  # pages tree, filled in below
    page_ids = []

    for page in pages:
        if isinstance(page, dict):
            image = add(stream(
                b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
                % (page["w"], page["h"])
                + b"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>",
                page["jpeg"],
            ))
            content = add(stream(b"<< /Length %d >>", b"q 595 0 0 842 0 0 cm /Im0 Do Q"))
            resources = b"<< /XObject << /Im0 %d 0 R >> >>" % image
        else:
            ops = ["BT", "/F1 11 Tf", "14 TL", "56 780 Td"]
            for line in page:
                safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                ops.append(f"({safe}) Tj T*")
            ops.append("ET")
            content = add(stream(b"<< /Length %d >>", "\n".join(ops).encode("latin-1")))
            resources = b"<< /Font << /F1 %d 0 R >> >>" % font
        page_ids.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R >>"
            % (pages_id, resources, content)
        ))

    kids = " ".join(f"{p} 0 R" for p in page_ids).encode()
    objects[pages_id - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_ids))
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, catalog, xref)
    return bytes(out)


def paginate(text, width=92, per_page=52):
    lines, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        lines.append(line)
    return [lines[i:i + per_page] for i in range(0, len(lines), per_page)] or [[]]


def write_pdf(name, text):
    (OUT / name).write_bytes(pdf_bytes(paginate(text)))


def scanned_page(text, seed):
    """Renders text as a 200 DPI greyscale photo of a page: slightly tilted,
    speckled, JPEG-compressed, with no text layer. Needs Pillow."""
    from io import BytesIO
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    rng = random.Random(seed)
    w, h = 1654, 2339  # A4 at 200 DPI
    page = Image.new("L", (w, h), 246)
    draw = ImageDraw.Draw(page)
    try:
        font = ImageFont.truetype("times.ttf", 32)
    except OSError:
        font = ImageFont.load_default(size=32)

    y = 180
    for line in paginate(text, width=78, per_page=10_000)[0]:
        draw.text((170, y), line, fill=rng.randint(20, 45), font=font)
        y += 46
    for _ in range(2500):  # dust and toner specks
        x, yy = rng.randrange(w), rng.randrange(h)
        draw.point((x, yy), fill=rng.randint(120, 200))

    page = page.rotate(rng.uniform(-0.6, 0.6), fillcolor=246, resample=Image.BICUBIC)
    page = page.filter(ImageFilter.GaussianBlur(0.6))
    out = BytesIO()
    page.save(out, "JPEG", quality=72)
    return {"jpeg": out.getvalue(), "w": w, "h": h}


def filler_prose(rng, words):
    """Plausible-looking sentences from the filler vocabulary."""
    out = []
    while len(out) < words:
        sentence = [rng.choice(FILLER_VOCAB) for _ in range(rng.randint(8, 16))]
        sentence[0] = sentence[0].capitalize()
        out.extend(sentence)
        out[-1] += "."
    return " ".join(out[:words])


# ---------- DOCX ----------

def docx_bytes(blocks):
    """blocks: list of (style, text) where style is 'Heading1' or None."""
    body = []
    for style, text in blocks:
        props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        body.append(
            f'<w:p>{props}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
        )
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {ns}><w:body>{"".join(body)}</w:body></w:document>'
    styles = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {ns}>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
        "</w:styles>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    path = OUT / "_tmp.docx"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", styles)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
    data = path.read_bytes()
    path.unlink()
    return data


def write_scanned_fixtures(rng):
    """PDFs with image-only pages, for trying OCR. Skipped without Pillow."""
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow not installed: skipping scanned PDFs (pip install pillow)")
        return

    # Fully scanned; the wetlands sentence is on page 2, and page 3 is a
    # blank sheet (speckles only) that OCR should skip
    (OUT / "scanned-wetlands-report.pdf").write_bytes(pdf_bytes([
        scanned_page(f"Wetland Buffers: Field Notes. {filler_prose(rng, 260)}", seed=1),
        scanned_page(f"{filler_prose(rng, 120)} {SCANNED_WETLANDS} {filler_prose(rng, 120)}", seed=2),
        scanned_page("", seed=4),
    ]))

    # Page 1 has a text layer, page 2 is a scan: only page 2 needs OCR
    (OUT / "mixed-text-and-scan.pdf").write_bytes(pdf_bytes([
        paginate(" ".join(["Community Monitoring."] + URBAN[:2]))[0],
        scanned_page(f"{filler_prose(rng, 150)} {SCANNED_FISHERS} {filler_prose(rng, 100)}", seed=3),
    ]))

    # 30 scanned pages of prose with nothing from the manuscript: for timing OCR
    bench = OUT / "ocr-benchmark"
    bench.mkdir(exist_ok=True)
    (bench / "scanned-30-pages.pdf").write_bytes(pdf_bytes([
        scanned_page(filler_prose(rng, 380), seed=100 + i) for i in range(30)
    ]))


def main():
    OUT.mkdir(exist_ok=True)
    rng = random.Random(3)

    # Source A: the coastal paper, verbatim sentences plus the shared one
    write_pdf("coastal-risk-review.pdf", " ".join(
        ["Coastal Risk Review."] + COASTAL[:3] + [SHARED] + COASTAL[3:]
        + ["Further work is needed on financing mechanisms for small island states."] * 3
    ))

    # Source B: urban planning, also containing the shared sentence
    write_pdf("urban-form-and-resilience.pdf", " ".join(
        ["Urban Form and Resilience."] + URBAN[:2] + [SHARED] + URBAN[2:]
    ))

    # Source C: a 60,000-word book with one sentence buried around word 41,000
    filler = [rng.choice(FILLER_VOCAB) for _ in range(60_000)]
    filler[41_000:41_000] = BOOK_SENTENCE.split()
    write_pdf("maritime-history-volume-2.pdf", " ".join(filler))

    # Source D: unrelated
    write_pdf("medieval-music-notes.pdf", (
        "Plainchant developed in monasteries where the daily office structured time. "
        "Neumes recorded the shape of a melody long before staff notation fixed exact pitch. "
    ) * 20)

    # Source E: no text at all, like a scanned image
    (OUT / "scanned-handout.pdf").write_bytes(pdf_bytes([[]]))

    # The manuscript mixes copied, reworded and original writing
    reworded = (
        "Across the developing world, coastal infrastructure faces a serious threat "
        "because sea levels are rising now."
    )
    blocks = [
        ("Heading1", "Living With Water: A Planning Brief"),
        (None, "This brief was written for the regional council and draws on several recent studies."),
        ("Heading2", "The problem"),
        (None, f"{reworded} {COASTAL[1]} Our own survey of the harbour district found similar patterns."),
        (None, f"{COASTAL[3]} The council has piloted two small sites along the estuary."),
        ("Heading2", "Responses"),
        (None, f"{URBAN[2]} {URBAN[4]}"),
        (None, f"{SHARED} We recommend a public workshop before any designation is made."),
        ("Heading2", "Evidence base"),
        (None, f"{BOOK_SENTENCE} We have digitised these readings for the estuary."),
        (None, f"{SCANNED_WETLANDS} {SCANNED_FISHERS}"),
        (None, "Everything else in this section is our own analysis of rainfall, tide and complaint data from the last twelve years, and none of it was drawn from published sources."),
    ]
    (OUT / "planning-brief.docx").write_bytes(docx_bytes(blocks))

    write_scanned_fixtures(rng)

    # A folder tree for trying folder picks and drops: PDFs at several depths,
    # two different PDFs with the same name, and files that should be skipped
    library = OUT / "library"
    files = {
        "coastal/coastal-risk-review.pdf": OUT / "coastal-risk-review.pdf",
        "coastal/archives/1800s/maritime-history-volume-2.pdf": OUT / "maritime-history-volume-2.pdf",
        "planning/urban-form-and-resilience.pdf": OUT / "urban-form-and-resilience.pdf",
        "planning/misc/medieval-music-notes.pdf": OUT / "medieval-music-notes.pdf",
    }
    for rel, src in files.items():
        (library / rel).parent.mkdir(parents=True, exist_ok=True)
        (library / rel).write_bytes(src.read_bytes())
    # Same file name, different content and folder
    (library / "coastal/summary.pdf").write_bytes(pdf_bytes(paginate(" ".join(COASTAL[3:]))))
    (library / "planning/summary.pdf").write_bytes(pdf_bytes(paginate(" ".join(URBAN[2:]))))
    (library / "planning/old-draft.docx").write_bytes(docx_bytes([(None, "An old draft.")]))
    (library / "reading-list.txt").write_text("Papers to read this term.\n")
    (library / ".DS_Store").write_bytes(b"\0")

    for path in sorted(OUT.rglob("*")):
        if path.is_file():
            print(f"{path.relative_to(OUT).as_posix():58} {path.stat().st_size:>9,} bytes")


if __name__ == "__main__":
    main()
