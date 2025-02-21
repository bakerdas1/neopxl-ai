import { getExtractor } from '../extractors/index.js';
import { googleExtractor } from '../extractors/google.js';
import { AUTO_SCHEMA_PROMPT, INSTRUCTIONS_SCHEMA_PROMPT } from "../prompts.js";
import { baseSchema } from './generation-schemas/base.js';
import { secondarySchema } from './generation-schemas/secondary.js';
import { cleanSchemaFields } from "./cleanSchemaFields.js";
import { z } from 'zod';

export async function autogenerateSchema(markdown, model, autoSchema) {
  if (autoSchema === true) {
    return await blanketSchema(markdown, model);
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
      autoSchema.instructions
    );
  }

  return await blanketSchema(markdown, model);
}

async function blanketSchema(markdown, model) {
  const extraction = getExtractor(model);
  const schemaToUse = extraction === googleExtractor ? secondarySchema : baseSchema;
  
  const result = await extraction({
    markdown,
    zodSchema: schemaToUse,
    prompt: AUTO_SCHEMA_PROMPT(markdown),
    model: model, 
  });

  if (!result || !result.fields) {
    throw new Error("Error auto generating default schema.");
  }

  return cleanSchemaFields(result.fields);
}

async function instructionBasedSchema(markdown, model, instructions) {

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

  if (!instructionFields || !instructionFields.fields) {
    throw new Error("Error identifying the fields to be extracted.");
  }

  const data = instructionFields.fields;

  const schemaToUse = extraction === googleExtractor ? secondarySchema : baseSchema;

  const result = await extraction({
    markdown,
    zodSchema: schemaToUse,
    prompt: INSTRUCTIONS_SCHEMA_PROMPT(markdown, data),
    model: model,
  });

  if (!result || !result.fields) {
    throw new Error("Error auto generating specified schema.");
  }

  return cleanSchemaFields(result.fields);
}

export const autoschema = autogenerateSchema;