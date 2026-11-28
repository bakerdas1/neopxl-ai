import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonrepair } from "jsonrepair";

// NuExtract is a purpose-built "document → JSON" model. It takes a *template*
// (a JSON object whose leaf values are type hints) plus the document, and
// returns JSON matching the template. Convert a Zod schema → NuExtract template.
function toTemplate(schema) {
  if (!schema || typeof schema !== "object") return "string";
  if (Array.isArray(schema)) return schema.map(toTemplate);
  if (schema.enum) return schema.enum; // enum → array of allowed options
  if (schema.type === "object" && schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties)) out[k] = toTemplate(v);
    return out;
  }
  if (schema.type === "array" && schema.items) return [toTemplate(schema.items)];
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "number";
  if (schema.type === "boolean") return "string";
  // verbatim-string = copy text exactly from the document (no paraphrasing).
  return "verbatim-string";
}

export const nuextractExtractor = async ({ markdown, zodSchema, model, maxOutputTokens = 65536 }) => {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const openai = new OpenAI({ baseURL, apiKey: "ollama" });

  const jsonSchema = zodToJsonSchema(zodSchema, { $refStrategy: "none", target: "openApi3" });
  const template = toTemplate(jsonSchema);
  const prompt = `# Template:\n${JSON.stringify(template)}\n# Context:\n${markdown}`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are NuExtract, an information extraction tool created by NuMind." },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: maxOutputTokens,
  });

  const responseText = completion.choices?.[0]?.message?.content || "";
  let event;
  try {
    event = JSON.parse(responseText);
  } catch (parseErr) {
    // NuExtract can occasionally emit slightly invalid JSON — repair it.
    event = JSON.parse(jsonrepair(responseText));
  }

  const usage = completion.usage || {};
  return {
    data: event,
    usage: {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    },
  };
};
