"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAI = void 0;
const axios_1 = __importDefault(require("axios"));
const types_1 = require("../types");
const utils_1 = require("../utils");
class OpenAI {
    async getCompletion(args) {
        const { imagePath, llmParams, maintainFormat, model, priorPage, } = args;
        // 1) Confirm we have an API Key in environment
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("Missing OPENAI_API_KEY in environment variables.");
        }
        const apiKey = process.env.OPENAI_API_KEY;
        // 2) Confirm the model is one of the OpenAI ones
        const validModels = Object.values(types_1.OpenAIModels); // ["gpt-4o", "gpt-4o-mini", ...]
        if (!validModels.includes(model)) {
            throw new Error(`Model "${model}" is not an OpenAI model.`);
        }
        const systemPrompt = `
    Convert the following image/document  to markdown. 
    Return only the markdown with no explanation text. Do not include deliminators like '''markdown.
    You must include all information on the page. Do not exclude headers, footers, or subtext.
  `;
        // 5) Build the messages array
        const messages = [{ role: "system", content: systemPrompt }];
        // If user wants consistent formatting across pages, pass that context as well
        if (maintainFormat && priorPage) {
            messages.push({
                role: "system",
                content: `Please ensure markdown formatting remains consistent with the prior page:\n\n"""${priorPage}"""`,
            });
        }
        // 6) Convert the image to base64 so we can supply it
        const base64Image = await (0, utils_1.encodeImageToBase64)(imagePath);
        messages.push({
            role: "user",
            content: [
                {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${base64Image}` },
                },
            ],
        });
        // 7) Send the request to OpenAI
        try {
            const response = await axios_1.default.post("https://api.openai.com/v1/chat/completions", {
                messages,
                model,
                ...(0, utils_1.convertKeysToSnakeCase)(llmParams ?? null),
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
            });
            const data = response.data;
            return {
                content: data.choices[0].message.content,
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            };
        }
        catch (err) {
            console.error("OpenAIProvider error:", err);
            throw err;
        }
    }
}
exports.OpenAI = OpenAI;
