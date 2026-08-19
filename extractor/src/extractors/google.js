import { GoogleGenerativeAI } from "@google/generative-ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonrepair } from "jsonrepair";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableStatus(err) {
  const status = err?.response?.status || err?.status || err?.statusCode;
  const msg = String(err?.message || '');
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
    || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Too Many Requests')
    || msg.includes('internal server error') || msg.includes('unavailable');
}

async function callWithRetry(fn, { maxAttempts = 5, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableStatus(err) || attempt === maxAttempts) throw err;
      const jitter = 0.7 + Math.random() * 0.6;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) * jitter, 30000);
      console.warn(`[google] retryable error (${err?.response?.status || err?.status || err?.statusCode || err?.message}), attempt ${attempt}/${maxAttempts} — retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export const googleExtractor = async ({ markdown, zodSchema, prompt, model, repairJson = false, disableResponseSchema = false, maxOutputTokens = 65536, thinkingBudget }) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

const googleModel = model

// Convert Zod schema to JSON schema (inline all shared schemas — Gemini rejects $ref)
let jsonSchema = zodToJsonSchema(zodSchema, { $refStrategy: "none", target: "openApi3" });

// Remove additionalProperties and $schema keys
const removeKeys = (obj) => {
    if (Array.isArray(obj)) {
        return obj.map(removeKeys);
    } else if (typeof obj === "object" && obj !== null) {
        return Object.fromEntries(
            Object.entries(obj)
                .filter(([key]) => key !== "additionalProperties" && key !== "$schema")
                .map(([key, value]) => [key, removeKeys(value)])
        );
    }
    return obj;
};

jsonSchema = removeKeys(jsonSchema);

// Gemini rejects responseSchema with "too many states" once the schema grows too
// large (long field stacks, many fields, deep nesting). Fall back to plain JSON
// mode and embed a compact schema outline in the prompt so the model still knows
// the required output structure.
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
const schemaJson = JSON.stringify(jsonSchema);
let effectivePrompt = prompt;
if (!disableResponseSchema && schemaJson.length > 12000) {
    disableResponseSchema = true;
    effectivePrompt = `${prompt}\n\nOUTPUT SCHEMA (must match exactly — every field below MUST appear in the output, arrays as arrays, objects as objects):\n{\n${schemaOutline(jsonSchema)}\n}`;
    console.warn(`[google] responseSchema too large (${schemaJson.length} chars) — falling back to prompt-embedded schema`);
}

const generationConfig = {
  responseMimeType: "application/json",
  maxOutputTokens,
  temperature: 0,
};
if (!disableResponseSchema) generationConfig.responseSchema = jsonSchema;
if (typeof thinkingBudget === "number") generationConfig.thinkingConfig = { thinkingBudget };

const modelToUse = genAI.getGenerativeModel({
    model: googleModel,
    systemInstruction: effectivePrompt,
    generationConfig,
    });
    
const result = await callWithRetry(() => modelToUse.generateContent(
    markdown,
  ));

const responseText = result.response.text();
let event;
try {
  event = JSON.parse(responseText);
} catch (parseErr) {
  console.error('Gemini JSON parse failed. Length:', responseText.length, 'Last 200:', JSON.stringify(responseText.slice(-200)));
  if (repairJson) {
    try {
      event = JSON.parse(jsonrepair(responseText));
      console.log('Gemini JSON repaired. Length:', responseText.length);
    } catch {
      throw parseErr;
    }
  } else {
    throw parseErr;
  }
}
const usage = result.response.usageMetadata || {};
return {
    data: event,
    usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
    }
};
}

