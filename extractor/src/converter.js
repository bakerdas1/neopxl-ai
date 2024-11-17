import { documind } from 'core';
import { generateMarkdownDocument } from './utils/generateMarkdown.js'; 

export const convertFile = async (filePath) => {
  try {
    const result = await documind({
      filePath,
      openaiAPIKey: process.env.OPENAI_API_KEY, 
    });

    const { pages, fileName } = result;
    const totalPages = pages.length;

    const uploadedFilePath = await generateMarkdownDocument(pages, fileName);

    return { uploadedFilePath, totalPages, fileName };
  } catch (error) {
    console.error('Error running documind core:', error);
  }
};
