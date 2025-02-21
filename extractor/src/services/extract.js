import { isValidFile } from '../utils/fileValidator.js';
import { validateSchema } from '../utils/schemaValidator.js';
import { getTemplate } from './templates.js';
import { convertToZodSchema } from '../utils/convertToZodSchema.js';
import { autogenerateSchema } from "../autoschema/autogenerateSchema.js";
import { convertFile } from '../converter.js';
import { BASE_EXTRACTION_PROMPT } from "../prompts.js";
import { getExtractor } from '../extractors/index.js';

/**
 * Extracts data from a document based on a provided schema.
 * @param {object} options - Options for the extraction process.
 * @param {string} options.file - The file path to the document.
 * @param {object} options.schema - The schema definition for data extraction.
 * @param {string} [options.template] - Name of a pre-defined template.
 * @param {string} [options.model] - The llm model to use if a base url is set.
 * @param {boolean | object} [options.autoSchema] - Option to auto-generate the schema.
 * @returns {Promise<object>} - The result of the extraction, including pages, extracted data, and file name.
 */
export async function extract({ file, schema, template, model, autoSchema }) {
  try {

    const defaultModel = model || "gpt-4o-mini";

    if (!file) {
      throw new Error("File is required.");
    }

    if (!isValidFile(file)) {
      throw new Error("Invalid file type.");
    }

    let finalSchema = null;
    if (template) {
      finalSchema = getTemplate(template); 
    } else if (schema) {
      const { isValid, errors } = validateSchema(schema);
      if (!isValid) {
        throw new Error(`Invalid schema: ${errors.join(", ")}`);
      }
      finalSchema = schema;
    } else if (!autoSchema) {
      throw new Error("You must provide a schema, template, or enable autoSchema.");
    }

    const { markdown, totalPages, fileName } = await convertFile(file, defaultModel);

    if (autoSchema) {
      finalSchema = await autogenerateSchema(markdown, defaultModel, autoSchema); 
      if (!finalSchema) {
        throw new Error("Failed to auto-generate schema.");
      }
    }

    const dynamicZodSchema = convertToZodSchema(finalSchema);
    const extraction = getExtractor(defaultModel);

    const event = await extraction({
      markdown,
      zodSchema: dynamicZodSchema,
      prompt: BASE_EXTRACTION_PROMPT,
      model: defaultModel,
    });

    return {
      success: true,
      pages: totalPages,
      data: event,
      fileName,
      markdown,
    };
  } catch (error) {
    console.error("Error processing document:", error);
    throw new Error(`Failed to process document: ${error.message}`);
  }
}
