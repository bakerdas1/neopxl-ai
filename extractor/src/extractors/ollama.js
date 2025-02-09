import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

export const ollamaExtractor = async ({ markdown, zodSchema }) => {
  if (!process.env.BASE_URL) {
    throw new Error("Missing BASE_URL");
  }
  
  const openai = new OpenAI({ 
    baseURL: process.env.BASE_URL,
    apiKey: 'ollama'
   });

  const ollamaModel = "llama3.1";

  const prompt = `
    You are an expert in structured data extraction. Your task is to extract information from unstructured content and transform it into the specified structure. Follow these rules strictly:

   1. Handle Missing or Undetermined Data:
   - If any field's information is missing, unknown, or cannot be determined, return its value as null.
   - **Do not use substitutes such as "unknown," "missing," or any other placeholder for missing or unknown data. The value **must** always be explicitly null.
`;

  const completion = await openai.beta.chat.completions.parse({
    model: ollamaModel,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: markdown },
    ],
    response_format: zodResponseFormat(zodSchema, "event"),
  });

  const event = completion.choices[0].message.parsed;
  return event;
}
