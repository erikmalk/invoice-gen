import { eq } from "drizzle-orm";

import { DEFAULT_INVOICE_GEN_PROMPT } from "../lib/agent/default-prompts.ts";
import { db } from "../lib/db/client.ts";
import { settings } from "../lib/db/schema.ts";

async function main() {
  const [updated] = await db
    .update(settings)
    .set({
      value: DEFAULT_INVOICE_GEN_PROMPT,
      description:
        "System prompt text for the invoice generator agent. This database setting is the runtime source of truth.",
      updatedAt: new Date(),
    })
    .where(eq(settings.key, "invoice_gen_system_prompt"))
    .returning({ key: settings.key, updatedAt: settings.updatedAt });

  if (!updated) {
    await db.insert(settings).values({
      key: "invoice_gen_system_prompt",
      value: DEFAULT_INVOICE_GEN_PROMPT,
      description:
        "System prompt text for the invoice generator agent. This database setting is the runtime source of truth.",
    });
  }

  console.log(
    JSON.stringify(
      {
        key: "invoice_gen_system_prompt",
        updated: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to update invoice-gen prompt.");
  console.error(error);
  process.exit(1);
});
