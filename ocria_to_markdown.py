#!/usr/bin/env python3
"""
Parse a PDF to markdown using OCRia-nano-1 (via LiteParse) and emit the same
JSON shape the server expects from pymupdf: {pages: [...], usable: bool,
scannedShare: number}.

LiteParse emits tables as raw HTML (<table><tr><td>…), which tokenizes very
badly (every tag becomes a token). We rewrite those into compact markdown pipe
tables so the extraction model's prompt stays small — otherwise the 8B model's
CPU prefill balloons past the request timeout.

The LiteParse `lit` binary path can be overridden with LITEPARSE_BIN.
"""
import sys
import json
import os
import re
import subprocess

LIT = os.environ.get("LITEPARSE_BIN", "/tmp/opencode/lpenv/bin/lit")

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<(th|td)[^>]*>(.*?)</\1>", re.S | re.I)
_TABLE_RE = re.compile(r"<table[^>]*>.*?</table>", re.S | re.I)


def _normalize_cell(raw):
    c = re.sub(r"<br\s*/?>", " ", raw, flags=re.I)
    c = re.sub(r"<[^>]+>", "", c)
    c = c.replace("|", "\\|")
    c = re.sub(r"\s+", " ", c).strip()
    return c


def _html_table_to_markdown(html):
    rows = _ROW_RE.findall(html)
    parsed = []
    for row_html in rows:
        is_header = "<th" in row_html.lower()
        cells = [_normalize_cell(c) for _, c in _CELL_RE.findall(row_html)]
        parsed.append((is_header, cells))
    if not parsed:
        return ""
    ncols = max(len(cells) for _, cells in parsed)
    if parsed[0][0]:
        header = parsed[0][1]
        data = parsed[1:]
    else:
        header = [""] * ncols
        data = parsed
    header = header + [""] * (ncols - len(header))
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * ncols]
    for _is_header, cells in data:
        cells = cells + [""] * (ncols - len(cells))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _convert_html_tables(md):
    return _TABLE_RE.sub(lambda m: _html_table_to_markdown(m.group(0)), md)


def parse_pdf(path):
    proc = subprocess.run(
        [LIT, "parse", path, "--format", "markdown"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "lit parse failed").strip().splitlines()[-1])
    markdown = proc.stdout.strip()
    if not markdown:
        raise RuntimeError("OCRia produced no output")
    # Drop image references (dangling file links the extraction model can't use).
    markdown = "\n".join(
        line for line in markdown.splitlines() if not line.strip().startswith("![")
    )
    # Rewrite verbose HTML tables into compact markdown pipe tables.
    markdown = _convert_html_tables(markdown)
    return markdown


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing file path"}), file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    try:
        md = parse_pdf(path)
        print(json.dumps({"pages": [md], "usable": True, "scannedShare": 0}))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
