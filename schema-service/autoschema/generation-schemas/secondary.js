// Used for google models
import { z } from "zod";

const BaseSchemaField = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "array", "object"]),
  description: z.string().optional(),
});

const SchemaField = BaseSchemaField.extend({
  children: z.array(BaseSchemaField).optional(),
});

export const secondarySchema = z.object({
  fields: z.array(SchemaField),
});