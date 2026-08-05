import { GoogleGenerativeAI } from "@google/generative-ai";
import { zodToJsonSchema } from "zod-to-json-schema";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const googleExtractor = async ({ markdown, zodSchema, prompt, model }) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

const googleModel = model

// Convert Zod schema to JSON schema (inline all shared schemas — Gemini rejects $ref)
let jsonSchema = zodToJsonSchema(zodSchema, { $refStrategy: "none" });

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

const modelToUse = genAI.getGenerativeModel({
    model: googleModel,
    systemInstruction: prompt,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
      maxOutputTokens: 65536,
      },
    });
    
const result = await modelToUse.generateContent(
    markdown,
  );

const responseText = result.response.text();
let event;
try {
  event = JSON.parse(responseText);
} catch (parseErr) {
  console.error('Gemini JSON parse failed. Length:', responseText.length, 'Last 200:', JSON.stringify(responseText.slice(-200)));
  throw parseErr;
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

