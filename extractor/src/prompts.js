export const BASE_EXTRACTION_PROMPT = `
You are an expert in structured data extraction. Your task is to extract information from unstructured content and transform it into the specified structure. Follow these rules strictly:

1. Handle Missing or Undetermined Data:
- If any field's information is missing, unknown, or cannot be determined, return its value as null.
- **Do not use substitutes such as "unknown," "missing," or any other placeholder for missing or unknown data. The value **must** always be explicitly null.
`;

export const AUTO_SCHEMA_PROMPT = (markdown) => `
Read the following markdown content and generate a schema of useful structured data that can be extracted from it. Follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
"""${markdown}"""
`;

export const INSTRUCTIONS_SCHEMA_PROMPT = (markdown, data) => `
Read the following markdown content and generate a schema for the structured data I require: """${data}""". Use only the fields listed, and follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
"""${markdown}"""
`;