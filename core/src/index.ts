import {
  convertFileToPdf,
  convertPdfToImages,
  downloadFile,
  formatMarkdown,
  isString,
  validateLLMParams
} from "./utils";
import fs from "fs-extra";
import os from "os";
import path from "path";
import pLimit from "p-limit";
import {
  DocumindArgs,
  DocumindOutput,
  ModelOptions,
  OpenAIModels,
} from "./types";
import { getModel } from "./providers";
import { Completion } from "./providers/utils/completion";

export const documind = async ({
  cleanup = true,
  concurrency = 10,
  filePath,
  llmParams = {},
  maintainFormat = false,
  model, //= ModelOptions.gpt_4o_mini,
  outputDir,
  pagesToConvertAsImages = -1,
  tempDir = os.tmpdir(),
}: DocumindArgs): Promise<DocumindOutput> => {

  let inputTokenCount = 0;
  let outputTokenCount = 0;
  let priorPage = "";
  const aggregatedMarkdown: string[] = [];
  const startTime = new Date();

  // Basic checks
  if (!filePath || !filePath.length) {
    throw new Error("Missing file path");
  }

  const defaultModel: ModelOptions = model ?? OpenAIModels.GPT_4O_MINI;

  const validatedParams = validateLLMParams(llmParams);

  const providerInstance: Completion = getModel.getProviderForModel(defaultModel);

  // Ensure temp directory exists + create temp folder
  const rand = Math.floor(1000 + Math.random() * 9000).toString();
  const tempDirectory = path.join(tempDir || os.tmpdir(), `documind-file-${rand}`);
  await fs.ensureDir(tempDirectory);

  // Download the PDF. Get file name.
  const { extension, localPath } = await downloadFile({
    filePath,
    tempDir: tempDirectory,
  });
  if (!localPath) throw "Failed to save file to local drive";

  // Sort the `pagesToConvertAsImages` array to make sure we use the right index
  // for `formattedPages` as `pdf2pic` always returns images in order
  if (Array.isArray(pagesToConvertAsImages)) {
    pagesToConvertAsImages.sort((a, b) => a - b);
  }

  // Convert file to PDF if necessary
  if (extension !== ".png") {
    let pdfPath: string;
    if (extension === ".pdf") {
      pdfPath = localPath;
    } else {
      pdfPath = await convertFileToPdf({
        extension,
        localPath,
        tempDir: tempDirectory,
      });
    }
    // Convert the file to a series of images
    await convertPdfToImages({
      localPath: pdfPath,
      pagesToConvertAsImages,
      tempDir: tempDirectory,
    });
  }

  const endOfPath = localPath.split("/")[localPath.split("/").length - 1];
  const rawFileName = endOfPath.split(".")[0];
  const fileName = rawFileName
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 255); // Truncate file name to 255 characters to prevent ENAMETOOLONG errors

  // Get list of converted images (a wide page may be split into band files).
  const files = await fs.readdir(tempDirectory);
  const pngFiles = files
    .filter((file) => file.endsWith(".png"))
    .sort();

  // Group band files by page: "..._page_00001.png" and "..._page_00001_0.png"
  // belong to the same page.
  const pageGroups: string[][] = [];
  const byPage = new Map<string, string[]>();
  for (const file of pngFiles) {
    const m = file.match(/^(.*_page_\d{5})(?:_\d+)?\.png$/);
    const key = m ? m[1] : file;
    let group = byPage.get(key);
    if (!group) {
      group = [];
      byPage.set(key, group);
      pageGroups.push(group);
    }
    group.push(file);
  }

  if (maintainFormat) {
    // Use sequential processing, keeping formatting consistent across pages.
    for (const group of pageGroups) {
      const parts: string[] = [];
      for (const image of group) {
        const imagePath = path.join(tempDirectory, image);
        try {
          const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
            imagePath,
            llmParams: validatedParams,
            maintainFormat,
            model: defaultModel,
            priorPage,
          });
          const formattedMarkdown = formatMarkdown(content);
          inputTokenCount += inputTokens;
          outputTokenCount += outputTokens;

          // Update prior page to result from last processing step
          priorPage = formattedMarkdown;
          parts.push(formattedMarkdown);
        } catch (error) {
          console.error(`Failed to process image ${image}:`, error);
          throw error;
        }
      }
      aggregatedMarkdown.push(parts.join("\n\n"));
    }
  } else {
    // Process in parallel with a limit on concurrent images, then merge bands
    // belonging to the same page.
    const processPage = async (image: string): Promise<string | null> => {
      const imagePath = path.join(tempDirectory, image);
      try {
        const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
          imagePath,
          llmParams: validatedParams,
          maintainFormat,
          model: defaultModel,
          priorPage,
        });
        const formattedMarkdown = formatMarkdown(content);
        inputTokenCount += inputTokens;
        outputTokenCount += outputTokens;

        // Update prior page to result from last processing step
        priorPage = formattedMarkdown;

        return formattedMarkdown;
      } catch (error) {
        console.error(`Failed to process image ${image}:`, error);
        throw error;
      }
    };

    const limit = pLimit(concurrency);
    const allImages = pageGroups.flat();
    const results = await Promise.all(
      allImages.map((image) => limit(() => processPage(image)))
    );
    const byFile = new Map<string, string | null>();
    allImages.forEach((image, i) => byFile.set(image, results[i]));

    for (const group of pageGroups) {
      const parts = group
        .map((f) => byFile.get(f))
        .filter((v): v is string => typeof v === "string");
      aggregatedMarkdown.push(parts.join("\n\n"));
    }
  }

  // Write the aggregated markdown to a file
  if (outputDir) {
    const resultFilePath = path.join(outputDir, `${fileName}.md`);
    await fs.writeFile(resultFilePath, aggregatedMarkdown.join("\n\n"));
  }

  // Cleanup the downloaded PDF file
  if (cleanup) await fs.remove(tempDirectory);

  // Format JSON response
  const endTime = new Date();
  const completionTime = endTime.getTime() - startTime.getTime();
  const formattedPages = aggregatedMarkdown.map((el, i) => {
    let pageNumber;
    // If we convert all pages, just use the array index
    if (pagesToConvertAsImages === -1) {
      pageNumber = i + 1;
    }
    // Else if we convert specific pages, use the page number from the parameter
    else if (Array.isArray(pagesToConvertAsImages)) {
      pageNumber = pagesToConvertAsImages[i];
    }
    // Else, the parameter is a number and use it for the page number
    else {
      pageNumber = pagesToConvertAsImages;
    }

    return { content: el, page: pageNumber, contentLength: el.length };
  });

  return {
    completionTime,
    fileName,
    inputTokens: inputTokenCount,
    outputTokens: outputTokenCount,
    pages: formattedPages,
  };
};
