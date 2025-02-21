import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

export const ollamaExtractor = async ({ markdown, zodSchema, prompt, model }) => {
  if (!process.env.BASE_URL) {
    throw new Error("Missing BASE_URL");
  }
  
  const openai = new OpenAI({ 
    baseURL: process.env.BASE_URL,
    apiKey: 'ollama'
   });

  const ollamaModel = model;

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
