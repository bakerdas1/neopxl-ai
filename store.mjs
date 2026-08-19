import crypto from 'crypto';
import { pool } from './db.mjs';

const JSONB_COLS = new Set(['timing', 'tokens', 'cost', 'schema', 'filter', 'stored_files']);

function jsonb(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export async function loadStore() {}

function rowToJob(r) {
  if (!r) return null;
  return {
    id: r.id,
    fileName: r.file_name || '',
    pages: r.pages || 0,
    status: r.status || 'in-progress',
    timing: r.timing || {},
    tokens: r.tokens || {},
    cost: r.cost || {},
    geminiCalls: r.gemini_calls || 0,
    schema: r.schema ?? null,
    filter: r.filter ?? null,
    templateName: r.template_name ?? null,
    userId: r.user_id || 'system',
    apiKeyName: r.api_key_name ?? null,
    userEmail: r.user_email ?? null,
    userFirstName: r.user_first_name ?? null,
    userLastName: r.user_last_name ?? null,
    userName: [r.user_first_name, r.user_last_name].filter(Boolean).join(' ') || r.user_email || null,
    createdAt: r.created_at == null ? null : Number(r.created_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    error: r.error ?? null,
    statusMessage: r.status_message ?? null,
    resultData: r.result_data ?? null,
    storedFiles: r.stored_files ?? null,
  };
}

export async function addJob(jobId, meta, userId) {
  const row = {
    id: jobId,
    file_name: meta?.fileName || '',
    pages: meta?.pages || 0,
    status: meta?.status || 'in-progress',
    timing: jsonb(meta?.timing || {}),
    tokens: jsonb(meta?.tokens || {}),
    cost: jsonb(meta?.cost || {}),
    gemini_calls: meta?.geminiCalls || 0,
    schema: jsonb(meta?.schema ?? null),
    filter: jsonb(meta?.filter ?? null),
    template_name: meta?.templateName ?? null,
    user_id: userId || 'system',
    api_key_name: meta?.apiKeyName ?? null,
    status_message: meta?.statusMessage ?? null,
    created_at: meta?.createdAt || Date.now(),
  };
  const cols = Object.keys(row);
  const vals = cols.map(c => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(
    `INSERT INTO jobs (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  return rowToJob(r.rows[0]);
}

export async function updateJob(jobId, updates) {
  const u = { ...updates };
  let resultData = null;
  if (u.resultData) {
    try { resultData = JSON.stringify(u.resultData); } catch {}
    delete u.resultData;
  }

  const cols = [];
  const vals = [];
  const map = {
    fileName: 'file_name', pages: 'pages', status: 'status', geminiCalls: 'gemini_calls',
    templateName: 'template_name', apiKeyName: 'api_key_name', error: 'error', userId: 'user_id',
    statusMessage: 'status_message',
    createdAt: 'created_at', completedAt: 'completed_at',
  };
  for (const [k, col] of Object.entries(map)) {
    if (u[k] !== undefined) { cols.push(`"${col}" = $${vals.length + 1}`); vals.push(u[k]); }
  }
  for (const col of JSONB_COLS) {
    const k = col === 'stored_files' ? 'storedFiles' : col;
    if (u[k] !== undefined) {
      if (u[k] === null) { cols.push(`"${col}" = NULL`); }
      else { cols.push(`"${col}" = $${vals.length + 1}::jsonb`); vals.push(JSON.stringify(u[k])); }
    }
  }
  if (resultData !== null) { cols.push(`"result_data" = $${vals.length + 1}`); vals.push(resultData); }

  const isTerminal = u.status === 'done' || u.status === 'error';
  if (isTerminal) { cols.push(`"completed_at" = $${vals.length + 1}`); vals.push(Date.now()); }

  if (cols.length) {
    await pool.query(`UPDATE jobs SET ${cols.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, jobId]);
  }

  if (isTerminal) {
    const before = await pool.query('SELECT status, gemini_calls, cost FROM jobs WHERE id = $1', [jobId]);
    const prev = before.rows[0];
    if (prev && prev.status !== 'done' && prev.status !== 'error') {
      const gc = u.geminiCalls ?? prev.gemini_calls ?? 0;
      const cost = u.cost?.total ?? prev.cost?.total ?? 0;
      await pool.query(
        `UPDATE stats SET total_calls = total_calls + 1,
           total_gemini_calls = total_gemini_calls + $1,
           successful = successful + $2,
           failed = failed + $3,
           total_cost = total_cost + $4
         WHERE id = 1`,
        [gc, u.status === 'done' ? 1 : 0, u.status === 'error' ? 1 : 0, cost]
      );
    }
  }

  const r = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return rowToJob(r.rows[0]);
}

export async function getJobs(userId, isAdmin) {
  const cols = 'j.id, j.file_name, j.pages, j.status, j.timing, j.tokens, j.cost, j.gemini_calls, j.schema, j.filter, j.template_name, j.user_id, j.api_key_name, j.created_at, j.completed_at, j.error, j.status_message, j.stored_files, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name';
  const q = isAdmin
    ? await pool.query(`SELECT ${cols} FROM jobs j LEFT JOIN users u ON u.id = j.user_id ORDER BY j.created_at DESC`)
    : await pool.query(`SELECT ${cols} FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.user_id = $1 OR j.user_id = $2 ORDER BY j.created_at DESC`, [userId, 'system']);
  return q.rows.map(rowToJob);
}

export async function getRecentJobs(limit, userId, isAdmin) {
  const cols = 'j.id, j.file_name, j.pages, j.status, j.timing, j.tokens, j.cost, j.gemini_calls, j.schema, j.filter, j.template_name, j.user_id, j.api_key_name, j.created_at, j.completed_at, j.error, j.status_message, j.stored_files, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name';
  const base = isAdmin
    ? `SELECT ${cols} FROM jobs j LEFT JOIN users u ON u.id = j.user_id`
    : `SELECT ${cols} FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.user_id = $1 OR j.user_id = $2`;
  const params = isAdmin ? [] : [userId, 'system'];
  const r = await pool.query(`${base} ORDER BY j.created_at DESC LIMIT $${params.length + 1}`, [...params, limit]);
  return r.rows.map(rowToJob);
}

function buildJobFilterClause(filter, params) {
  const conds = [];
  if (filter.schema === 'schema') {
    conds.push("j.template_name = 'schema-generation'");
  } else if (filter.schema === 'extraction') {
    conds.push("(j.template_name IS NULL OR j.template_name <> 'schema-generation')");
  }
  if (filter.q) {
    params.push(`%${filter.q}%`);
    const i = params.length;
    conds.push(`(j.file_name ILIKE $${i} OR j.id::text ILIKE $${i} OR j.template_name ILIKE $${i} OR u.email ILIKE $${i} OR CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) ILIKE $${i})`);
  }
  if (filter.status) {
    params.push(filter.status);
    conds.push(`j.status = $${params.length}`);
  }
  const tpl = (filter.tpl || []).filter(Boolean);
  if (tpl.length) {
    const hasNone = tpl.includes('__none__');
    const rest = tpl.filter(t => t !== '__none__');
    if (hasNone && !rest.length) {
      conds.push('j.template_name IS NULL');
    } else if (hasNone) {
      params.push(rest);
      conds.push(`(j.template_name IS NULL OR j.template_name = ANY($${params.length}))`);
    } else {
      params.push(rest);
      conds.push(`j.template_name = ANY($${params.length})`);
    }
  }
  if (filter.from) {
    params.push(Number(filter.from));
    conds.push(`j.created_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(Number(filter.to));
    conds.push(`j.created_at <= $${params.length}`);
  }
  return conds;
}

export async function getJobCards(userId, isAdmin, limit, offset, filter = {}) {
  const cols = 'j.id, j.file_name, j.pages, j.status, j.timing, j.cost, j.gemini_calls, j.template_name, j.status_message, j.created_at, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name';
  const params = [];
  const conds = [];
  if (!isAdmin) { params.push(userId, 'system'); conds.push('(j.user_id = $1 OR j.user_id = $2)'); }
  conds.push(...buildJobFilterClause(filter, params));
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  let sql = `SELECT ${cols} FROM jobs j LEFT JOIN users u ON u.id = j.user_id${where} ORDER BY j.created_at DESC`;
  if (limit) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    if (offset) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
  }
  const r = await pool.query(sql, params);
  return r.rows.map(rowToJob);
}

export async function getJobCounts(userId, isAdmin, filter = {}) {
  const gParams = [];
  const gConds = [];
  if (!isAdmin) { gParams.push(userId, 'system'); gConds.push('(j.user_id = $1 OR j.user_id = $2)'); }
  const gWhere = gConds.length ? ' WHERE ' + gConds.join(' AND ') : '';
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE j.template_name = 'schema-generation')::int AS schema_gen FROM jobs j${gWhere}`,
    gParams
  );
  const fParams = [];
  const fConds = [];
  if (!isAdmin) { fParams.push(userId, 'system'); fConds.push('(j.user_id = $1 OR j.user_id = $2)'); }
  fConds.push(...buildJobFilterClause(filter, fParams));
  const fWhere = fConds.length ? ' WHERE ' + fConds.join(' AND ') : '';
  const rf = await pool.query(
    `SELECT COUNT(*)::int AS c FROM jobs j LEFT JOIN users u ON u.id = j.user_id${fWhere}`,
    fParams
  );
  return { total: r.rows[0].total, schemaGen: r.rows[0].schema_gen, filteredTotal: rf.rows[0].c };
}

export async function getStats(userId, isAdmin) {
  const q = isAdmin
    ? await pool.query('SELECT status, gemini_calls, cost FROM jobs')
    : await pool.query('SELECT status, gemini_calls, cost FROM jobs WHERE user_id = $1 OR user_id = $2', [userId, 'system']);
  const all = q.rows;
  const done = all.filter(j => j.status === 'done');
  const failed = all.filter(j => j.status === 'error');
  return {
    totalJobs: all.length,
    successful: done.length,
    failed: failed.length,
    inProgress: all.filter(j => j.status === 'in-progress').length,
    totalCost: all.reduce((s, j) => s + (j.cost?.total || 0), 0),
    totalGeminiCalls: all.reduce((s, j) => s + (j.gemini_calls || 0), 0),
    totalCalls: all.length,
  };
}

export async function getUsers() {
  const r = await pool.query('SELECT id, email, role, first_name, last_name, company_id, company_name, created_at FROM users');
  return r.rows;
}

export async function getUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return r.rows[0] || null;
}

export async function addUser(user) {
  const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [user.email]);
  if (exists.rowCount) return null;
  const id = crypto.randomBytes(12).toString('hex');
  const u = { id, email: user.email, password_hash: user.password_hash, role: user.role || 2, first_name: user.first_name || null, last_name: user.last_name || null, company_id: user.company_id || null, company_name: user.company_name || '', created_at: Date.now() };
  const r = await pool.query(
    'INSERT INTO users (id, email, password_hash, role, first_name, last_name, company_id, company_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [u.id, u.email, u.password_hash, u.role, u.first_name, u.last_name, u.company_id, u.company_name, u.created_at]
  );
  return r.rows[0];
}

export async function updateUser(id, updates) {
  const cols = [];
  const vals = [];
  const map = { email: 'email', password_hash: 'password_hash', role: 'role', first_name: 'first_name', last_name: 'last_name', company_id: 'company_id', company_name: 'company_name' };
  for (const [k, col] of Object.entries(map)) {
    if (updates[k] !== undefined) { cols.push(`"${col}" = $${vals.length + 1}`); vals.push(updates[k]); }
  }
  if (!cols.length) return null;
  const r = await pool.query(`UPDATE users SET ${cols.join(', ')} WHERE id = $${vals.length + 1} RETURNING *`, [...vals, id]);
  return r.rows[0] || null;
}

export async function deleteUser(id) {
  const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  return r.rowCount > 0;
}

export async function deleteJob(id) {
  const r = await pool.query('SELECT status, gemini_calls, cost FROM jobs WHERE id = $1', [id]);
  const job = r.rows[0];
  if (!job) return false;
  const d = await pool.query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
  if (d.rowCount > 0) {
    await pool.query(
      `UPDATE stats SET total_calls = GREATEST(total_calls - 1, 0),
         total_gemini_calls = GREATEST(total_gemini_calls - $1, 0),
         successful = GREATEST(successful - $2, 0),
         failed = GREATEST(failed - $3, 0),
         total_cost = GREATEST(total_cost - $4, 0)
       WHERE id = 1`,
      [job.gemini_calls || 0, job.status === 'done' ? 1 : 0, job.status === 'error' ? 1 : 0, job.cost?.total || 0]
    );
  }
  return d.rowCount > 0;
}

export async function markOrphanedJobsAsError(beforeTs) {
  // Only mark jobs that existed before this server started; anything created after
  // the start time belongs to this process and must not be treated as orphaned.
  const cutoff = Number.isFinite(beforeTs) ? beforeTs : Date.now();
  await pool.query(`UPDATE jobs SET status = 'error', error = 'Server restarted before this task completed', completed_at = $1 WHERE status = 'in-progress' AND created_at < $2`, [Date.now(), cutoff]);
}

export async function getJobResultData(id) {
  const r = await pool.query('SELECT result_data FROM jobs WHERE id = $1', [id]);
  return r.rows[0]?.result_data ?? null;
}

export async function getCompanies() {
  const r = await pool.query('SELECT * FROM companies');
  return r.rows;
}

export async function addCompany(name) {
  const id = crypto.randomBytes(8).toString('hex');
  const r = await pool.query('INSERT INTO companies (id, name, created_at) VALUES ($1,$2,$3) RETURNING *', [id, name, Date.now()]);
  return r.rows[0];
}

export async function updateCompany(id, name) {
  const r = await pool.query('UPDATE companies SET name = $2 WHERE id = $1 RETURNING *', [id, name]);
  return r.rows[0] || null;
}

export async function deleteCompany(id) {
  const r = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [id]);
  return r.rowCount > 0;
}

