export enum OpenAIModels {
  GPT_4O = "gpt-4o",
  GPT_4O_MINI = "gpt-4o-mini",
  // Add more as you like
}

export enum LocalModels {
  LLAVA = "llava",
  LLAMA3_2_VISION = "llama3.2-vision",
  // Add more as you like
}

export type ModelOptions = OpenAIModels | LocalModels;

export interface DocumindArgs {
  cleanup?: boolean;
  concurrency?: number;
  filePath: string;
  llmParams?: LLMParams;
  maintainFormat?: boolean;
  model?: ModelOptions;
  outputDir?: string;
  pagesToConvertAsImages?: number | number[];
  tempDir?: string;
}

export interface Page {
  content: string;
  contentLength: number;
  page: number;
}

export interface DocumindOutput {
  completionTime: number;
  fileName: string;
  inputTokens: number;
  outputTokens: number;
  pages: Page[];
}

export interface CompletionResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionArgs {
  imagePath: string;
  llmParams?: LLMParams;
  maintainFormat: boolean;
  model: ModelOptions;
  priorPage: string;
}

export interface LLMParams {
  frequencyPenalty?: number;
  maxTokens?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
}
