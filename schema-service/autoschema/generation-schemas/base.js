// Used for non-google models that don't have schema limitations
import { z } from "zod";

const SchemaField = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.enum(["string", "number", "array", "object"]),
    description: z.string().optional(),
    children: z.array(SchemaField).optional(),
  })
);

export const baseSchema = z.object({
  fields: z.array(SchemaField),
});