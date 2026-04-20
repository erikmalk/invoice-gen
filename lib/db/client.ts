import { z } from "zod";
import { drizzle } from "drizzle-orm/neon-serverless";

import * as schema from "./schema.ts";

const databaseEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL must not be empty").optional(),
    DATABASE_URL_UNPOOLED: z
      .string()
      .min(1, "DATABASE_URL_UNPOOLED must not be empty")
      .optional(),
  })
  .refine((value) => Boolean(value.DATABASE_URL_UNPOOLED ?? value.DATABASE_URL), {
    message: "Either DATABASE_URL_UNPOOLED or DATABASE_URL is required",
  });

const { DATABASE_URL, DATABASE_URL_UNPOOLED } = databaseEnvSchema.parse(process.env);

export const db = drizzle({
  connection: DATABASE_URL_UNPOOLED ?? DATABASE_URL!,
  schema,
});
