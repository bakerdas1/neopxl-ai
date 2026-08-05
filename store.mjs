import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'store.json');

let data = { jobs: [], stats: { totalCalls: 0, totalCost: 0, successful: 0, failed: 0, totalGeminiCalls: 0 }, templates: [], users: [], companies: [], api_keys: [], templateCounter: 0 };

export async function loadStore() {
  try { data = JSON.parse(await readFile(STORE_PATH, 'utf-8')); } catch { await saveStore(); }
  return data;
}

export async function saveStore() {
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

export function addJob(jobId, meta, userId) {
  const job = {
    id: jobId,
    fileName: meta?.fileName || '',
    pages: meta?.pages || 0,
    status: meta?.status || 'in-progress',
    timing: meta?.timing || {},
    tokens: meta?.tokens || {},
    cost: meta?.cost || {},
    geminiCalls: meta?.geminiCalls || 0,
    schema: meta?.schema || null,
    filter: meta?.filter || null,
    templateName: meta?.templateName || null,
    userId: userId || 'system',
    apiKeyName: meta?.apiKeyName || null,
    createdAt: meta?.createdAt || Date.now(),
    completedAt: null,
  };
  data.jobs.push(job);
  saveStore();
  return job;
}

export function updateJob(jobId, updates) {
  const job = data.jobs.find(j => j.id === jobId);
  if (!job) return null;
  if (updates.resultData) {
    try { job.resultData = JSON.stringify(updates.resultData).slice(0, 100000); } catch {}
    delete updates.resultData;
  }
  Object.assign(job, updates);
  if (updates.status === 'done' || updates.status === 'error') {
    job.completedAt = Date.now();
    data.stats.totalCalls++;
    data.stats.totalGeminiCalls += job.geminiCalls || 0;
    if (updates.status === 'done') data.stats.successful++;
    else data.stats.failed++;
    data.stats.totalCost += job.cost?.total || 0;
  }
  saveStore();
  return job;
}

export function getJobs(userId, isAdmin) {
  const jobs = isAdmin ? data.jobs : data.jobs.filter(j => j.userId === userId || j.userId === 'system');
  return jobs.slice().reverse();
}

export function getRecentJobs(limit, userId, isAdmin) {
  return getJobs(userId, isAdmin).slice(0, limit);
}

export function getStats(userId, isAdmin) {
  const all = isAdmin ? data.jobs : data.jobs.filter(j => j.userId === userId || j.userId === 'system');
  const inProgress = all.filter(j => j.status === 'in-progress').length;
  const done = all.filter(j => j.status === 'done');
  const failed = all.filter(j => j.status === 'error');
  return {
    totalJobs: all.length,
    successful: done.length,
    failed: failed.length,
    inProgress,
    totalCost: all.reduce((s, j) => s + (j.cost?.total || 0), 0),
    totalGeminiCalls: all.reduce((s, j) => s + (j.geminiCalls || 0), 0),
    totalCalls: all.length,
  };
}

export function getUsers() {
  return (data.users || []).map(u => ({ id: u.id, email: u.email, role: u.role, company_id: u.company_id, company_name: u.company_name, created_at: u.created_at }));
}

export function getUserByEmail(email) {
  return (data.users || []).find(u => u.email === email);
}

export function addUser(user) {
  if (!data.users) data.users = [];
  const exists = data.users.find(u => u.email === user.email);
  if (exists) return null;
  const id = crypto.randomBytes(12).toString('hex');
  const u = { id, email: user.email, password_hash: user.password_hash, role: user.role || 2, company_id: user.company_id || '', company_name: user.company_name || '', created_at: Date.now() };
  data.users.push(u);
  saveStore();
  return u;
}

export function updateUser(id, updates) {
  if (!data.users) return null;
  const u = data.users.find(u => u.id === id);
  if (!u) return null;
  if (updates.email !== undefined) u.email = updates.email;
  if (updates.password_hash !== undefined) u.password_hash = updates.password_hash;
  if (updates.role !== undefined) u.role = updates.role;
  if (updates.company_id !== undefined) u.company_id = updates.company_id;
  if (updates.company_name !== undefined) u.company_name = updates.company_name;
  saveStore();
  return u;
}

export function deleteUser(id) {
  if (!data.users) return false;
  const idx = data.users.findIndex(u => u.id === id);
  if (idx === -1) return false;
  data.users.splice(idx, 1);
  saveStore();
  return true;
}

export function getCompanies() {
  return data.companies || [];
}

export function addCompany(name) {
  if (!data.companies) data.companies = [];
  const id = crypto.randomBytes(8).toString('hex');
  const c = { id, name, created_at: Date.now() };
  data.companies.push(c);
  saveStore();
  return c;
}

export function updateCompany(id, name) {
  if (!data.companies) return null;
  const c = data.companies.find(c => c.id === id);
  if (!c) return null;
  c.name = name;
  saveStore();
  return c;
}

export function deleteCompany(id) {
  if (!data.companies) return false;
  const idx = data.companies.findIndex(c => c.id === id);
  if (idx === -1) return false;
  data.companies.splice(idx, 1);
  saveStore();
  return true;
}

export function getTemplates() {
  return data.templates || [];
}

export function addTemplate(template) {
  if (!data.templates) data.templates = [];
  if (!data.templateCounter) data.templateCounter = data.templates.length;
  const num = ++data.templateCounter;
  const id = 'np_' + String(num).padStart(3, '0');
  const tpl = { id, name: template.name, schema: template.schema || '', filter: template.filter || '', keywords: template.keywords || '', createdAt: Date.now() };
  data.templates.push(tpl);
  saveStore();
  return tpl;
}

export function updateTemplate(id, updates) {
  if (!data.templates) data.templates = [];
  const tpl = data.templates.find(t => t.id === id);
  if (!tpl) return null;
  if (updates.name !== undefined) tpl.name = updates.name;
  if (updates.schema !== undefined) tpl.schema = updates.schema;
  if (updates.filter !== undefined) tpl.filter = updates.filter;
  if (updates.keywords !== undefined) tpl.keywords = updates.keywords;
  saveStore();
  return tpl;
}

export function deleteTemplate(id) {
  if (!data.templates) data.templates = [];
  const idx = data.templates.findIndex(t => t.id === id);
  if (idx === -1) return false;
  data.templates.splice(idx, 1);
  saveStore();
  return true;
}

export function createApiKey(userId, name) {
  if (!data.api_keys) data.api_keys = [];
  const key = 'neopxl_' + crypto.randomBytes(24).toString('hex');
  const k = { id: crypto.randomBytes(8).toString('hex'), userId, key, name: name || 'API Key', created_at: Date.now(), last_used: null };
  data.api_keys.push(k);
  saveStore();
  return k;
}

export function getUserApiKeys(userId) {
  return (data.api_keys || []).filter(k => k.userId === userId);
}

export function getApiKeyUser(key) {
  const k = (data.api_keys || []).find(k => k.key === key);
  if (!k) return null;
  k.last_used = Date.now();
  saveStore();
  const user = (data.users || []).find(u => u.id === k.userId);
  if (!user) return null;
  const company = (data.companies || []).find(c => c.id === user.company_id);
  return { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: company?.name || '', _apiKeyId: k.id, _apiKeyName: k.name };
}

export function revokeApiKey(id, userId) {
  if (!data.api_keys) return false;
  const idx = data.api_keys.findIndex(k => k.id === id && k.userId === userId);
  if (idx === -1) return false;
  data.api_keys.splice(idx, 1);
  saveStore();
  return true;
}
