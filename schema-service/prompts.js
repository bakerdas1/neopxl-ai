export const AUTO_SCHEMA_PROMPT = (markdown, strict = false) => `
Read the following markdown content and generate a schema of useful structured data that can be extracted from it. Follow these rules strictly:
- Return ONLY valid JSON in EXACTLY this envelope, with a top-level \`fields\` array (each entry has \`name\`, \`type\` in ["string","number","array","object"], an optional short \`description\`, and an optional \`children\` array of nested fields):
  {"fields":[{"name":"field_name","type":"string","description":"short noun phrase","children":[]}]}
- The \`children\` field is REQUIRED when the \`type\` is \`object\` or \`array\` and must contain at least one child field. Never emit an object or array without children.
- \`description\` fields MUST be at most 12 words: a single short noun phrase. No sentences, no paragraphs, never repeat or rephrase the same text.
- ${strict ? 'ABSOLUTE LIMIT: at most 15 fields in total across all nesting levels. Descriptions must be 10 words or fewer. Maximum nesting depth 2.' : 'Keep the schema COMPACT: at most 50 fields in total across all nesting levels.'}
- Repeated line items must become ONE array field with children — never one field per occurrence.
- Use generic, reusable field names (e.g. \`description\`, \`net_amount\`, \`aircraft_registration\`) instead of values from the document.
- No prose, no commentary, no markdown code fences. Return ONLY the JSON object described above.
"""${markdown}"""
`;

export const INSTRUCTIONS_SCHEMA_PROMPT = (markdown, data, strict = false) => `
Read the following markdown content and generate a schema for the structured data I require: """${data}""". Use only the fields listed, and follow these rules strictly:
- Return ONLY valid JSON in EXACTLY this envelope, with a top-level \`fields\` array (each entry has \`name\`, \`type\` in ["string","number","array","object"], an optional short \`description\`, and an optional \`children\` array of nested fields):
  {"fields":[{"name":"field_name","type":"string","description":"short noun phrase","children":[]}]}
- The \`children\` field is REQUIRED when the \`type\` is \`object\` or \`array\` and must contain at least one child field. Never emit an object or array without children.
- \`description\` fields MUST be at most 12 words: a single short noun phrase. No sentences, no paragraphs, never repeat or rephrase the same text.
- ${strict ? 'ABSOLUTE LIMIT: at most 15 fields in total across all nesting levels. Descriptions must be 10 words or fewer. Maximum nesting depth 2.' : 'Keep the schema COMPACT: at most 50 fields in total across all nesting levels.'}
- Repeated line items must become ONE array field with children — never one field per occurrence.
- No prose, no commentary, no markdown code fences. Return ONLY the JSON object described above.
"""${markdown}"""
`;
