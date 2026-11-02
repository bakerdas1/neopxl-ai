import { ollamaExtractor } from "./ollama.js";
import { openAIExtractor } from "./openAI.js";
import { googleExtractor } from "./google.js";

export const OpenAIModels = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];
export const LocalModels = ["llama3.2-vision"];
export const GoogleModels = [
  "gemini-4-argon",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro"
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
