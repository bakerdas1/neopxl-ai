import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonrepair } from "jsonrepair";

// Local models (via Ollama) don't reliably honour a structured-output schema,
// so we mirror the Gemini fallback: request a JSON object and embed a compact
// schema outline in the system prompt, then parse + jsonrepair the result.

const schemaOutline = (schema, indent = "") => {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.properties) {
    const lines = Object.entries(schema.properties).map(([name, def]) => {
      if (def?.type === "object") {
        return `${indent}  ${name}: {\n${schemaOutline(def, indent + "  ")}\n${indent}  }`;
      }
      if (def?.type === "array") {
        const item = def.items || {};
        if (item.type === "object" && item.properties) {
          return `${indent}  ${name}: [ {\n${schemaOutline(item, indent + "    ")}\n${indent}  } ]`;
        }
        return `${indent}  ${name}: [${item.type || "any"}]`;
      }
      return `${indent}  ${name}: ${def?.type || "any"}`;
    });
    return lines.join("\n");
  }
  return schema.type || "any";
};

export const ollamaExtractor = async ({ markdown, zodSchema, prompt, model, repairJson = false, maxOutputTokens = 65536 }) => {
  const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  const openai = new OpenAI({ baseURL, apiKey: 'ollama' });

  const jsonSchema = zodToJsonSchema(zodSchema, { $refStrategy: "none", target: "openApi3" });
  const effectivePrompt = `${prompt}\n\nOUTPUT SCHEMA (return JSON matching this exactly — every field MUST appear, arrays as arrays, objects as objects):\n{\n${schemaOutline(jsonSchema)}\n}\n\nReturn ONLY valid JSON. No markdown fences, no commentary.`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: effectivePrompt },
      { role: "user", content: markdown },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: maxOutputTokens,
  });

  const responseText = completion.choices?.[0]?.message?.content || '';
  let event;
  try {
    event = JSON.parse(responseText);
  } catch (parseErr) {
    if (repairJson) {
      try {
        event = JSON.parse(jsonrepair(responseText));
      } catch {
        throw parseErr;
      }
    } else {
      throw parseErr;
    }
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