export async function getTemplates() {
  const r = await pool.query('SELECT * FROM templates ORDER BY created_at ASC, id ASC');
  return r.rows.map(t => ({ ...t, verifyCoverage: t.verify_coverage === 1 || t.verify_coverage === true, verifyTotals: t.verify_totals === 0 ? false : true, perPage: t.per_page === 1 || t.per_page === true, dateFormat: t.date_format || null, dateInputFormat: t.date_input_format || null }));
}

export async function addTemplate(template) {
  const counter = await getSetting('templateCounter');
  const num = (Number.isFinite(counter) ? counter : 0) + 1;
  await setSetting('templateCounter', num);
  const id = 'np_' + String(num).padStart(3, '0');
  const verifyCoverage = template.verifyCoverage ? 1 : 0;
  const verifyTotals = template.verifyTotals === false ? 0 : 1;
  const perPage = template.perPage ? 1 : 0;
  const r = await pool.query(
    'INSERT INTO templates (id, name, schema, filter, keywords, verify_coverage, verify_totals, per_page, date_format, date_input_format, domain, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
    [id, template.name, template.schema || '', template.filter || '', template.keywords || '', verifyCoverage, verifyTotals, perPage, template.dateFormat || null, template.dateInputFormat || null, template.domain || null, Date.now()]
  );
  return { ...r.rows[0], verifyCoverage: r.rows[0].verify_coverage === 1, verifyTotals: r.rows[0].verify_totals === 0 ? false : true, perPage: r.rows[0].per_page === 1, dateFormat: r.rows[0].date_format || null, dateInputFormat: r.rows[0].date_input_format || null };
}

