import { extractData } from '../main-extractor.js'; 
import { isPdfFile } from '../utils/pdfValidator.js';
import { validateSchema } from '../utils/schemaValidator.js';

/**
 * Extracts data from a document based on a provided schema.
 * @param {object} options - Options for the extraction process.
 * @param {string} options.file - The file path to the document.
 * @param {object} options.schema - The schema definition for data extraction.
 * @returns {Promise<object>} - The result of the extraction, including pages, extracted data, and file name.
 */
export async function extract({ file, schema }) {
  try {
    if (!file || !schema) {
      throw new Error('Both file and schema are required');
    }

    if (!isPdfFile(file)) {
      throw new Error('File must be a PDF');
    }

    const { isValid, errors } = validateSchema(schema);
    if (!isValid) {
      throw new Error(`Invalid schema format: ${errors.join(', ')}`);
    }

    const result = await extractData(file, schema);

    return {
      success: true,
      pages: result.totalPages,
      data: result.event,
      fileName: result.fileName
    };
  } catch (error) {
    console.error('Error processing document:', error);
    throw new Error(`Failed to process document: ${error.message}`);
  }
}
