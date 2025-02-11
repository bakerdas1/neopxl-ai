import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

export const googleExtractor = async ({ markdown, zodSchema }) => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }
  
  const openai = new OpenAI({ 
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.GEMINI_API_KEY
   });

  const googleModel = "gemini-2.0-flash-001";

  const prompt = `
    You are an expert in structured data extraction. Your task is to extract information from unstructured content and transform it into the specified structure. Follow these rules strictly:

   1. Handle Missing or Undetermined Data:
   - If any field's information is missing, unknown, or cannot be determined, return its value as null.
   - **Do not use substitutes such as "unknown," "missing," or any other placeholder for missing or unknown data. The value **must** always be explicitly null.
`;

  const completion = await openai.beta.chat.completions.parse({
    model: googleModel,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: markdown },
    ],
    response_format: zodResponseFormat(zodSchema, "event"),
  });

//   console.log("Completion Tokens", completion.usage.completion_tokens)
//   console.log("Prompt Tokens", completion.usage.prompt_tokens)
//   console.log("Total Tokens", completion.usage.total_tokens)

  const event = completion.choices[0].message.parsed;
  return event;
}
