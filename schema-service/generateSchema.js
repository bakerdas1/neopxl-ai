import { documind } from 'core';
import { generateMarkdownDocument } from '../extractor/src/utils/generateMarkdown.js';
import { autogenerateSchema } from './autoschema/autogenerateSchema.js';
import { mergeSchemas } from './mergeSchemas.js';
import pLimit from 'p-limit';

const CONCURRENCY = 3;
const MAX_AUTOSCHEMA_CHARS = 30000;
const RETRY_AUTOSCHEMA_CHARS = 10000;

function isTruncatedJsonError(err) {
  return err instanceof SyntaxError || /JSON|Unexpected end/.test(err.message || '');
}

async function generateSchemaFor(markdown, model, autoSchemaArg) {
  try {
    const slice = markdown.length > MAX_AUTOSCHEMA_CHARS ? markdown.slice(0, MAX_AUTOSCHEMA_CHARS) : markdown;
    return await autogenerateSchema(slice, model, autoSchemaArg);
  } catch (err) {
    if (!isTruncatedJsonError(err) || markdown.length <= RETRY_AUTOSCHEMA_CHARS) throw err;
    const retrySlice = markdown.slice(0, RETRY_AUTOSCHEMA_CHARS);
    return await autogenerateSchema(retrySlice, model, autoSchemaArg);
  }
}

/**
 * Generates a merged extraction schema from one or more document files.
 * @param {object} options
 * @param {Array<{name: string, path: string}>} options.files - Document files to analyze.
 * @param {string} [options.model] - LLM model to use.
 * @param {string} [options.instructions] - Optional instructions describing the fields to extract.
 * @returns {Promise<{schema: Array<object>, files: Array<object>, usage: object, timing: number}>}
 */
export async function generateSchema({ files, model = process.env.MODEL || 'gemini-2.5-flash', instructions }) {
  const autoSchemaArg = instructions && instructions.trim() ? { instructions: instructions.trim() } : true;
  const limit = pLimit(CONCURRENCY);

  const perFile = await Promise.all(
    files.map((f) =>
      limit(async () => {
        const start = Date.now();
        const coreResult = await documind({ filePath: f.path, model });
        const markdown = await generateMarkdownDocument(coreResult.pages);

        const schemaStart = Date.now();
        const fields = await generateSchemaFor(markdown, model, autoSchemaArg);
        const schemaTime = Date.now() - schemaStart;

        if (!Array.isArray(fields)) {
          throw new Error(`Failed to generate a schema for ${f.name}`);
        }

        return {
          name: f.name,
          fields,
          pages: coreResult.pages.length,
          usage: {
            inputTokens: coreResult.inputTokens || 0,
            outputTokens: coreResult.outputTokens || 0,
          },
          time: Date.now() - start,
          schemaTime,
        };
      })
    )
  );

  const schema = mergeSchemas(...perFile.map((r) => r.fields));

  return {
    schema,
    files: perFile.map(({ fields, ...rest }) => rest),
    usage: {
      inputTokens: perFile.reduce((s, r) => s + (r.usage.inputTokens || 0), 0),
      outputTokens: perFile.reduce((s, r) => s + (r.usage.outputTokens || 0), 0),
    },
    timing: perFile.reduce((s, r) => s + (r.time || 0), 0),
  };
}
