import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { convertToZodSchema } from './utils/convertToZodSchema.js'; 
import { convertFile } from './converter.js'; 

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const extractData = async (pdfFilePath, schemaDefinition) => {
  
  const prompt = `
    You are an expert in structured data extraction. Your task is to extract information from unstructured content and transform it into the specified structure. Follow these rules strictly:

1. Handle Missing or Undetermined Data:
   - If any field's information is missing, unknown, or cannot be determined, return its value as null.
   - **Do not use substitutes such as "unknown," "missing," or any other placeholder for missing or unknown data. The value **must** always be explicitly null.
`;

  try {
    const { markdown, totalPages, fileName } = await convertFile(pdfFilePath); 
    
    //console.log(markdown);

    const dynamicZodSchema = convertToZodSchema(schemaDefinition);

    const completion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      messages: [
        { role: "system", content: prompt },
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
