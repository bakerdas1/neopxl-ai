import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';

export const googleExtractor = async ({ markdown, zodSchema, prompt }) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

const google = createGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
});
const googleModel = "gemini-2.0-flash-001"

const completion = await generateObject({
    model: google(googleModel, {
      structuredOutputs: false,
    }),
    schema: zodSchema,
    prompt: markdown,
    system: prompt,
  });

  const event = completion.object;
  return event;
}