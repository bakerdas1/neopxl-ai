import { DocumindArgs, DocumindOutput } from "./types";
export declare const documind: ({ cleanup, concurrency, filePath, llmParams, maintainFormat, model, outputDir, pagesToConvertAsImages, tempDir, }: DocumindArgs) => Promise<DocumindOutput>;
