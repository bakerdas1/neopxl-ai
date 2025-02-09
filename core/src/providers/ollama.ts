import axios from "axios";
import { Completion } from "./utils/completion";
import { CompletionArgs, CompletionResponse, LocalModels } from "../types";
import { convertKeysToSnakeCase, encodeImageToBase64 } from "../utils";

export class Ollama implements Completion {
  public async getCompletion(args: CompletionArgs): Promise<CompletionResponse> {
    const {
      imagePath,
      llmParams,
      maintainFormat,
      model,
      priorPage,
    } = args;

    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
      throw new Error("Missing BASE_URL in environment variables.");
    }

    const validModels = Object.values(LocalModels); 
    if (!validModels.includes(model as LocalModels)) {
      throw new Error(`Model "${model}" is not a local model.`);
    }

    const systemPrompt = `
    Convert the following image/document  to markdown. 
    Return only the markdown with no explanation text. Do not include deliminators like '''markdown.
    You must include all information on the page. Do not exclude headers, footers, or subtext.
  `;

    const messages: any = [{ role: "system", content: systemPrompt }];

    if (maintainFormat && priorPage) {
      messages.push({
        role: "system",
        content: `Please ensure markdown formatting remains consistent with the prior page:\n\n"""${priorPage}"""`,
      });
    }

    const base64Image = await encodeImageToBase64(imagePath);
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${base64Image}` },
        },
      ],
    });

    try {
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          messages,
          model,
          ...convertKeysToSnakeCase(llmParams ?? null),
        },
        {
          headers: {
            // Authorization: "ollama",
            "Content-Type": "application/json",
          },
        }
      );

      const data = response.data;
      return {
        content: data.choices[0].message.content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      console.error("Local provider error:", err);
      throw err;
    }
  }
}
