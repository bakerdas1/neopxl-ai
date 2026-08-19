"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.documind = void 0;
const utils_1 = require("./utils");
const fs_extra_1 = __importDefault(require("fs-extra"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const p_limit_1 = __importDefault(require("p-limit"));
const types_1 = require("./types");
const providers_1 = require("./providers");
const documind = async ({ cleanup = true, concurrency = 10, filePath, llmParams = {}, maintainFormat = false, model, //= ModelOptions.gpt_4o_mini,
outputDir, pagesToConvertAsImages = -1, tempDir = os_1.default.tmpdir(), }) => {
    let inputTokenCount = 0;
    let outputTokenCount = 0;
    let priorPage = "";
    const aggregatedMarkdown = [];
    const startTime = new Date();
    // Basic checks
    if (!filePath || !filePath.length) {
        throw new Error("Missing file path");
    }
    const defaultModel = model ?? types_1.OpenAIModels.GPT_4O_MINI;
    const validatedParams = (0, utils_1.validateLLMParams)(llmParams);
    const providerInstance = providers_1.getModel.getProviderForModel(defaultModel);
    // Ensure temp directory exists + create temp folder
    const rand = Math.floor(1000 + Math.random() * 9000).toString();
    const tempDirectory = path_1.default.join(tempDir || os_1.default.tmpdir(), `documind-file-${rand}`);
    await fs_extra_1.default.ensureDir(tempDirectory);
    // Download the PDF. Get file name.
    const { extension, localPath } = await (0, utils_1.downloadFile)({
        filePath,
        tempDir: tempDirectory,
    });
    if (!localPath)
        throw "Failed to save file to local drive";
    // Sort the `pagesToConvertAsImages` array to make sure we use the right index
    // for `formattedPages` as `pdf2pic` always returns images in order
    if (Array.isArray(pagesToConvertAsImages)) {
        pagesToConvertAsImages.sort((a, b) => a - b);
    }
    // Convert file to PDF if necessary
    if (extension !== ".png") {
        let pdfPath;
        if (extension === ".pdf") {
            pdfPath = localPath;
        }
        else {
            pdfPath = await (0, utils_1.convertFileToPdf)({
                extension,
                localPath,
                tempDir: tempDirectory,
            });
        }
        // Convert the file to a series of images
        await (0, utils_1.convertPdfToImages)({
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
    const files = await fs_extra_1.default.readdir(tempDirectory);
    const pngFiles = files
        .filter((file) => file.endsWith(".png"))
        .sort();
    // Group band files by page: "..._page_00001.png" and "..._page_00001_0.png"
    // belong to the same page.
    const pageGroups = [];
    const byPage = new Map();
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
            const parts = [];
            for (const image of group) {
                const imagePath = path_1.default.join(tempDirectory, image);
                try {
                    const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
                        imagePath,
                        llmParams: validatedParams,
                        maintainFormat,
                        model: defaultModel,
                        priorPage,
                    });
                    const formattedMarkdown = (0, utils_1.formatMarkdown)(content);
                    inputTokenCount += inputTokens;
                    outputTokenCount += outputTokens;
                    // Update prior page to result from last processing step
                    priorPage = formattedMarkdown;
                    parts.push(formattedMarkdown);
                }
                catch (error) {
                    console.error(`Failed to process image ${image}:`, error);
                    throw error;
                }
            }
            aggregatedMarkdown.push(parts.join("\n\n"));
        }
    }
    else {
        // Process in parallel with a limit on concurrent images, then merge bands
        // belonging to the same page.
        const processPage = async (image) => {
            const imagePath = path_1.default.join(tempDirectory, image);
            try {
                const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
                    imagePath,
                    llmParams: validatedParams,
                    maintainFormat,
                    model: defaultModel,
                    priorPage,
                });
                const formattedMarkdown = (0, utils_1.formatMarkdown)(content);
                inputTokenCount += inputTokens;
                outputTokenCount += outputTokens;
                // Update prior page to result from last processing step
                priorPage = formattedMarkdown;
                return formattedMarkdown;
            }
            catch (error) {
                console.error(`Failed to process image ${image}:`, error);
                throw error;
            }
        };
        const limit = (0, p_limit_1.default)(concurrency);
        const allImages = pageGroups.flat();
        const results = await Promise.all(allImages.map((image) => limit(() => processPage(image))));
        const byFile = new Map();
        allImages.forEach((image, i) => byFile.set(image, results[i]));
        for (const group of pageGroups) {
            const parts = group
                .map((f) => byFile.get(f))
                .filter((v) => typeof v === "string");
            aggregatedMarkdown.push(parts.join("\n\n"));
        }
    }
    // Write the aggregated markdown to a file
    if (outputDir) {
        const resultFilePath = path_1.default.join(outputDir, `${fileName}.md`);
        await fs_extra_1.default.writeFile(resultFilePath, aggregatedMarkdown.join("\n\n"));
    }
    // Cleanup the downloaded PDF file
    if (cleanup)
        await fs_extra_1.default.remove(tempDirectory);
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
exports.documind = documind;
