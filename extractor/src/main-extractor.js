import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { createClient } from '@supabase/supabase-js';
import { convertToZodSchema } from './utils/convertToZodSchema.js'; 
import { convertFile } from './converter.js'; 

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseBucket = process.env.SUPABASE_BUCKET;
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const getFile = async (filePath) => {
  try {
    const { data, error } = await supabase.storage.from(supabaseBucket).download(filePath);
    if (error) {
      throw error;
    }
    const content = await data.text();
    return content;
  } catch (error) {
    console.error("Error fetching the markdown file:", error);
    throw error;
  }
};

export const extractData = async (pdfFilePath, schemaDefinition) => {
  try {
    const { uploadedFilePath, totalPages, fileName } = await convertFile(pdfFilePath); 

    const markdownContent = await getFile(uploadedFilePath);

    const dynamicZodSchema = convertToZodSchema(schemaDefinition);

    const completion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      messages: [
        { role: "system", content: "Extract the event information." },
        {
          role: "user",
          content: markdownContent, 
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
