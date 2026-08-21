import { createReadStream } from 'fs';
import { mkdir, writeFile, stat, rm, rmdir } from 'fs/promises';
import { Readable } from 'stream';
import { join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSetting, setSetting } from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, 'uploads');

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
};

const SETTING_KEY = 'storage';

let storageCfg = null;
let s3Client = null;

async function loadConnectorList() {
  let v = await getSetting(SETTING_KEY);
  if (v && Array.isArray(v.connectors)) {
    return { connectors: v.connectors, activeId: v.activeId ?? v.connectors[0]?.id ?? null };
  }
  if (v && (v.provider || v.type)) {
    const type = v.provider || v.type;
    const conn = { id: type === 's3' ? 's3' : 'local', name: type === 's3' ? 'S3' : 'Local', type, status: 'connected', s3: v.s3 || {} };
    const out = { connectors: [conn], activeId: conn.id };
    await setSetting(SETTING_KEY, out);
    return out;
  }
  const out = { connectors: [{ id: 'local', name: 'Local', type: 'local', status: 'connected', s3: {} }], activeId: 'local' };
  await setSetting(SETTING_KEY, out);
  return out;
}

export async function loadStorageConfig() {
  const { connectors, activeId } = await loadConnectorList();
  storageCfg = connectors.find(c => c.id === activeId) || connectors[0] || null;
  rebuildS3Client();
  return storageCfg;
}

export async function getStorageConnectors() {
  const { connectors, activeId } = await loadConnectorList();
  return { connectors: connectors.map(c => ({ ...c, active: c.id === activeId })), activeId };
}

export async function getStorageConnector(id) {
  const { connectors } = await loadConnectorList();
  return connectors.find(c => c.id === id) || null;
}

export async function addStorageConnector(conn) {
  const list = await loadConnectorList();
  const exists = list.connectors.findIndex(c => c.id === conn.id);
  const fresh = { ...conn, status: 'connected' };
  if (exists >= 0) list.connectors[exists] = fresh;
  else list.connectors.push(fresh);
  if (!list.activeId) list.activeId = conn.id;
  await setSetting(SETTING_KEY, list);
  return getStorageConnectors();
}

export async function deleteStorageConnector(id) {
  const list = await loadConnectorList();
  list.connectors = list.connectors.filter(c => c.id !== id);
  if (list.activeId === id) list.activeId = list.connectors[0]?.id || null;
  await setSetting(SETTING_KEY, list);
  await loadStorageConfig();
  return getStorageConnectors();
}

export async function setActiveStorageConnector(id) {
  const list = await loadConnectorList();
  if (!list.connectors.some(c => c.id === id)) throw new Error('Connector not found');
  list.activeId = id;
  await setSetting(SETTING_KEY, list);
  await loadStorageConfig();
  return getStorageConnectors();
}

export function isS3Enabled() {
  return storageCfg?.type === 's3' && !!storageCfg.s3;
}

function rebuildS3Client() {
  if (isS3Enabled()) {
    const s = storageCfg.s3;
    s3Client = new S3Client({
      region: s.region || 'us-east-1',
      endpoint: s.endpoint || undefined,
      forcePathStyle: !!s.endpoint,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    });
  } else {
    s3Client = null;
  }
}

function keyFor(jobId, name) {
  const prefix = (storageCfg?.s3?.prefix || '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${jobId}/${name}` : `${jobId}/${name}`;
}

function safeName(filename) {
  return basename(filename).replace(/[^\w.\- ]+/g, '_');
}

export async function putJobFiles(jobId, files) {
  const saved = [];
  const storageId = storageCfg?.id || 'local';
  if (isS3Enabled()) {
    const bucket = storageCfg.s3.bucket;
    for (const f of files) {
      const name = safeName(f.filename);
      const ext = extname(name).slice(1).toLowerCase();
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: keyFor(jobId, name),
        Body: f.data,
        ContentType: MIME[ext] || 'application/octet-stream',
      }));
      saved.push({ name, ext, storageId });
    }
  } else {
    const dir = join(UPLOAD_DIR, jobId);
    await mkdir(dir, { recursive: true });
    for (const f of files) {
      const name = safeName(f.filename);
      await writeFile(join(dir, name), f.data);
      saved.push({ name, ext: extname(name).slice(1).toLowerCase(), storageId });
    }
  }
  return saved;
}

export async function openJobFile(jobId, entry, connector) {
  const cfg = connector || storageCfg;
  const isS3 = cfg?.type === 's3' && !!cfg.s3;
  if (isS3) {
    const client = connector
      ? new S3Client({
          region: cfg.s3.region || 'us-east-1',
          endpoint: cfg.s3.endpoint || undefined,
          forcePathStyle: !!cfg.s3.endpoint,
          credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey },
        })
      : s3Client;
    const prefix = (cfg.s3.prefix || '').replace(/^\/+|\/+$/g, '');
    const key = prefix ? `${prefix}/${jobId}/${entry.name}` : `${jobId}/${entry.name}`;
    try {
      const out = await client.send(new GetObjectCommand({
        Bucket: cfg.s3.bucket,
        Key: key,
      }));
      let stream;
      if (typeof out.Body?.transformToWebStream === 'function') {
        stream = Readable.fromWeb(out.Body.transformToWebStream());
      } else if (out.Body) {
        stream = out.Body;
      } else {
        return null;
      }
      return { stream, size: out.ContentLength || 0, ext: entry.ext };
    } catch (e) {
      console.error('s3 open failed', e.message);
      return null;
    }
  }
  try {
    const filePath = join(UPLOAD_DIR, jobId, entry.name);
    if (basename(filePath) !== entry.name) return null;
    const info = await stat(filePath);
    return { stream: createReadStream(filePath), size: info.size, ext: entry.ext };
  } catch {
    return null;
  }
}

export async function deleteJobFiles(jobId, entries) {
  if (!entries || !entries.length) return;
  for (const entry of entries) {
    const connId = entry.storageId;
    const conn = connId ? await getStorageConnector(connId) : storageCfg;
    const isS3 = conn?.type === 's3' && !!conn.s3;
    if (isS3) {
      const client = connId
        ? new S3Client({
            region: conn.s3.region || 'us-east-1',
            endpoint: conn.s3.endpoint || undefined,
            forcePathStyle: !!conn.s3.endpoint,
            credentials: { accessKeyId: conn.s3.accessKeyId, secretAccessKey: conn.s3.secretAccessKey },
          })
        : s3Client;
      try {
        const prefix = (conn.s3.prefix || '').replace(/^\/+|\/+$/g, '');
        const key = prefix ? `${prefix}/${jobId}/${entry.name}` : `${jobId}/${entry.name}`;
        await client.send(new DeleteObjectsCommand({
          Bucket: conn.s3.bucket,
          Delete: { Objects: [{ Key: key }], Quiet: true },
        }));
      } catch (e) {
        console.error('s3 delete failed', e.message);
      }
    } else {
      try {
        const filePath = join(UPLOAD_DIR, jobId, entry.name);
        if (basename(filePath) === entry.name) await rm(filePath, { force: true });
      } catch {}
    }
  }
  try { await rmdir(join(UPLOAD_DIR, jobId)); } catch {}
}

export async function testS3Connection(cfg) {
  const s = cfg.s3 || {};
  const client = new S3Client({
    region: s.region || 'us-east-1',
    endpoint: s.endpoint || undefined,
    forcePathStyle: !!s.endpoint,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
  await client.send(new HeadBucketCommand({ Bucket: s.bucket }));
}
