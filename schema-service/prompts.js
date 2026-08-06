export const AUTO_SCHEMA_PROMPT = (markdown, strict = false) => `
Read the following markdown content and generate a schema of useful structured data that can be extracted from it. Follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
- ${strict ? 'ABSOLUTE LIMIT: at most 15 fields in total across all nesting levels. Descriptions must be 10 words or fewer. Maximum nesting depth 2.' : 'Keep the schema COMPACT: at most 50 fields in total across all nesting levels.'}
- Repeated line items must become ONE array field with children — never one field per occurrence.
- Use generic, reusable field names (e.g. \`description\`, \`net_amount\`, \`aircraft_registration\`) instead of values from the document.
- Return ONLY valid JSON matching the schema. No prose, no commentary, no markdown code fences.
"""${markdown}"""
`;

export const INSTRUCTIONS_SCHEMA_PROMPT = (markdown, data, strict = false) => `
Read the following markdown content and generate a schema for the structured data I require: """${data}""". Use only the fields listed, and follow these rules strictly:
- The \`children\` field **must only be present if the \`type\` is \`object\` or \`array\`. It should never exist for other types.
- \`description\` fields should be concise, no longer than one sentence.
- ${strict ? 'ABSOLUTE LIMIT: at most 15 fields in total across all nesting levels. Descriptions must be 10 words or fewer. Maximum nesting depth 2.' : 'Keep the schema COMPACT: at most 50 fields in total across all nesting levels.'}
- Repeated line items must become ONE array field with children — never one field per occurrence.
- Return ONLY valid JSON matching the schema. No prose, no commentary, no markdown code fences.
"""${markdown}"""
`;
