import { createServer } from 'http';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, extname } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { tmpdir } from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { loadStore, addJob, updateJob, getStats, getRecentJobs, getJobs, getTemplates, addTemplate, updateTemplate, deleteTemplate, getUsers, getUserByEmail, addUser, updateUser, deleteUser, getCompanies, addCompany, updateCompany, deleteCompany, createApiKey, getUserApiKeys, revokeApiKey } from './store.mjs';
import { hashPassword, comparePassword, signToken, authGuard } from './auth.mjs';
import 'dotenv/config';
import { documind } from 'core';
import { generateMarkdownDocument } from './extractor/src/utils/generateMarkdown.js';
import { convertToZodSchema } from './extractor/src/utils/convertToZodSchema.js';
import { getExtractor } from './extractor/src/extractors/index.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { BASE_EXTRACTION_PROMPT } from './extractor/src/prompts.js';
import { templates } from './extractor/src/services/templates.js';
import { generateSchema } from './schema-service/generateSchema.js';

const PORT = 3022;
const ALLOWED = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'html'];
const SCHEMA_ALLOWED = ['pdf', 'docx', 'png', 'jpg', 'jpeg'];
const MAX_SCHEMA_FILES = 10;
const jobs = new Map();
const schemaJobs = new Map();

function getBoundary(contentType) {
  const m = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (m?.[1] || m?.[2])?.trim();
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function jsonSchemaToDocumind(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj.name !== undefined && obj.type) return obj;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    return Object.entries(props).map(([name, def]) => {
      const field = { name, type: def.type || 'string' };
      if (def.description) field.description = def.description;
      if (def.properties) field.children = jsonSchemaToDocumind(def);
      if (def.type === 'array' && def.items) {
        field.children = jsonSchemaToDocumind(def.items);
        if (field.children.length === 0) field.children = undefined;
      }
      return field;
    });
  }
  return null;
}

function applyFilter(data, filterConfig) {
  if (!filterConfig || !data || typeof data !== 'object') return data;
  const { dropIf, keepIf } = filterConfig;
  const result = Array.isArray(data) ? [...data] : { ...data };
  if (Array.isArray(result)) return result;

  for (const [key, value] of Object.entries(result)) {
    if (!Array.isArray(value)) continue;

    if (dropIf && dropIf[key]) {
      const conditions = dropIf[key];
      result[key] = value.filter(item => {
    for (const [field, pattern] of Object.entries(conditions)) {
      const val = item[field];
      if (typeof pattern === 'string' && pattern !== '') {
        if (new RegExp(pattern, 'i').test(String(val ?? ''))) return false;
          } else if (pattern === '' || pattern === null) {
            if (val === undefined || val === null || val === '') return false;
          } else if (typeof val === 'number' || typeof val === 'string') {
            if (val === pattern) return false;
          }
        }
        return true;
      });
    }

    if (keepIf && keepIf[key]) {
      const conditions = keepIf[key];
      result[key] = value.filter(item => {
        for (const [field, required] of Object.entries(conditions)) {
          if (required) {
            const val = item[field];
            if (typeof required === 'string') {
              if (!new RegExp(required, 'i').test(String(val ?? ''))) return false;
            } else if (val === undefined || val === null || val === '') {
              return false;
            }
          }
        }
        return true;
      });
    }
  }

  return result;
}

function arraySchemaOnly(schema) {
  if (!Array.isArray(schema)) return schema;
  return schema.filter(f => f.type === 'array');
}

async function extractPage(markdown, zodSchema, model, stats) {
  const extractor = getExtractor(model);
  const start = Date.now();
  const result = await extractor({ markdown, zodSchema, prompt: BASE_EXTRACTION_PROMPT, model });
  const data = result?.data !== undefined ? result.data : result;
  const usage = result?.usage || {};
  stats.time += Date.now() - start;
  stats.inputTokens += usage.inputTokens || 0;
  stats.outputTokens += usage.outputTokens || 0;
  return { data, usage };
}

async function runExtraction(coreResult, schemaUsed, model) {
  const pages = coreResult.pages;
  const fullZod = convertToZodSchema(schemaUsed);
  const stats = { time: 0, inputTokens: 0, outputTokens: 0 };

  if (pages.length <= 20) {
    try {
      const { data } = await extractPage(coreResult.pages.map(p => p.content).join('\n\n'), fullZod, model, stats);
      return { data, usage: { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens }, time: stats.time };
    } catch (e) {
      if (!(e instanceof SyntaxError) || !e.message.includes('JSON')) throw e;
      stats.time = 0; stats.inputTokens = 0; stats.outputTokens = 0;
    }
  }

  const arraySchema = arraySchemaOnly(schemaUsed);
  if (!arraySchema.length) {
    const { data } = await extractPage(pages.map(p => p.content).join('\n\n'), fullZod, model, stats);
    return { data, usage: { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens }, time: stats.time };
  }

  const arrayZod = convertToZodSchema(arraySchema);
  const concurrency = Math.min(20, pages.length);
  const limit = pLimit(concurrency);

  const page1 = await extractPage(pages[0].content, fullZod, model, stats);
  const merged = { ...page1.data };

  const restResults = await Promise.all(
    pages.slice(1).map(p => limit(() => extractPage(p.content, arrayZod, model, stats)))
  );

  for (const field of arraySchema) {
    const name = field.name;
    merged[name] = [
      ...(page1.data[name] || []),
      ...restResults.flatMap(r => r.data[name] || []),
    ];
  }

  return { data: merged, usage: { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens }, time: stats.time };
}

