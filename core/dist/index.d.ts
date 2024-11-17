import { DocumindArgs, DocumindOutput } from "./types";
export declare const documind: ({ cleanup, concurrency, filePath, llmParams, maintainFormat, model, openaiAPIKey, outputDir, pagesToConvertAsImages, tempDir, }: DocumindArgs) => Promise<DocumindOutput>;
