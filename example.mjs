import 'dotenv/config';
import { convertToZodSchema } from './extractor/src/utils/convertToZodSchema.js';
import { getExtractor } from './extractor/src/extractors/index.js';
import { BASE_EXTRACTION_PROMPT } from './extractor/src/prompts.js';
import { getTemplate } from './extractor/src/services/templates.js';
import { documind } from 'core';
import { generateMarkdownDocument } from './extractor/src/utils/generateMarkdown.js';

const filePath = process.argv[2] || './extractor/src/templates/examples/bank_statement.pdf';
const templateName = process.argv[3] || 'bank_statement';
const model = process.env.MODEL || 'gemini-1.5-flash';

async function run() {
  const result = await documind({ filePath, model });
  const markdown = await generateMarkdownDocument(result.pages);

  const template = getTemplate(templateName);
  const zodSchema = convertToZodSchema(template);
  const extractor = getExtractor(model);

  const data = await extractor({
    markdown,
    zodSchema,
    prompt: BASE_EXTRACTION_PROMPT,
    model,
  });

  console.log(JSON.stringify({ success: true, pages: result.pages.length, data, fileName: result.fileName }, null, 2));
}

run().catch(console.error);
