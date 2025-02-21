import { GoogleGenerativeAI } from "@google/generative-ai";
import { zodToJsonSchema } from "zod-to-json-schema";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const googleExtractor = async ({ markdown, zodSchema, prompt, model }) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

const googleModel = model

// Convert Zod schema to JSON schema
let jsonSchema = zodToJsonSchema(zodSchema);

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
      },
    });
    
const result = await modelToUse.generateContent(
    markdown,
  );

//console.log(result.response.text());
const event = result.response.text();
return event;
}

