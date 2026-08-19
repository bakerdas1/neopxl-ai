"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Google = void 0;
const axios_1 = __importDefault(require("axios"));
const types_1 = require("../types");
const utils_1 = require("../utils");
class Google {
    async getCompletion(args) {
        const { imagePath, llmParams, maintainFormat, model, priorPage, } = args;
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("Missing GEMINI_API_KEY in environment variables.");
        }
        const apiKey = process.env.GEMINI_API_KEY;
        const validModels = Object.values(types_1.GoogleModels);
        if (!validModels.includes(model)) {
            throw new Error(`Model "${model}" is not a google model.`);
        }
        const systemPrompt = `
    Convert the following image/document  to markdown. 
    Return only the markdown with no explanation text. Do not include deliminators like '''markdown.
    You must include all information on the page. Do not exclude headers, footers, or subtext.
  `;
        const messages = [{ role: "system", content: systemPrompt }];
        if (maintainFormat && priorPage) {
            messages.push({
                role: "system",
                content: `Please ensure markdown formatting remains consistent with the prior page:\n\n"""${priorPage}"""`,
            });
        }
        const base64Image = await (0, utils_1.encodeImageToBase64)(imagePath);
        messages.push({
            role: "user",
            content: [
                {
                    "type": "text", //Using Gemini via openai requires text parameter
                    "text": ""
                },
                {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${base64Image}` },
                },
            ],
        });
        try {
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const isRetryable = (err) => {
                const status = err?.response?.status || err?.status || err?.statusCode;
                const msg = String(err?.message || "");
                return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
                    || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Too Many Requests")
                    || msg.includes("internal server error") || msg.includes("unavailable");
            };
            let response = null;
            let lastErr = null;
            const maxAttempts = 5;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    response = await axios_1.default.post("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
                        messages,
                        model,
                        max_tokens: llmParams?.maxTokens || 16384,
                        temperature: 0,
                    }, {
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            "Content-Type": "application/json",
                        },
                    });
                    break;
                }
                catch (err) {
                    lastErr = err;
                    if (!isRetryable(err) || attempt === maxAttempts)
                        throw err;
                    const jitter = 0.7 + Math.random() * 0.6;
                    const delay = Math.min(2000 * Math.pow(2, attempt - 1) * jitter, 30000);
                    console.warn(`[google] retryable conversion error (${lastErr?.response?.status || lastErr?.status || lastErr?.message}), attempt ${attempt}/${maxAttempts} — retrying in ${Math.round(delay)}ms`);
                    await sleep(delay);
                }
            }
            if (!response)
                throw lastErr;
            const data = response.data;
            return {
                content: data.choices[0].message.content,
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            };
        }
        catch (err) {
            console.error("Google provider error:", err);
            throw err;
        }
    }
}
exports.Google = Google;