function renderPage(templateNames) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documind Test</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;padding:2rem;color:#333}
.container{max-width:900px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:.5rem}
.card{background:#fff;border-radius:8px;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:1rem}
label{display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem}
input,select{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-size:.9rem}
button{background:#2563eb;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:4px;font-size:.9rem;cursor:pointer}
button:hover{background:#1d4ed8}
button:disabled{background:#93c5fd;cursor:not-allowed}
#result{margin-top:1rem;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.8rem;line-height:1.4;max-height:600px;overflow:auto;background:#1e1e2e;color:#cdd6f4;padding:1rem;border-radius:6px;display:none}
.status-bar{display:none;margin-top:.5rem;padding:.4rem .8rem;border-radius:4px;font-size:.85rem}
.status-processing{background:#dbeafe;color:#1e40af}
.status-done{background:#dcfce7;color:#166534}
.status-error{background:#fee2e2;color:#991b1b}
.form-row{display:flex;gap:1rem;align-items:end;flex-wrap:wrap}
.form-row>div{flex:1;min-width:200px}
.form-row button{height:fit-content;padding:.5rem 1.5rem}
</style>
</head>
<body>
<div class="container">
<h1>Documind &mdash; Document Extraction</h1>
<p>Upload a document to extract structured data using AI. Large files may take a minute or two.</p>
<div class="card">
<form id="uploadForm" enctype="multipart/form-data">
<div class="form-row">
<div>
<label for="file">Document</label>
<input type="file" id="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.html">
</div>
<div>
<label for="template">Template</label>
<select id="template" name="template">
<option value="">None (raw markdown)</option>
<option value="__custom__">Custom schema (paste below)</option>
${templateNames.map(t => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
</select>
</div>
</div>
<div style="margin-top:.8rem">
<label for="schema">Custom Schema (JSON)</label>
<textarea id="schema" name="schema" rows="6" style="width:100%;font-family:ui-monospace,monospace;font-size:.8rem;padding:.5rem;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder='[{"name":"fieldName","type":"string","description":"Field description"}]'></textarea>
</div>
<div style="margin-top:.5rem">
<label for="filter">Filter Rules (JSON, optional)</label>
<textarea id="filter" name="filter" rows="3" style="width:100%;font-family:ui-monospace,monospace;font-size:.78rem;padding:.5rem;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder='{"dropIf":{"transactions":{"description":"^Account Credit"}},"keepIf":{"transactions":{"date":true}}}'></textarea>
</div>
<button type="submit" id="submitBtn" style="margin-top:.8rem">Extract</button>
</form>
<div id="statusBar" class="status-bar"></div>
<pre id="result"></pre>
</div>
</div>
<script>
const form = document.getElementById('uploadForm');
const submitBtn = document.getElementById('submitBtn');
const result = document.getElementById('result');
const statusBar = document.getElementById('statusBar');
const templateSelect = document.getElementById('template');
const schemaArea = document.getElementById('schema');

templateSelect.addEventListener('change', () => {
  schemaArea.disabled = templateSelect.value !== '__custom__';
  if (templateSelect.value !== '__custom__') schemaArea.value = '';
});
schemaArea.addEventListener('input', () => {
  if (schemaArea.value.trim()) {
    templateSelect.value = '__custom__';
    schemaArea.disabled = false;
  }
});
schemaArea.disabled = true;

form.onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('file', document.getElementById('file').files[0]);
  fd.append('template', document.getElementById('template').value);
  fd.append('schema', document.getElementById('schema').value);
  fd.append('filter', document.getElementById('filter').value);
  submitBtn.disabled = true;
  result.style.display = 'none';
  statusBar.style.display = 'block';
  statusBar.className = 'status-bar status-processing';
  statusBar.textContent = 'Submitting...';

  try {
    const r = await fetch('/extract', { method: 'POST', body: fd });
    const job = await r.json();
    if (job.error) { showError(job.error); return; }

    const jobId = job.jobId;
    statusBar.textContent = 'Processing document... (this may take a while for large files)';

    const poll = setInterval(async () => {
      try {
        const res = await fetch('/result/' + jobId);
        const d = await res.json();
        if (d.status === 'error') {
          clearInterval(poll);
          showError(d.meta?.error || 'Extraction failed');
        } else if (d.status === 'done') {
          clearInterval(poll);
          const m = d.meta || {};
          const t = m.timing || {};
          const tk = m.tokens || {};
          const c = m.cost || {};
          statusBar.className = 'status-bar status-done';
          statusBar.innerHTML = 'Fetching data...';
          submitBtn.disabled = false;
          try {
            const dr = await fetch('/data/' + jobId);
            const data = await dr.json();
            statusBar.innerHTML = 'Done! ' + (m.pages||'') + ' pages &mdash; ' +
              (t.total ? (t.total/1000).toFixed(1) + 's' : '') +
              (c.total ? ' | ' + (tk.total?.input||0).toLocaleString() + ' in / ' + (tk.total?.output||0).toLocaleString() + ' out tokens' : '') +
              (c.total ? ' | $' + c.total : '');
            const display = data.data || data.markdown || data;
            result.textContent = JSON.stringify(display, null, 2);
            result.style.display = 'block';
          } catch (err) {
            showError('Failed to load data: ' + err.message);
          }
        }
      } catch (err) {
        clearInterval(poll);
        showError('Polling failed: ' + err.message);
      }
    }, 2000);
  } catch (err) {
    showError('Submit failed: ' + err.message);
  }
};

function showError(msg) {
  statusBar.className = 'status-bar status-error';
  statusBar.textContent = 'Error: ' + msg;
  submitBtn.disabled = false;
}
</script>
</body>
</html>`;
}

const tpls = templates.list();
const model = process.env.MODEL || 'gemini-2.5-flash';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documind API Documentation</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>html{box-sizing:border-box;overflow:-moz-scrollbars-vertical;overflow-y:scroll}*,:after,:before{box-sizing:inherit}body{margin:0;background:#fafafa}.swagger-ui .topbar{display:none}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js" crossorigin></script>
<script>SwaggerUIBundle({url:'/api/docs/openapi.json',dom_id:'#swagger-ui',presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],layout:'StandaloneLayout'})</script>
</body>
</html>`);
    return;
  }

  if (url.pathname === '/api/docs/openapi.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(readFileSync(join(__dirname, 'openapi.json'), 'utf-8'));
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/x-icon' });
    res.end(readFileSync(join(__dirname, 'favicon.ico')));
    return;
  }

  if (url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(__dirname, 'login.html'), 'utf-8'));
    return;
  }

  function servePage(pageFile, title, activePage) {
    const layout = readFileSync(join(__dirname, 'layout.html'), 'utf-8');
    const content = readFileSync(join(__dirname, 'pages', pageFile), 'utf-8');
    const html = layout
      .replace('{{TITLE}}', title)
      .split('{{CONTENT}}').join(content)
      .replace('{{HOME_ACTIVE}}', activePage === 'home' ? 'active' : '')
      .replace('{{TASKS_ACTIVE}}', activePage === 'tasks' ? 'active' : '')
      .replace('{{KEYS_ACTIVE}}', activePage === 'keys' ? 'active' : '')
      .replace('{{SCHEMAS_ACTIVE}}', activePage === 'schemas' ? 'active' : '')
      .replace('{{SETTINGS_ACTIVE}}', activePage === 'settings' ? 'active' : '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return servePage('home.html', 'Dashboard', 'home');
  }

  if (url.pathname === '/tasks') {
    return servePage('tasks.html', 'Tasks', 'tasks');
  }

  if (url.pathname === '/keys') {
    return servePage('keys.html', 'API Keys', 'keys');
  }

  if (url.pathname === '/schemas') {
    return servePage('schemas.html', 'Schema Generator', 'schemas');
  }

  if (url.pathname === '/settings') {
    return servePage('settings.html', 'Settings', 'settings');
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, getStats(user.id, user.role === 1));
  }

  if (url.pathname === '/api/stats/templates' && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    const jobs = getJobs(user.id, user.role === 1).filter(j => j.status === 'done');
    const tpls = getTemplates();
    const tplById = Object.fromEntries(tpls.map(t => [t.id, t.name]));

    const counts = {};
    jobs.forEach(j => {
      let label;
      if (j.templateName && tplById[j.templateName]) {
        label = tplById[j.templateName];
      } else if (j.templateName) {
        label = j.templateName;
      } else if (j.schema) {
        label = 'Custom Schema';
      } else {
        label = 'Raw Markdown';
      }
      counts[label] = (counts[label] || 0) + 1;
    });
    return sendJSON(res, 200, Object.entries(counts).map(([name, count]) => ({ name, count })));
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    const limit = parseInt(url.searchParams.get('limit')) || 0;
    const jobs = limit > 0 ? getRecentJobs(limit, user.id, user.role === 1) : getJobs(user.id, user.role === 1);
    const users = getUsers();
    const userMap = Object.fromEntries(users.map(u => [u.id, u.email]));
    const withUsers = jobs.map(j => ({ ...j, userName: userMap[j.userId] || 'system' }));
    return sendJSON(res, 200, withUsers);
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    const parts = url.pathname.split('/');
    const taskId = parts[parts.length - (url.pathname.endsWith('/data') ? 2 : 1)];
    const isData = url.pathname.endsWith('/data');
    const job = getJobs(user.id, user.role === 1).find(j => j.id === taskId);
    if (!job) return sendJSON(res, 404, { error: 'Task not found' });
    if (isData) {
      const memJob = jobs.get(taskId);
      if (memJob && memJob.data) return sendJSON(res, 200, memJob.data);
      if (job.resultData) {
        try { return sendJSON(res, 200, JSON.parse(job.resultData)); } catch {}
      }
      return sendJSON(res, 200, job.data || {});
    }
    return sendJSON(res, 200, job);
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const { email, password } = JSON.parse(body);
      const user = getUserByEmail(email);
      if (!user || !(await comparePassword(password, user.password_hash))) {
        return sendJSON(res, 401, { error: 'Invalid email or password' });
      }
      const token = signToken(user);
      sendJSON(res, 200, { token, user: { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: user.company_name } });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: user.company_name });
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return sendJSON(res, 200, {
      apiKey: process.env.API_KEY || '',
      model: process.env.MODEL || 'gemini-2.5-flash',
      geminiKey: process.env.GEMINI_API_KEY || '',
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const envPath = join(__dirname, '.env');
      let env = readFileSync(envPath, 'utf-8');
      if (data.model) env = env.replace(/^MODEL=.*/m, `MODEL=${data.model}`);
      if (data.apiKey) env = env.replace(/^API_KEY=.*/m, `API_KEY=${data.apiKey}`);
      if (data.geminiKey) env = env.replace(/^GEMINI_API_KEY=.*/m, `GEMINI_API_KEY=${data.geminiKey}`);
      const { writeFile } = await import('fs/promises');
      await writeFile(envPath, env);
      if (data.model) process.env.MODEL = data.model;
      if (data.apiKey) process.env.API_KEY = data.apiKey;
      if (data.geminiKey) process.env.GEMINI_API_KEY = data.geminiKey;
      sendJSON(res, 200, { success: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    return sendJSON(res, 200, getUsers());
  }
  if (url.pathname === '/api/users' && req.method === 'POST') {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const { email, password, role, company_id } = JSON.parse(body);
      const company = getCompanies().find(c => c.id === company_id);
      const hash = await hashPassword(password);
      const u = addUser({ email, password_hash: hash, role: role || 2, company_id: company_id || '', company_name: company?.name || '' });
      if (!u) return sendJSON(res, 400, { error: 'Email already exists' });
      sendJSON(res, 200, { id: u.id, email: u.email, role: u.role, company_id: u.company_id, company_name: u.company_name });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith('/api/users/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') { const ok = deleteUser(id); return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' }); }
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const data = JSON.parse(body); const updates = {};
      if (data.email) updates.email = data.email;
      if (data.role) updates.role = data.role;
      if (data.password) updates.password_hash = await hashPassword(data.password);
      if (data.company_id !== undefined) { updates.company_id = data.company_id; const company = getCompanies().find(c => c.id === data.company_id); updates.company_name = company?.name || ''; }
      const u = updateUser(id, updates);
      sendJSON(res, u ? 200 : 404, u ? { id: u.id, email: u.email, role: u.role, company_id: u.company_id } : { error: 'Not found' });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname === '/api/keys' && req.method === 'GET') {
    const user = authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, getUserApiKeys(user.id));
  }

  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const user = authGuard(req, res);
    if (!user) return;
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const { name } = JSON.parse(body);
      const k = createApiKey(user.id, name);
      sendJSON(res, 200, k);
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
    const user = authGuard(req, res);
    if (!user) return;
    const id = url.pathname.split('/').pop();
    const ok = revokeApiKey(id, user.id);
    sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' });
    return;
  }

  if (url.pathname === '/api/companies' && req.method === 'GET') {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    return sendJSON(res, 200, getCompanies());
  }
  if (url.pathname === '/api/companies' && req.method === 'POST') {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try { const { name } = JSON.parse(body); sendJSON(res, 200, addCompany(name)); } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith('/api/companies/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const authUser = authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') { const ok = deleteCompany(id); return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' }); }
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try { const { name } = JSON.parse(body); const c = updateCompany(id, name); sendJSON(res, c ? 200 : 404, c || { error: 'Not found' }); } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname === '/extract' && req.method === 'POST') {
    try {
      const boundary = getBoundary(req.headers['content-type']);
      if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      let file = null;
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!file || !file.data || !file.filename) {
        return sendJSON(res, 400, { error: 'No file uploaded' });
      }
      const ext = extname(file.filename).slice(1).toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return sendJSON(res, 400, { error: `Unsupported: ${ext}. Allowed: ${ALLOWED.join(', ')}` });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const templateName = (fields.template || '').trim();
      jobs.set(jobId, { status: 'processing', page: 0, totalPages: 0 });
      addJob(jobId, { fileName: file.filename, status: 'in-progress', schema: fields.schema || null, filter: fields.filter || null, templateName: templateName || null, createdAt: Date.now() }, 'system');

      (async () => {
        let tmpDir;
        try {
          tmpDir = await mkdtemp(join(tmpdir(), 'documind-'));
          const tmpPath = join(tmpDir, file.filename);
          await writeFile(tmpPath, file.data);

          const coreResult = await documind({ filePath: tmpPath, model });
          jobs.set(jobId, { ...jobs.get(jobId), totalPages: coreResult.pages.length });

          const markdown = await generateMarkdownDocument(coreResult.pages);

          let schemaUsed = null;
          if (fields.schema && fields.schema.trim()) {
            let parsed = JSON.parse(fields.schema.trim());
            if (!Array.isArray(parsed)) {
              if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
              else if (parsed.name && parsed.type) parsed = [parsed];
              else {
                const converted = jsonSchemaToDocumind(parsed);
                if (converted && converted.length > 0) parsed = converted;
              }
            }
            schemaUsed = parsed;
          } else if (templateName && tpls.includes(templateName) && templateName !== '__custom__') {
            schemaUsed = templates.get(templateName);
          }

          const conversionUsage = {
            inputTokens: coreResult.inputTokens || 0,
            outputTokens: coreResult.outputTokens || 0,
            timeMs: coreResult.completionTime || 0,
          };

          if (schemaUsed) {
            const { data, usage: extractUsage, time: extractionTime } = await runExtraction(coreResult, schemaUsed, model);

            const filterConfig = (() => {
              try { const f = fields.filter?.trim(); return f ? JSON.parse(f) : null; } catch { return null; }
            })();
            const filterApplied = filterConfig ? applyFilter(data, filterConfig) : data;

            const totalInput = conversionUsage.inputTokens + (extractUsage.inputTokens || 0);
            const totalOutput = conversionUsage.outputTokens + (extractUsage.outputTokens || 0);

            const INPUT_PRICE = 0.15 / 1000000;
            const OUTPUT_PRICE = 0.60 / 1000000;
            const cost = totalInput * INPUT_PRICE + totalOutput * OUTPUT_PRICE;

            const meta = {
              pages: coreResult.pages.length,
              timing: { total: conversionUsage.timeMs + extractionTime, conversion: conversionUsage.timeMs, extraction: extractionTime },
              tokens: { conversion: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens }, extraction: { input: extractUsage.inputTokens || 0, output: extractUsage.outputTokens || 0 }, total: { input: totalInput, output: totalOutput } },
              cost: { total: +cost.toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
            };

            jobs.set(jobId, { status: 'done', meta, data: { success: true, data: filterApplied, markdown, fileName: coreResult.fileName } });
            updateJob(jobId, { status: 'done', pages: coreResult.pages.length, timing: meta.timing, tokens: meta.tokens, cost: meta.cost, geminiCalls: coreResult.pages.length + 1, resultData: { success: true, data: filterApplied, markdown, fileName: coreResult.fileName } });
          } else {
            const markdownData = { success: true, pages: coreResult.pages.length, markdown, fileName: coreResult.fileName };
            jobs.set(jobId, { status: 'done', meta: { pages: coreResult.pages.length }, data: markdownData });
            updateJob(jobId, { status: 'done', pages: coreResult.pages.length, geminiCalls: coreResult.pages.length, timing: { total: coreResult.completionTime }, cost: {}, resultData: markdownData });
          }
        } catch (err) {
          console.error(err);
          jobs.set(jobId, { status: 'error', meta: { error: err.message } });
          updateJob(jobId, { status: 'error', error: err.message });
        } finally {
          if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      })();

      sendJSON(res, 200, { jobId, status: 'processing' });

    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

function parseSchema(fields) {
  const templateId = (fields.template_id || fields.template || '').trim();
  let schemaUsed = null;
  let filterUsed = fields.filter || null;

  if (fields.schema && fields.schema.trim()) {
    try {
      let parsed = JSON.parse(fields.schema.trim());
      if (!Array.isArray(parsed)) {
        if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
        else if (parsed.name && parsed.type) parsed = [parsed];
        else {
          const converted = jsonSchemaToDocumind(parsed);
          if (converted && converted.length > 0) parsed = converted;
        }
      }
      schemaUsed = parsed;
    } catch {}
  } else if (templateId) {
    const tpls = getTemplates();
    const tpl = tpls.find(t => t.id === templateId || t.name === templateId);
    if (tpl && tpl.schema) {
      try {
        let parsed = JSON.parse(tpl.schema);
        if (!Array.isArray(parsed)) {
          if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
          else if (parsed.name && parsed.type) parsed = [parsed];
          else {
            const converted = jsonSchemaToDocumind(parsed);
            if (converted && converted.length > 0) parsed = converted;
          }
        }
        schemaUsed = parsed;
        if (tpl.filter && !filterUsed) filterUsed = tpl.filter;
      } catch {}
    }
  }
  return { schemaUsed, filterUsed };
}

async function quickPageCount(filePath) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('gs', [
      '-dNOPAUSE', '-dBATCH', '-q', '-dQUIET', '-dNODISPLAY',
      '-c', `(${filePath}) (r) file runpdfbegin pdfpagecount = quit`,
    ]);
    return parseInt(stdout.trim(), 10);
  } catch { return 0; }
}

function estimateTime(fileExt, pageCount, hasSchema) {
  const pages = pageCount || 1;
  const perPage = pages > 20 ? 8 : (hasSchema ? 12 : 6);
  const total = (5 + pages * perPage) * 1000;
  const ms = total;
  if (ms < 60000) return { ms, text: `${Math.round(ms/1000)}s` };
  return { ms, text: `~${Math.round(ms/60000)} min` };
}

function checkAuth(req, res) {
  if (!process.env.API_KEY || process.env.API_KEY === 'documind-api-key-change-me') return true;
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (key !== process.env.API_KEY) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

  if ((url.pathname.startsWith('/api/result/') || url.pathname.startsWith('/api/data/')) && req.method === 'GET') {
    if (!authGuard(req, res)) return;
    const isData = url.pathname.includes('/api/data/');
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    sendJSON(res, 200, isData ? job.data : {
      status: job.status, eta: job.eta, meta: job.meta, data: job.data || null,
    });
    if (job.status === 'done' || job.status === 'error') {
      setTimeout(() => jobs.delete(jobId), 120000);
    }
    return;
  }

  if (url.pathname.startsWith('/result/') && req.method === 'GET') {
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    sendJSON(res, 200, {
      status: job.status,
      eta: job.eta,
      meta: job.meta,
      data: job.data || null,
    });
    if (job.status === 'done' || job.status === 'error') {
      setTimeout(() => jobs.delete(jobId), 120000);
    }
    return;
  }

  if (url.pathname.startsWith('/data/') && req.method === 'GET') {
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'done') return sendJSON(res, 404, { error: 'Data not found' });
    sendJSON(res, 200, job.data);
    return;
  }

  if (url.pathname === '/api/extract' && req.method === 'POST') {
    try {
      const apiUser = authGuard(req, res);
      if (!apiUser) return;

      const isAsync = url.searchParams.get('mode') === 'async';

      const boundary = getBoundary(req.headers['content-type']);
      if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      let file = null;
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!file || !file.data || !file.filename) {
        return sendJSON(res, 400, { error: 'File is required' });
      }
      const ext = extname(file.filename).slice(1).toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return sendJSON(res, 400, { error: `Unsupported file type: ${ext}. Allowed: ${ALLOWED.join(', ')}` });
      }

      const model = process.env.MODEL || 'gemini-2.5-flash';

      if (isAsync) {
        const jobId = crypto.randomBytes(8).toString('hex');
        const { schemaUsed: schema, filterUsed } = parseSchema(fields);
        const tplId = (fields.template_id || fields.template || '').trim();
        let tplName = tplId || null;
        if (tplId) {
          const tpls = getTemplates();
          const tpl = tpls.find(t => t.id === tplId || t.name === tplId);
          if (tpl) tplName = tpl.name;
        }
        const finalFilter = fields.filter?.trim() || filterUsed || null;

        const tDir = await mkdtemp(join(tmpdir(), 'documind-'));
        const tPath = join(tDir, file.filename);
        await writeFile(tPath, file.data);
        const ext = file.filename?.split('.').pop()?.toLowerCase() || '';
        const pageCount = ext === 'pdf' ? await quickPageCount(tPath) : 0;
        const estimate = estimateTime(ext, pageCount, !!schema);

        jobs.set(jobId, { status: 'processing', eta: estimate.text });
        addJob(jobId, { fileName: file.filename, status: 'in-progress', pages: pageCount, schema: fields.schema || null, filter: finalFilter, templateName: tplName, apiKeyName: apiUser._apiKeyName || null, createdAt: Date.now() }, apiUser.id);

        (async () => {
          try {
            const coreRes = await documind({ filePath: tPath, model });
            const md = await generateMarkdownDocument(coreRes.pages);

            if (!schema) {
              const markdownData = { success: true, pages: coreRes.pages.length, markdown: md, fileName: coreRes.fileName };
              jobs.set(jobId, { status: 'done', meta: { pages: coreRes.pages.length }, data: markdownData });
              updateJob(jobId, { status: 'done', pages: coreRes.pages.length, geminiCalls: coreRes.pages.length, timing: { total: coreRes.completionTime }, fileName: coreRes.fileName, resultData: markdownData });
            } else {
              const { data, usage: extUsage, time: extTime } = await runExtraction(coreRes, schema, model);

              let filterConfig = null;
              if (fields.filter && fields.filter.trim()) {
                try { filterConfig = JSON.parse(fields.filter); } catch {}
              }
              const filtered = filterConfig ? applyFilter(data, filterConfig) : data;

              const convUsage = { inputTokens: coreRes.inputTokens || 0, outputTokens: coreRes.outputTokens || 0, timeMs: coreRes.completionTime || 0 };
              const tIn = convUsage.inputTokens + (extUsage.inputTokens || 0);
              const tOut = convUsage.outputTokens + (extUsage.outputTokens || 0);
              const INPUT_PRICE = 0.15 / 1000000;
              const OUTPUT_PRICE = 0.60 / 1000000;

              const meta = {
                pages: coreRes.pages.length,
                timing: { total: convUsage.timeMs + extTime, conversion: convUsage.timeMs, extraction: extTime },
                tokens: { conversion: { input: convUsage.inputTokens, output: convUsage.outputTokens }, extraction: { input: extUsage.inputTokens || 0, output: extUsage.outputTokens || 0 }, total: { input: tIn, output: tOut } },
                cost: { total: +(tIn * INPUT_PRICE + tOut * OUTPUT_PRICE).toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
              };
              jobs.set(jobId, { status: 'done', meta, data: { success: true, data: filtered, fileName: coreRes.fileName } });
              updateJob(jobId, { status: 'done', pages: coreRes.pages.length, timing: meta.timing, tokens: meta.tokens, cost: meta.cost, geminiCalls: coreRes.pages.length + (coreRes.pages.length > 20 ? coreRes.pages.length + 1 : 1), fileName: coreRes.fileName, resultData: { success: true, data: filtered, fileName: coreRes.fileName } });
            }
          } catch (err) {
            console.error(err);
            jobs.set(jobId, { status: 'error', meta: { error: err.message } });
            updateJob(jobId, { status: 'error', error: err.message });
          } finally {
            await rm(tDir, { recursive: true, force: true }).catch(() => {});
          }
        })();

        return sendJSON(res, 200, {
          jobId,
          status: 'processing',
          estimatedTime: estimate.text,
          estimatedTimeMs: estimate.ms,
          resultUrl: `/api/result/${jobId}`,
        });
      }

      const tmpDir = await mkdtemp(join(tmpdir(), 'documind-'));
      const tmpPath = join(tmpDir, file.filename);
      await writeFile(tmpPath, file.data);
      const coreResult = await documind({ filePath: tmpPath, model });
      const markdown = await generateMarkdownDocument(coreResult.pages);

      let schemaUsed = null;
      const templateName = (fields.template || '').trim();
      if (fields.schema && fields.schema.trim()) {
        let parsed = JSON.parse(fields.schema.trim());
        if (!Array.isArray(parsed)) {
          if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
          else if (parsed.name && parsed.type) parsed = [parsed];
          else {
            const converted = jsonSchemaToDocumind(parsed);
            if (converted && converted.length > 0) parsed = converted;
          }
        }
        schemaUsed = parsed;
      } else if (templateName && tpls.includes(templateName) && templateName !== '__custom__') {
        schemaUsed = templates.get(templateName);
      }

      const conversionUsage = {
        inputTokens: coreResult.inputTokens || 0,
        outputTokens: coreResult.outputTokens || 0,
        timeMs: coreResult.completionTime || 0,
      };

      let output;
      if (schemaUsed) {
        const { data, usage: extractUsage, time: extractionTime } = await runExtraction(coreResult, schemaUsed, model);

        let filterConfig = null;
        if (fields.filter && fields.filter.trim()) {
          try { filterConfig = JSON.parse(fields.filter); } catch {}
        }
        const filteredData = filterConfig ? applyFilter(data, filterConfig) : data;

        const totalInput = conversionUsage.inputTokens + (extractUsage.inputTokens || 0);
        const totalOutput = conversionUsage.outputTokens + (extractUsage.outputTokens || 0);
        const INPUT_PRICE = 0.15 / 1000000;
        const OUTPUT_PRICE = 0.60 / 1000000;
        const cost = totalInput * INPUT_PRICE + totalOutput * OUTPUT_PRICE;

        output = {
          success: true, pages: coreResult.pages.length, data: filteredData, fileName: coreResult.fileName,
          timing: { total: conversionUsage.timeMs + extractionTime, conversion: conversionUsage.timeMs, extraction: extractionTime },
          tokens: { conversion: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens }, extraction: { input: extractUsage.inputTokens || 0, output: extractUsage.outputTokens || 0 }, total: { input: totalInput, output: totalOutput } },
          cost: { total: +cost.toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
        };
      } else {
        output = {
          success: true, pages: coreResult.pages.length, markdown, fileName: coreResult.fileName,
          timing: { total: coreResult.completionTime, conversion: coreResult.completionTime },
          tokens: { conversion: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens }, total: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens } },
        };
      }

      await rm(tmpDir, { recursive: true, force: true });
      sendJSON(res, 200, output);

    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/classify' && req.method === 'POST') {
    const apiUser = authGuard(req, res);
    if (!apiUser) return;
    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

    const buf = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });
    const raw = buf.toString('latin1');
    const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
    let file = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === '' || trimmed === '--') continue;
      const hEnd = part.indexOf('\r\n\r\n');
      if (hEnd === -1) continue;
      const header = part.slice(0, hEnd);
      const fn = header.match(/filename="([^"]*)"/)?.[1];
      const body = part.slice(hEnd + 4);
      if (fn !== undefined) {
        const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
        file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
      }
    }
    if (!file) return sendJSON(res, 400, { error: 'File required' });

    const tDir = await mkdtemp(join(tmpdir(), 'documind-classify-'));
    const tPath = join(tDir, file.filename);
    await writeFile(tPath, file.data);

    try {
      const model = process.env.MODEL || 'gemini-2.5-flash';
      const classifyStart = Date.now();
      const coreResult = await documind({ filePath: tPath, model });
      const markdown = await generateMarkdownDocument(coreResult.pages);

      // Classification — dynamic prompt from templates
      // Hybrid classification: keywords first, Gemini fallback if ambiguous
      const tpls = getTemplates().filter(t => t.name && t.keywords);
      const lowerMD = markdown.toLowerCase();

      // Step 1: Keyword matching
      const scored = tpls.map(tpl => {
        const keywords = tpl.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 2);
        const hits = keywords.filter(k => lowerMD.includes(k));
        return { tpl, hits, matched: hits };
      }).sort((a, b) => b.hits.length - a.hits.length);

      const best = scored[0] || { tpl: null, hits: [] };
      const runnerUp = scored[1] || { hits: [] };
      let classification;

      // Clear winner (3+ keyword hits, significant lead)
      if (best.hits.length >= 3 && (best.hits.length - runnerUp.hits.length) >= 1) {
        classification = { template_id: best.tpl.id, template_name: best.tpl.name, confidence: 'high', method: 'keywords' };
      } else if (best.hits.length >= 1) {
        // Ambiguous — ask Gemini with keyword context
        const allHits = scored.map(s => `${s.tpl.id} (${s.tpl.name}): matched ${s.hits.length} keywords [${s.hits.slice(0,3).join(', ')}]`).join('\n');
        const geminiPrompt = `Classify this aviation document. Keyword analysis:\n${allHits}\n\nBased on keywords AND document content, return ONLY the template ID (e.g., np_001) or Unknown.`;
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const clsModel = genAI.getGenerativeModel({ model, generationConfig: { maxOutputTokens: 16 } });
          const clsRes = await clsModel.generateContent(geminiPrompt + '\n\nDocument:\n' + markdown.slice(0, 6000));
          const clsText = clsRes.response.text().trim();
          const matched = tpls.find(t => clsText.includes(t.id));
          classification = matched
            ? { template_id: matched.id, template_name: matched.name, confidence: 'medium', method: 'ai' }
            : { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai' };
        } catch {
          classification = { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai-failed' };
        }
      } else {
        // No keyword hits — ask Gemini directly
        const templateList = tpls.map(t => `${t.id} (${t.name}): ${t.keywords}`).join('\n');
        const geminiPrompt = `You are an aviation document classifier. Determine the SINGLE best document type from this list:\n${templateList}\n\nRULES:\n- Choose the type whose keywords and description best match the document content.\n- Do NOT guess based on generic words like "USD", "quantity", or "amount" — those appear in all invoices.\n- If the document clearly belongs to a specific type, return its template ID.\n- If unsure, return Unknown.\n\nReturn ONLY the template ID (e.g., np_001) or the word Unknown.`;
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const clsModel = genAI.getGenerativeModel({ model, generationConfig: { maxOutputTokens: 16 } });
          const clsRes = await clsModel.generateContent(geminiPrompt + '\n\nDocument:\n' + markdown.slice(0, 6000));
          const clsText = clsRes.response.text().trim();
          const matched = tpls.find(t => clsText.includes(t.id));
          classification = matched
            ? { template_id: matched.id, template_name: matched.name, confidence: 'medium', method: 'ai' }
            : { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai' };
        } catch {
          classification = { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai-failed' };
        }
      }

      sendJSON(res, 200, {
        success: true,
        template_id: classification.template_id,
        template_name: classification.template_name,
        confidence: classification.confidence,
        method: classification.method,
        keywordHits: best.hits.length,
        matchedKeywords: best.hits,
        allScores: scored.map(s => ({ id: s.tpl.id, name: s.tpl.name, hits: s.hits.length, keywords: s.hits })),
        timing: { conversion: coreResult.completionTime },
        pages: coreResult.pages.length,
        fileName: file.filename,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    } finally {
      await rm(tDir, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  if (url.pathname === '/api/templates' && req.method === 'GET') {
    if (!authGuard(req, res)) return;
    return sendJSON(res, 200, getTemplates());
  }

  if (url.pathname === '/api/templates' && req.method === 'POST') {
    if (!authGuard(req, res)) return;
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const tpl = addTemplate(data);
      sendJSON(res, 200, tpl);
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/templates/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!authGuard(req, res)) return;
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') {
      const ok = deleteTemplate(id);
      return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' });
    }
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const tpl = updateTemplate(id, data);
      sendJSON(res, tpl ? 200 : 404, tpl || { error: 'Not found' });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/schema/generate' && req.method === 'POST') {
    const apiUser = authGuard(req, res);
    if (!apiUser) return;

    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

    let tmpDir;
    try {
      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      const files = [];
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          files.push({ data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' });
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!files.length) {
        return sendJSON(res, 400, { error: 'File is required' });
      }
      if (files.length > MAX_SCHEMA_FILES) {
        return sendJSON(res, 400, { error: `Rate limit for number of files: maximum ${MAX_SCHEMA_FILES} files` });
      }
      for (const f of files) {
        const ext = extname(f.filename).slice(1).toLowerCase();
        if (!SCHEMA_ALLOWED.includes(ext)) {
          return sendJSON(res, 400, { error: `Unsupported file type: ${ext}. Allowed: ${SCHEMA_ALLOWED.join(', ')}` });
        }
      }

      const model = fields.model || process.env.MODEL || 'gemini-2.5-flash';
      const instructions = (fields.instructions || '').trim() || undefined;

      tmpDir = await mkdtemp(join(tmpdir(), 'documind-schema-'));
      const docFiles = [];
      for (const f of files) {
        const uploadPath = join(tmpDir, f.filename);
        await writeFile(uploadPath, f.data);
        docFiles.push({ name: f.filename, path: uploadPath });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const estimatedMs = docFiles.length * 25000 + 15000;
      const eta = estimatedMs < 60000 ? `~${Math.round(estimatedMs / 1000)}s` : `~${Math.round(estimatedMs / 60000)} min`;

      schemaJobs.set(jobId, { status: 'processing', eta, fileCount: docFiles.length });
      addJob(jobId, { fileName: files[0].filename, status: 'in-progress', schema: null, filter: null, templateName: 'schema-generation', apiKeyName: apiUser._apiKeyName || null, createdAt: Date.now() }, apiUser.id);

      (async () => {
        try {
          const result = await generateSchema({ files: docFiles, model, instructions });
          schemaJobs.set(jobId, { status: 'done', ...result });
          updateJob(jobId, { status: 'done', pages: result.files.reduce((s, f) => s + (f.pages || 0), 0), timing: { total: result.timing }, tokens: { extraction: result.usage, total: result.usage }, geminiCalls: result.files.length * 2, resultData: { success: true, schema: result.schema }, fileName: files[0].filename });
        } catch (jobErr) {
          console.error(jobErr);
          schemaJobs.set(jobId, { status: 'error', meta: { error: jobErr.message } });
          updateJob(jobId, { status: 'error', error: jobErr.message });
        } finally {
          if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      })();

      return sendJSON(res, 200, { jobId, status: 'processing', estimatedTime: eta, estimatedTimeMs: estimatedMs, resultUrl: `/api/schema/result/${jobId}` });
    } catch (err) {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      console.error(err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  if (url.pathname.startsWith('/api/schema/result/') && req.method === 'GET') {
    const apiUser = authGuard(req, res);
    if (!apiUser) return;
    const jobId = url.pathname.split('/').pop();
    const job = schemaJobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    const { status, eta, schema, files, usage, timing, meta } = job;
    sendJSON(res, 200, { status, eta, schema, files, usage, timing, meta });
    if (status === 'done' || status === 'error') {
      setTimeout(() => schemaJobs.delete(jobId), 120000);
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, async () => {
  await loadStore();
  // Seed admin user if none exist
  if (getUsers().length === 0) {
    const pw = crypto.randomBytes(8).toString('hex');
    const hash = await hashPassword(pw);
    const co = addCompany('Neopxl');
    addUser({ email: 'admin@neopxl.ai', password_hash: hash, role: 1, company_id: co?.id || '', company_name: 'Neopxl' });
    console.log('=== FIRST RUN ===');
    console.log('Admin login: admin@neopxl.ai');
    console.log('Admin password:', pw);
    console.log('================');
  }
  console.log(`Neopxl AI at http://localhost:${PORT}`);
});
