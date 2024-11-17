import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseBucket = process.env.SUPABASE_BUCKET;
const supabase = createClient(supabaseUrl, supabaseKey);

export const generateMarkdownDocument = async (pages, fileName) => {
  try {
    let markdownContent = '';
    pages.forEach((page) => {
      markdownContent += page.content + '\n\n---\n\n'; 
    });

    const fileBuffer = Buffer.from(markdownContent, 'utf-8');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const filePath = `${fileName}-${randomSuffix}.md`;

    const { data, error } = await supabase.storage
      .from(supabaseBucket)
      .upload(filePath, fileBuffer);

    if (error) {
      throw error;
    }

    //console.log('File uploaded successfully to Supabase:', data);
    return filePath; 
  } catch (error) {
    console.error('Error generating and uploading markdown:', error);
    throw error;
  }
};
