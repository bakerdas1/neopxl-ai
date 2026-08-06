import { getExtractor } from '../../extractor/src/extractors/index.js';
import { googleExtractor } from '../../extractor/src/extractors/google.js';
import { AUTO_SCHEMA_PROMPT, INSTRUCTIONS_SCHEMA_PROMPT } from '../prompts.js';
import { baseSchema } from './generation-schemas/base.js';
import { secondarySchema } from './generation-schemas/secondary.js';
import { cleanSchemaFields } from "./cleanSchemaFields.js";
import { z } from 'zod';

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
  });

  const fields = result?.data !== undefined ? result.data?.fields : result?.fields;

  if (!fields) {
    throw new Error("Error auto generating default schema.");
  }

  return cleanSchemaFields(fields);
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
  });

  const fields = result?.data !== undefined ? result.data?.fields : result?.fields;

  if (!fields) {
    throw new Error("Error auto generating specified schema.");
  }

  return cleanSchemaFields(fields);
}

export const autoschema = autogenerateSchema;