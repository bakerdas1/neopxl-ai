# Deployment

## Prerequisites

- Node.js (v18+)
- PostgreSQL
- Ghostscript (`gs`) — used for fast page-counting
- Python 3 + `pip`

## Python dependencies (PDF fast path)

The server uses `pymupdf` + `pymupdf4llm` as the primary PDF-to-markdown path for
**all** PDFs (deterministic, local, no LLM calls). Only PDFs that PyMuPDF flags as
scanned/unusable fall back to the Gemini VLM conversion.

```sh
pip install --break-system-packages -r requirements.txt
```

> On hosts using PEP 668 externally-managed environments, the
> `--break-system-packages` flag is required. `pymupdf4llm` pulls in
> `pymupdf` as a dependency, but both are pinned in `requirements.txt` for clarity.

## Node dependencies

```sh
npm install
npm run build --workspace=extractor
```

## Environment

Copy `.env.example` to `.env` and set at minimum:

- `GEMINI_API_KEY`
- `DATABASE_URL` (defaults to `postgres://postgres:postgres@localhost:5432/documind`)
- `MODEL` (defaults to `gemini-2.5-flash`)

## Start

```sh
npm start
```

The server listens on port `3022`. The `jobs.status_message` column is created
automatically via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on startup.
