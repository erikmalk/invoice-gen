import { eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

export async function getSetting(key: string) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  return row?.value;
}
