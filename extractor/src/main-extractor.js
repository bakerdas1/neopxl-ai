import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { convertToZodSchema } from './utils/convertToZodSchema.js'; 
import { convertFile } from './converter.js'; 

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const extractData = async (pdfFilePath, schemaDefinition) => {
  try {
    const { markdown, totalPages, fileName } = await convertFile(pdfFilePath); 

    const dynamicZodSchema = convertToZodSchema(schemaDefinition);

    const completion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      messages: [
        { role: "system", content: "Extract the event information." },
        {
          role: "user",
          content: markdown, 
        },
      ],
      response_format: zodResponseFormat(dynamicZodSchema, "event"),
    });

    const event = completion.choices[0].message.parsed;
 
    return {
        event,
        totalPages,
        fileName,
      };
  } catch (error) {
    console.error("Error running OpenAI API call:", error);
    throw error;
  }
};
