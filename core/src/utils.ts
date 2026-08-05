import { convert } from "libreoffice-convert";
import { execFile, exec } from "child_process";
import { LLMParams } from "./types";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import * as Tesseract from "tesseract.js";
import axios from "axios";
import fs from "fs-extra";
import mime from "mime-types";
import path from "path";
import sharp from "sharp";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const convertAsync = promisify(convert);

const defaultLLMParams: LLMParams = {
  frequencyPenalty: 0, // OpenAI defaults to 0
  maxTokens: 16384,
  presencePenalty: 0, // OpenAI defaults to 0
  temperature: 0,
  topP: 1, // OpenAI defaults to 1
};

export const validateLLMParams = (params: Partial<LLMParams>): LLMParams => {
  const validKeys = Object.keys(defaultLLMParams);

  for (const [key, value] of Object.entries(params)) {
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid LLM parameter: ${key}`);
    }
    if (typeof value !== "number") {
      throw new Error(`Value for '${key}' must be a number`);
    }
  }

  return { ...defaultLLMParams, ...params };
};

export const encodeImageToBase64 = async (imagePath: string) => {
  const imageBuffer = await fs.readFile(imagePath);
  return imageBuffer.toString("base64");
};

// Strip out the ```markdown wrapper
export const formatMarkdown = (text: string) => {
  if (!text) return '';
  let formattedMarkdown = text?.trim();
  let loopCount = 0;
  const maxLoops = 3;

  const startsWithMarkdown = formattedMarkdown.startsWith("```markdown");
  while (startsWithMarkdown && loopCount < maxLoops) {
    const endsWithClosing = formattedMarkdown.endsWith("```");

    if (startsWithMarkdown && endsWithClosing) {
      const outermostBlockRegex = /^```markdown\n([\s\S]*?)\n```$/;
      const match = outermostBlockRegex.exec(formattedMarkdown);

      if (match) {
        formattedMarkdown = match[1].trim();
        loopCount++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return formattedMarkdown;
};

export const isString = (value: string | null): value is string => {
  return value !== null;
};

export const isValidUrl = (string: string): boolean => {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
};

// Save file to local tmp directory
export const downloadFile = async ({
  filePath,
  tempDir,
}: {
  filePath: string;
  tempDir: string;
}): Promise<{ extension: string; localPath: string }> => {
  // Shorten the file name by removing URL parameters
  const baseFileName = path.basename(filePath.split("?")[0]);
  const localPath = path.join(tempDir, baseFileName);
  let mimetype;

  // Check if filePath is a URL
  if (isValidUrl(filePath)) {
    const writer = fs.createWriteStream(localPath);

    const response = await axios({
      url: filePath,
      method: "GET",
      responseType: "stream",
    });

    if (response.status !== 200) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    mimetype = response.headers?.["content-type"];
    await pipeline(response.data, writer);
  } else {
    // If filePath is a local file, copy it to the temp directory
    await fs.copyFile(filePath, localPath);
  }

  if (!mimetype) {
    mimetype = mime.lookup(localPath);
  }

  let extension = mime.extension(mimetype) || "";
  if (!extension) {
    if (mimetype === "binary/octet-stream") {
      extension = ".bin";
    } else {
      throw new Error("File extension missing");
    }
  }

  if (!extension.startsWith(".")) {
    extension = `.${extension}`;
  }

  return { extension, localPath };
};

// Extract text confidence from image buffer using Tesseract
export const getTextFromImage = async (
  buffer: Buffer
): Promise<{ confidence: number }> => {
  try {
    // Get image and metadata
    const image = sharp(buffer);
    const metadata = await image.metadata();

    // Crop to a 100px wide column in the center of the document for faster OCR.
    const cropWidth = 100;
    const cropHeight = metadata.height || 0;
    const left = Math.max(0, Math.floor((metadata.width! - cropWidth) / 2));
    const top = 0;

    // Extract the cropped image
    const croppedBuffer = await image
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer();

    // Pass the croppedBuffer to Tesseract.recognize
    // @TODO: How can we generalize this to non eng languages?
    const {
      data: { confidence },
    } = await Tesseract.recognize(croppedBuffer, "eng");

    return { confidence };
  } catch (error) {
    console.error("Error during OCR:", error);
    return { confidence: 0 };
  }
};

// Correct image orientation based on OCR confidence
// Run Tesseract on 2 orientations — PDFs only rotate in 90° increments
const correctImageOrientation = async (buffer: Buffer): Promise<Buffer> => {
  const image = sharp(buffer);
  const rotations = [0, 90];

  const results = await Promise.all(
    rotations.map(async (rotation) => {
      const rotatedImageBuffer = await image
        .clone()
        .rotate(rotation)
        .toBuffer();
      const { confidence } = await getTextFromImage(rotatedImageBuffer);
      return { rotation, confidence };
    })
  );

  // Find the rotation with the best confidence score
  const bestResult = results.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  );

  if (bestResult.rotation !== 0) {
    console.log(
      `Reorienting image ${bestResult.rotation} degrees (Confidence: ${bestResult.confidence}%).`
    );
  }

  // Rotate the image to the best orientation
  const correctedImageBuffer = await image
    .rotate(bestResult.rotation)
    .toBuffer();

  return correctedImageBuffer;
};

const getPdfPageCount = async (localPath: string): Promise<number> => {
  const { stdout } = await execAsync(
    `gs -dNOPAUSE -dBATCH -q -dQUIET -dNODISPLAY -c "(${localPath}) (r) file runpdfbegin pdfpagecount = quit"`
  );
  return parseInt(stdout.trim(), 10);
};

const gsConvertPage = async (
  localPath: string,
  page: number,
  outputPath: string,
  density: number
): Promise<void> => {
  await execFileAsync("gs", [
    "-dNOPAUSE",
    "-dBATCH",
    "-dQUIET",
    "-dSAFER",
    "-dAutoRotatePages=/PageByPage",
    "-sDEVICE=png16m",
    `-r${density}`,
    "-dTextAlphaBits=4",
    "-dGraphicsAlphaBits=4",
    `-dFirstPage=${page}`,
    `-dLastPage=${page}`,
    `-sOutputFile=${outputPath}`,
    localPath,
  ]);
};

// Convert each page to a png, correct orientation, and save that image to tmp
export const convertPdfToImages = async ({
  localPath,
  pagesToConvertAsImages,
  tempDir,
}: {
  localPath: string;
  pagesToConvertAsImages: number | number[];
  tempDir: string;
}) => {
  const saveFilename = path.basename(localPath, path.extname(localPath));
  const density = 300;

  try {
    const totalPages = await getPdfPageCount(localPath);
    const pagesToProcess = pagesToConvertAsImages === -1
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : Array.isArray(pagesToConvertAsImages)
        ? pagesToConvertAsImages
        : [pagesToConvertAsImages];

    const results = await Promise.all(
      pagesToProcess.map(async (page) => {
        const paddedPageNumber = page.toString().padStart(5, "0");
        const imagePath = path.join(
          tempDir,
          `${saveFilename}_page_${paddedPageNumber}.png`
        );
        await gsConvertPage(localPath, page, imagePath, density);

        const img = sharp(imagePath);
        const meta = await img.metadata();
        if (meta.height && meta.height > 2048) {
          await img.resize({ height: 2048, withoutEnlargement: true }).toFile(imagePath + '.tmp');
          await fs.rename(imagePath + '.tmp', imagePath);
        }

        const buffer = await fs.readFile(imagePath);
        let correctedBuffer = buffer;
        if (process.env.CORRECT_ORIENTATION !== '0') {
          correctedBuffer = await correctImageOrientation(buffer);
        }
        if (correctedBuffer !== buffer) {
          await fs.writeFile(imagePath, correctedBuffer);
        }

        return { page, buffer: correctedBuffer };
      })
    );

    return results;
  } catch (err) {
    console.error("Error during PDF conversion:", err);
    throw err;
  }
};

// Convert each page (from other formats like docx) to a png and save that image to tmp
export const convertFileToPdf = async ({
  extension,
  localPath,
  tempDir,
}: {
  extension: string;
  localPath: string;
  tempDir: string;
}): Promise<string> => {
  const inputBuffer = await fs.readFile(localPath);
  const outputFilename = path.basename(localPath, extension) + ".pdf";
  const outputPath = path.join(tempDir, outputFilename);

  try {
    const pdfBuffer = await convertAsync(inputBuffer, ".pdf", undefined);
    await fs.writeFile(outputPath, pdfBuffer);
    return outputPath;
  } catch (err) {
    console.error(`Error converting ${extension} to .pdf:`, err);
    throw err;
  }
};

const camelToSnakeCase = (str: string) =>
  str.replace(/[A-Z]/g, (letter: string) => `_${letter.toLowerCase()}`);

export const convertKeysToSnakeCase = (
  obj: Record<string, any> | null
): Record<string, any> => {
  if (typeof obj !== "object" || obj === null) {
    return obj ?? {};
  }

  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [camelToSnakeCase(key), value])
  );
};
