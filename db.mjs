import pg from 'pg';
import 'dotenv/config';
import { fullPermissions } from './permissions.mjs';

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
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT
);

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
ALTER TABLE templates ADD COLUMN IF NOT EXISTS drop_summary_rows INTEGER NOT NULL DEFAULT 0;

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
  additional_prompt TEXT,
  model TEXT,
  template_name TEXT,
  user_id TEXT,
  api_key_name TEXT,
  workflow_id TEXT,
  created_at BIGINT,
  completed_at BIGINT,
  error TEXT,
  result_data TEXT,
  stored_files JSONB,
  status_message TEXT
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS additional_prompt TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workflow_id TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_workflow ON jobs(workflow_id);

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

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  language TEXT NOT NULL DEFAULT 'python' CHECK (language IN ('python', 'javascript')),
  code TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at BIGINT,
  updated_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_workflows_template ON workflows(template_id);
CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(is_enabled);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON workflow_versions(workflow_id, version);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  input_hash TEXT,
  status TEXT NOT NULL DEFAULT 'in-progress',
  duration_ms INTEGER,
  error_type TEXT,
  error_message TEXT,
  error_line INTEGER,
  output_size INTEGER,
  created_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_job ON workflow_executions(job_id);
`;

const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'documind';

export async function ensureDatabase() {
  const safeDbName = DB_NAME.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeDbName) return;
  const u = new URL(DATABASE_URL);
  u.pathname = '/postgres';
  const boot = new pg.Client({ connectionString: u.toString() });
  try {
    await boot.connect();
    const { rowCount } = await boot.query('SELECT 1 FROM pg_database WHERE datname = $1', [safeDbName]);
    if (!rowCount) {
      await boot.query(`CREATE DATABASE "${safeDbName}"`);
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
  await seedRoles();
}

async function seedRoles() {
  const now = Date.now();
  // Built-in admin role (immutable, full access).
  await pool.query(
    `INSERT INTO roles (id, name, permissions, is_admin, created_at)
     VALUES ($1, $2, $3::jsonb, true, $4)
     ON CONFLICT (id) DO NOTHING`,
    ['admin', 'Admin', JSON.stringify({}), now]
  );
  // Default standard role: everything except Settings (which is admin-only).
  await pool.query(
    `INSERT INTO roles (id, name, permissions, is_admin, created_at)
     VALUES ($1, $2, $3::jsonb, false, $4)
     ON CONFLICT (id) DO NOTHING`,
    ['user', 'Standard User', JSON.stringify(fullPermissions()), now]
  );
  // Preserve existing non-admin users' access by assigning them the standard role.
  await pool.query(`UPDATE users SET role_id = 'user' WHERE role <> 1 AND role_id IS NULL`);
}

export async function closeDb() {
  await pool.end();
}
