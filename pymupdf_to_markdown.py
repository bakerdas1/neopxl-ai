#!/usr/bin/env python3
"""Extract per-page markdown from a PDF using PyMuPDF4LLM.

Outputs JSON to stdout:
  {
    "pages": ["<page 1 markdown>", ...],
    "total": N,
    "totalChars": X,
    "avgCharsPerPage": Y,
    "scannedPages": [i, ...],       // 0-based indices classified as image-only
    "scannedShare": 0.0-1.0,
    "usable": true|false            // false => too sparse / scanned to be useful
  }

Exits non-zero on any fatal error.
"""
import json
import sys

try:
    import pymupdf
except ImportError:
    pymupdf = None

try:
    import pymupdf4llm
except ImportError:
    pymupdf4llm = None


MIN_CHARS_FOR_TEXT = 30
MIN_IMAGE_COVERAGE_FOR_SCANNED = 0.25
MIN_AVG_CHARS = 30


def page_signal(page):
    rect = page.rect
    page_area = (rect.width * rect.height) or 1.0

    words = page.get_text("words")
    char_count = sum(len(w[4]) for w in words)

    images = page.get_image_info(hashes=False, xrefs=False)
    img_area = sum(
        (img["bbox"][2] - img["bbox"][0]) * (img["bbox"][3] - img["bbox"][1])
        for img in images if img.get("bbox")
    )
    image_coverage = min(img_area / page_area, 1.0)

    return char_count, image_coverage


def main(pdf_path):
    if pymupdf is None or pymupdf4llm is None:
        print(json.dumps({"error": "pymupdf/pymupdf4llm is not installed. Run: pip3 install -r requirements.txt"}), file=sys.stderr)
        sys.exit(2)

    chunks = pymupdf4llm.to_markdown(pdf_path, page_chunks=True, use_ocr=False)
    doc = pymupdf.open(pdf_path)

    pages = []
    scanned = []
    for i, chunk in enumerate(chunks):
        content = chunk.get("text") or ""
        char_count, image_coverage = page_signal(doc[i])
        if char_count < MIN_CHARS_FOR_TEXT and image_coverage >= MIN_IMAGE_COVERAGE_FOR_SCANNED:
            scanned.append(i)
        pages.append(content)

    total = len(pages)
    total_chars = sum(len(p) for p in pages)
    avg = total_chars / total if total else 0
    scanned_share = len(scanned) / total if total else 0

    usable = avg >= MIN_AVG_CHARS and scanned_share < 1.0

    print(json.dumps({
        "pages": pages,
        "total": total,
        "totalChars": total_chars,
        "avgCharsPerPage": round(avg, 2),
        "scannedPages": scanned,
        "scannedShare": round(scanned_share, 4),
        "usable": usable,
    }))
    sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: python3 pymupdf_to_markdown.py <pdfPath>"}), file=sys.stderr)
        sys.exit(2)
    try:
        main(sys.argv[1])
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
