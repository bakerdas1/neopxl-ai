import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/documind';
export const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_URL;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role INTEGER NOT NULL DEFAULT 2,
  company_id TEXT REFERENCES companies(id),
  company_name TEXT,
  created_at BIGINT
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at BIGINT,
  last_used BIGINT
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema TEXT,
  filter TEXT,
  keywords TEXT,
  created_at BIGINT
);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS verify_coverage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS date_format TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS domain TEXT;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL DEFAULT '',
  pages INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in-progress',
  timing JSONB NOT NULL DEFAULT '{}'::jsonb,
  tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost JSONB NOT NULL DEFAULT '{}'::jsonb,
  gemini_calls INTEGER NOT NULL DEFAULT 0,
  schema JSONB,
  filter JSONB,
  template_name TEXT,
  user_id TEXT,
  api_key_name TEXT,
  created_at BIGINT,
  completed_at BIGINT,
  error TEXT,
  result_data TEXT,
  stored_files JSONB,
  status_message TEXT
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_message TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY DEFAULT 1,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  successful INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total_gemini_calls INTEGER NOT NULL DEFAULT 0
);
INSERT INTO stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'documind';

export async function ensureDatabase() {
  const u = new URL(DATABASE_URL);
  u.pathname = '/postgres';
  const boot = new pg.Client({ connectionString: u.toString() });
  try {
    await boot.connect();
    const { rowCount } = await boot.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (!rowCount) {
      await boot.query(`CREATE DATABASE "${DB_NAME}"`);
    }
  } catch (err) {
    console.error('ensureDatabase failed:', err.message);
  } finally {
    await boot.end().catch(() => {});
  }
}

export async function initDb() {
  await ensureDatabase();
  await pool.query(SCHEMA);
}

export async function closeDb() {
  await pool.end();
}