export async function updateTemplate(id, updates) {
  const cols = [];
  const vals = [];
  const map = { name: 'name', schema: 'schema', filter: 'filter', keywords: 'keywords', domain: 'domain' };
  for (const [k, col] of Object.entries(map)) {
    if (updates[k] !== undefined) { cols.push(`"${col}" = $${vals.length + 1}`); vals.push(updates[k]); }
  }
  if (updates.verifyCoverage !== undefined) {
    cols.push(`verify_coverage = $${vals.length + 1}`);
    vals.push(updates.verifyCoverage ? 1 : 0);
  }
  if (updates.verifyTotals !== undefined) {
    cols.push(`verify_totals = $${vals.length + 1}`);
    vals.push(updates.verifyTotals === false ? 0 : 1);
  }
  if (updates.perPage !== undefined) {
    cols.push(`per_page = $${vals.length + 1}`);
    vals.push(updates.perPage ? 1 : 0);
  }
  if (updates.dateFormat !== undefined) {
    cols.push(`date_format = $${vals.length + 1}`);
    vals.push(updates.dateFormat || null);
  }
  if (updates.dateInputFormat !== undefined) {
    cols.push(`date_input_format = $${vals.length + 1}`);
    vals.push(updates.dateInputFormat || null);
  }
  if (!cols.length) return null;
  const r = await pool.query(`UPDATE templates SET ${cols.join(', ')} WHERE id = $${vals.length + 1} RETURNING *`, [...vals, id]);
  if (!r.rows[0]) return null;
  return { ...r.rows[0], verifyCoverage: r.rows[0].verify_coverage === 1, verifyTotals: r.rows[0].verify_totals === 0 ? false : true, perPage: r.rows[0].per_page === 1, dateFormat: r.rows[0].date_format || null, dateInputFormat: r.rows[0].date_input_format || null };
}

