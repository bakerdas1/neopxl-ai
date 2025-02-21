import { ollamaExtractor } from "./ollama.js";
import { openAIExtractor } from "./openAI.js";
import { googleExtractor } from "./google.js";

export const OpenAIModels = ["gpt-4o", "gpt-4o-mini"];
export const LocalModels = ["llama3.2-vision"];
export const GoogleModels = [
  "gemini-2.0-flash-001", 
  "gemini-2.0-flash-lite-preview-02-05", 
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
 "gemini-1.5-pro"
];

export function getExtractor(model) {
  if (OpenAIModels.includes(model)) {
    return openAIExtractor;
  }

  if (GoogleModels.includes(model)) {
    return googleExtractor;
  }

  if (LocalModels.includes(model)) {
    return ollamaExtractor;
  }

  throw new Error(`Unrecognised model '${model}'.`);
}
