import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonrepair } from "jsonrepair";

// Local models (via Ollama) support structured output through the OpenAI-compat
// endpoint's `json_schema` response_format (Ollama >= 0.5). We enforce the schema
// there so the model cannot return fields outside the configured schema — the same
// guarantee Gemini gets from `responseSchema`. The prompt outline below is kept as
// a reinforcement, and we fall back to plain JSON mode if a schema is rejected.

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

  const messages = [
    { role: "system", content: effectivePrompt },
    { role: "user", content: markdown },
  ];

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_schema", json_schema: { name: "documind", schema: jsonSchema, strict: true } },
      temperature: 0,
      max_tokens: maxOutputTokens,
    });
  } catch (err) {
    // Older Ollama, or a schema it can't enforce: fall back to plain JSON mode.
    console.warn(`[ollama] structured output rejected (${err?.message || err}) — falling back to json_object`);
    completion = await openai.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: maxOutputTokens,
    });
  }

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
