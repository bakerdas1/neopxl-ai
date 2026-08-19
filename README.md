# Neopxl AI

An intelligent document processing platform that leverages AI to extract structured data from PDFs and other document formats.

## Overview

Neopxl AI is a web-based application for automated document extraction and processing. It converts documents to Markdown, applies customizable schemas to extract relevant fields, and returns structured JSON output. The platform includes a full web UI for managing extraction jobs, templates, users, and API keys.

## Features

- **Document Extraction** - Extract structured data from PDFs, images, DOCX, XLSX, CSV, TXT, and HTML files
- **Custom Schemas** - Define your own extraction schemas with nested fields, arrays, and various data types
- **Auto Schema Generation** - Automatically generate extraction schemas from document content
- **Multi-Model Support** - Works with Google Gemini, OpenAI, and local LLM models (Ollama)
- **Document Classification** - AI-powered document type detection and routing
- **Web Dashboard** - Full admin UI for managing jobs, templates, users, and API keys
- **Authentication** - JWT-based auth with API key support
- **Cloud Storage** - S3-compatible storage integration alongside local file storage
- **CSV Export** - Export extraction results to CSV format
- **Coverage Verification** - Validate extraction completeness against source documents

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js (ES Modules) |
| **Database** | PostgreSQL |
| **AI/LLM** | Google Gemini, OpenAI, Ollama (local) |
| **PDF Processing** | PyMuPDF, pymupdf4llm, Tesseract.js, Ghostscript |
| **Image Processing** | Sharp, GraphicsMagick |
| **Authentication** | bcrypt, jsonwebtoken |
| **Schema Validation** | Zod |
| **Cloud Storage** | AWS S3 (via @aws-sdk/client-s3) |
| **Frontend** | Vanilla HTML/CSS/JS (server-rendered) |

## Prerequisites

- Node.js v18+
- Python 3 with pip
- PostgreSQL
- Ghostscript (`gs`)
- GraphicsMagick

## Installation

```bash
# Clone the repository
git clone git@github.com:bakerdas1/neopxl-ai.git
cd neopxl-ai

# Install Node dependencies
npm install

# Install Python dependencies (PDF processing)
pip install -r requirements.txt
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

- `GEMINI_API_KEY` - Google Gemini API key (or `OPENAI_API_KEY` for OpenAI)
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT authentication

## Running

```bash
# Start the server
npm run ui

# Or use the start script (sets up tessdata path)
./start.sh
```

The server starts on port `3022`.

## API

The application exposes a REST API for:

- Job management (create, list, get, delete)
- Template CRUD
- User and company management
- API key generation and revocation
- Schema generation
- S3 storage connector management

See `openapi.json` for the full API specification.

## Project Structure

```
├── core/               # Core document processing library
├── extractor/          # Extraction engine (LLM integration, formatters)
├── schema-service/     # Auto schema generation
├── pages/              # Web UI pages
├── server.mjs          # Main HTTP server
├── store.mjs           # Database operations
├── db.mjs              # PostgreSQL connection & schema
├── auth.mjs            # Authentication helpers
├── storage.mjs         # File storage (local + S3)
├── csvExport.mjs       # CSV export logic
└── layout.html         # Main app layout
```