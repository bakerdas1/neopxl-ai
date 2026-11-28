#!/usr/bin/env python3
"""
Parse a PDF to markdown using OCRia-nano-1 (via LiteParse) and emit the same
JSON shape the server expects from pymupdf: {pages: [...], usable: bool,
scannedShare: number}. The LiteParse `lit` binary path can be overridden with
the LITEPARSE_BIN environment variable.
"""
import sys
import json
import os
import subprocess

LIT = os.environ.get("LITEPARSE_BIN", "/tmp/opencode/lpenv/bin/lit")


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
    # LiteParse emits an image reference for detected graphics; drop it so the
    # extraction model doesn't see a dangling file link.
    markdown = "\n".join(
        line for line in markdown.splitlines() if not line.strip().startswith("![")
    )
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
