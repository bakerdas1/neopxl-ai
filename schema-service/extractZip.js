import AdmZip from 'adm-zip';
import { writeFile } from 'fs/promises';
import { join } from 'path';

export const MAX_ZIP_FILES = 10;
export const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;
export const RATE_LIMIT_MESSAGE = 'Rate limit for number of files in the zip file';

const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'html'];

function isJunkEntry(name) {
  const parts = name.split('/');
  return parts.some((p) => p === '__MACOSX' || p === '.DS_Store' || p.startsWith('._') || p === '.');
}

function sanitizeEntryPath(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Invalid zip entry path: ${name}`);
  }
  return normalized;
}

/**
 * Extracts valid document files from a zip archive.
 * Throws a plain Error with {@link RATE_LIMIT_MESSAGE} when there are more than
 * MAX_ZIP_FILES valid documents inside.
 * @param {string} zipPath - Path to the zip file.
 * @param {string} outputDir - Directory to write extracted files into.
 * @returns {Promise<Array<{name: string, path: string}>>} Extracted document files.
 */
export async function extractZip(zipPath, outputDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const valid = [];
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = sanitizeEntryPath(entry.entryName);
    if (isJunkEntry(name)) continue;

    const ext = name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

    totalSize += entry.header.size;
    if (totalSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Zip file exceeds the maximum allowed total size');
    }

    valid.push({ name: name.split('/').pop(), entry });
  }

  if (valid.length === 0) {
    throw new Error('No valid documents found in zip file');
  }
  if (valid.length > MAX_ZIP_FILES) {
    throw new Error(RATE_LIMIT_MESSAGE);
  }

  const usedNames = new Set();
  const files = [];
  for (const { name, entry } of valid) {
    let fileName = name;
    let i = 1;
    while (usedNames.has(fileName.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      fileName = dot > -1 ? `${name.slice(0, dot)}_${i++}${name.slice(dot)}` : `${name}_${i++}`;
    }
    usedNames.add(fileName.toLowerCase());
    const outPath = join(outputDir, fileName);
    await writeFile(outPath, entry.getData());
    files.push({ name: fileName, path: outPath });
  }

  return files;
}