export async function deleteTemplate(id) {
  const r = await pool.query('DELETE FROM templates WHERE id = $1 RETURNING id', [id]);
  return r.rowCount > 0;
}

export async function createApiKey(userId, name) {
  const key = 'neopxl_' + crypto.randomBytes(24).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const r = await pool.query(
    'INSERT INTO api_keys (id, user_id, key, name, created_at, last_used) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [id, userId, key, name || 'API Key', Date.now(), null]
  );
  return r.rows[0];
}

export async function getUserApiKeys(userId) {
  const r = await pool.query('SELECT * FROM api_keys WHERE user_id = $1', [userId]);
  return r.rows;
}

export async function getApiKeyUser(key) {
  const r = await pool.query('SELECT * FROM api_keys WHERE key = $1', [key]);
  const k = r.rows[0];
  if (!k) return null;
  await pool.query('UPDATE api_keys SET last_used = $1 WHERE id = $2', [Date.now(), k.id]);
  const u = (await pool.query('SELECT * FROM users WHERE id = $1', [k.user_id])).rows[0];
  if (!u) return null;
  const company = (await pool.query('SELECT * FROM companies WHERE id = $1', [u.company_id])).rows[0];
  return { id: u.id, email: u.email, role: u.role, company_id: u.company_id, company_name: company?.name || '', _apiKeyId: k.id, _apiKeyName: k.name };
}

export async function revokeApiKey(id, userId) {
  const r = await pool.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return r.rowCount > 0;
}

export async function getSetting(key) {
  const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (!r.rows[0]) return null;
  const v = r.rows[0].value;
  return v === null ? null : v;
}

export async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3',
    [key, JSON.stringify(value), Date.now()]
  );
}
