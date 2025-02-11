export declare enum OpenAIModels {
    GPT_4O = "gpt-4o",
    GPT_4O_MINI = "gpt-4o-mini"
}
export declare enum GoogleModels {
    GEMINI_2_FLASH = "gemini-2.0-flash-001",
    GEMINI_2_FLASH_LITE = "gemini-2.0-flash-lite-preview-02-05"
}
export declare enum LocalModels {
    LLAVA = "llava",
    LLAMA3_2_VISION = "llama3.2-vision"
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
