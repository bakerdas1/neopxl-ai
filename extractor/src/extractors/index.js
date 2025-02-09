import { ollamaExtractor } from "./ollama.js";
import { openAIExtractor } from "./openAI.js";

export const OpenAIModels = ["gpt-4o", "gpt-4o-mini"];
export const LocalModels = ["llava", "llama3.2-vision"];

export function getExtractor(model) {
  if (OpenAIModels.includes(model)) {
    return openAIExtractor;
  }

  if (LocalModels.includes(model)) {
    return ollamaExtractor;
  }

  throw new Error(`Unrecognised model '${model}'.`);
}
