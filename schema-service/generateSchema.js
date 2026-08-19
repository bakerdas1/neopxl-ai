import { documind } from 'core';
import { generateMarkdownDocument } from '../extractor/src/utils/generateMarkdown.js';
import { autogenerateSchema, SchemaRetryableError } from './autoschema/autogenerateSchema.js';
import { mergeSchemas } from './mergeSchemas.js';
import pLimit from 'p-limit';

const CONCURRENCY = 3;
const SLICES = [30000, 10000, 4000];

function isRetryableError(err) {
  return err instanceof SchemaRetryableError || isTruncatedJsonError(err);
}

function isTruncatedJsonError(err) {
  return err instanceof SyntaxError || /JSON|Unexpected end/.test(err.message || '');
}

async function generateSchemaFor(markdown, model, autoSchemaArg) {
  const sizes = [...new Set(SLICES.map((n) => Math.min(n, markdown.length)))];
  let lastErr;
  for (let i = 0; i < sizes.length; i++) {
    try {
      return await autogenerateSchema(markdown.slice(0, sizes[i]), model, autoSchemaArg, i > 0);
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
    }
  }
  throw lastErr;
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
        const { fields, usage: schemaUsage } = await generateSchemaFor(markdown, model, autoSchemaArg);
        const schemaTime = Date.now() - schemaStart;

        if (!Array.isArray(fields)) {
          throw new Error(`Failed to generate a schema for ${f.name}`);
        }

        const conversion = {
          input: coreResult.inputTokens || 0,
          output: coreResult.outputTokens || 0,
        };
        const schemaGeneration = {
          input: schemaUsage?.inputTokens || 0,
          output: schemaUsage?.outputTokens || 0,
        };

        return {
          name: f.name,
          fields,
          pages: coreResult.pages.length,
          usage: {
            conversion,
            schemaGeneration,
            total: { input: conversion.input + schemaGeneration.input, output: conversion.output + schemaGeneration.output },
          },
          time: Date.now() - start,
          schemaTime,
        };
      })
    )
  );

  const usage = {
    conversion: perFile.reduce((s, r) => ({ input: s.input + r.usage.conversion.input, output: s.output + r.usage.conversion.output }), { input: 0, output: 0 }),
    schemaGeneration: perFile.reduce((s, r) => ({ input: s.input + r.usage.schemaGeneration.input, output: s.output + r.usage.schemaGeneration.output }), { input: 0, output: 0 }),
  };
  usage.total = { input: usage.conversion.input + usage.schemaGeneration.input, output: usage.conversion.output + usage.schemaGeneration.output };

  const schema = mergeSchemas(...perFile.map((r) => r.fields));

  return {
    schema,
    files: perFile.map(({ fields, ...rest }) => rest),
    usage,
    timing: perFile.reduce((s, r) => s + (r.time || 0), 0),
  };
}
