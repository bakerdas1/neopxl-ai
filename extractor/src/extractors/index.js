import { ollamaExtractor } from "./ollama.js";
import { openAIExtractor } from "./openAI.js";
import { googleExtractor } from "./google.js";

export const OpenAIModels = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];
export const LocalModels = ["qwen3-coder:latest", "gemma4:e4b", "mistral:7b", "llama3.2:latest", "llama3.2-vision"];
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

  // Ollama tags use "name:tag"; treat any unknown tagged model as local.
  if (LocalModels.includes(model) || (typeof model === "string" && model.includes(":"))) {
    return ollamaExtractor;
  }

  throw new Error(`Unrecognised model '${model}'.`);
}
