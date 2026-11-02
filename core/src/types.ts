export enum OpenAIModels {
  GPT_4O = "gpt-4o",
  GPT_4O_MINI = "gpt-4o-mini",
  GPT_4_1 = "gpt-4.1",
  GPT_4_1_MINI = "gpt-4.1-mini",
}

export enum LocalModels {
  //LLAVA = "llava",
  LLAMA3_2_VISION = "llama3.2-vision",
}

export enum GoogleModels {
  GEMINI_4_ARGON = "gemini-4-argon",
  GEMINI_3_8_FLASH = "gemini-3.8-flash",
  GEMINI_3_6_FLASH = "gemini-3.6-flash",
  GEMINI_3_5_FLASH_LITE = "gemini-3.5-flash-lite",
  GEMINI_3_1_FLASH_LITE = "gemini-3.1-flash-lite",
  GEMINI_3_1_PRO = "gemini-3.1-pro-preview",
  GEMINI_3_FLASH = "gemini-3-flash-preview",
  GEMINI_FLASH_LATEST = "gemini-flash-latest",
  GEMINI_2_5_FLASH = "gemini-2.5-flash",
  GEMINI_2_5_FLASH_LITE = "gemini-2.5-flash-lite",
  GEMINI_2_5_PRO = "gemini-2.5-pro",
}

export type ModelOptions = OpenAIModels | GoogleModels | LocalModels;

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
