import { getExtractor } from '../../extractor/src/extractors/index.js';
import { googleExtractor } from '../../extractor/src/extractors/google.js';
import { AUTO_SCHEMA_PROMPT, INSTRUCTIONS_SCHEMA_PROMPT } from '../prompts.js';
import { baseSchema } from './generation-schemas/base.js';
import { secondarySchema } from './generation-schemas/secondary.js';
import { cleanSchemaFields } from "./cleanSchemaFields.js";
import { z } from 'zod';

export class SchemaRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaRetryableError";
  }
}

export async function autogenerateSchema(markdown, model, autoSchema, strict = false) {
  if (autoSchema === true) {
    return await blanketSchema(markdown, model, strict);
  }

  if (
    typeof autoSchema === "object" &&
    autoSchema !== null
  ) {
    const keys = Object.keys(autoSchema);
    if (keys.length !== 1 || keys[0] !== "instructions") {
      throw new Error("autoSchema object must only have a single 'instructions' property");
    }

    if (typeof autoSchema.instructions !== "string" || !autoSchema.instructions.trim()) {
      throw new Error("Instructions can't be empty");
    }
  

    return await instructionBasedSchema(
      markdown,
      model,
      autoSchema.instructions,
      strict
    );
  }

  return await blanketSchema(markdown, model, strict);
}

async function blanketSchema(markdown, model, strict = false) {
  const extraction = getExtractor(model);
  const schemaToUse = extraction === googleExtractor ? secondarySchema : baseSchema;
  
  const result = await extraction({
    markdown,
    zodSchema: schemaToUse,
    prompt: AUTO_SCHEMA_PROMPT(markdown, strict),
    model: model,
    repairJson: true,
    disableResponseSchema: true,
    maxOutputTokens: 16384,
    thinkingBudget: 4096,
  });

  const fields = result?.data !== undefined ? result.data?.fields : result?.fields;

  if (!fields) {
    throw new SchemaRetryableError("Error auto generating default schema.");
  }

  const parsed = schemaToUse.safeParse({ fields });
  if (!parsed.success) {
    throw new SchemaRetryableError("Schema generation produced malformed output.");
  }

  const cleaned = cleanSchemaFields(fields);
  if (!cleaned || cleaned.length === 0) {
    throw new SchemaRetryableError("Schema generation produced no usable fields.");
  }

  return { fields: cleaned, usage: result.usage };
}

async function instructionBasedSchema(markdown, model, instructions, strict = false) {

  const instructionsZod = z.object({
    fields: z.array(z.string()),
  });

  const instructionPrompt = `
   Extract the name of the fields the user wants to extract.
  `

  const extraction = getExtractor(model);

  const instructionFields = await extraction({
    markdown: instructions,
    zodSchema: instructionsZod,
    prompt: instructionPrompt,
    model: model,
  });

  const data = instructionFields.data?.fields ?? instructionFields.fields;

  if (!data) {
    throw new Error("Error identifying the fields to be extracted.");
  }

  const schemaToUse = extraction === googleExtractor ? secondarySchema : baseSchema;

  const result = await extraction({
    markdown,
    zodSchema: schemaToUse,
    prompt: INSTRUCTIONS_SCHEMA_PROMPT(markdown, data, strict),
    model: model,
    repairJson: true,
    disableResponseSchema: true,
    maxOutputTokens: 16384,
    thinkingBudget: 4096,
  });

  const fields = result?.data !== undefined ? result.data?.fields : result?.fields;

  if (!fields) {
    throw new SchemaRetryableError("Error auto generating specified schema.");
  }

  const parsed = schemaToUse.safeParse({ fields });
  if (!parsed.success) {
    throw new SchemaRetryableError("Schema generation produced malformed output.");
  }

  const cleaned = cleanSchemaFields(fields);
  if (!cleaned || cleaned.length === 0) {
    throw new SchemaRetryableError("Schema generation produced no usable fields.");
  }

  const usage = {
    inputTokens: (instructionFields.usage?.inputTokens || 0) + (result.usage?.inputTokens || 0),
    outputTokens: (instructionFields.usage?.outputTokens || 0) + (result.usage?.outputTokens || 0),
  };

  return { fields: cleaned, usage };
}

export const autoschema = autogenerateSchema;