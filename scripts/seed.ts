import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db/client.ts";
import { settings, users } from "../lib/db/schema.ts";

type SeedSetting = {
  key: string;
  value: unknown;
  description: string;
};

const seedEnvSchema = z.object({
  OWNER_EMAIL: z.string().email("OWNER_EMAIL must be a valid email address"),
});

const { OWNER_EMAIL } = seedEnvSchema.parse(process.env);

const defaultOwnerProfile = {
  name: "Owner",
  companyName: "Invoice Generator",
  companyAddress: "123 Main Street\nAnytown, USA 00000",
  companyPhone: "+1 (555) 010-0000",
  taxId: "TAX-ID-PENDING",
  defaultDueDays: 14,
} as const;

const baseSeededSettings = [
  {
    key: "invoice_gen_model_name",
    description: "Default OpenAI model used by the invoice generator agent.",
  },
  {
    key: "invoice_gen_max_agent_steps",
    description: "Maximum number of agent loop steps before the job errors.",
  },
  {
    key: "invoice_gen_max_wall_clock_seconds",
    description: "Maximum wall-clock runtime allowed for a single agent job.",
  },
  {
    key: "invoice_gen_system_prompt_path",
    description: "File path for the invoice generator system prompt.",
  },
  {
    key: "invoice_gen_require_approval_for_send_to_client",
    description: "Whether sending an approved invoice to the client requires explicit approval.",
  },
  {
    key: "invoice_gen_default_currency",
    description: "Default invoice currency used when the agent does not infer one.",
  },
  {
    key: "owner_user_id",
    description: "Primary owner user id for the single-user bootstrap configuration.",
  },
] as const;

async function findExistingOwnerUserId() {
  const [ownerUserIdSetting] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "owner_user_id"));

  const ownerUserId = ownerUserIdSetting?.value;

  if (typeof ownerUserId === "number") {
    return ownerUserId;
  }

  return null;
}

async function upsertOwnerUser() {
  const existingOwnerUserId = await findExistingOwnerUserId();

  if (existingOwnerUserId !== null) {
    await db
      .update(users)
      .set({
        email: OWNER_EMAIL,
        ...defaultOwnerProfile,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingOwnerUserId));
  } else {
    await db
      .insert(users)
      .values({
        email: OWNER_EMAIL,
        ...defaultOwnerProfile,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          email: OWNER_EMAIL,
          ...defaultOwnerProfile,
          updatedAt: new Date(),
        },
        setWhere: sql`
          ${users.name} is distinct from excluded.name
          or ${users.companyName} is distinct from excluded.company_name
          or ${users.companyAddress} is distinct from excluded.company_address
          or ${users.companyPhone} is distinct from excluded.company_phone
          or ${users.taxId} is distinct from excluded.tax_id
          or ${users.defaultDueDays} is distinct from excluded.default_due_days
        `,
      });
  }

  const [owner] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, OWNER_EMAIL));

  if (!owner) {
    throw new Error("Failed to upsert owner user.");
  }

  return owner;
}

async function upsertSetting(input: SeedSetting) {
  await db
    .insert(settings)
    .values({
      key: input.key,
      value: input.value,
      description: input.description,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: input.value,
        description: input.description,
        updatedAt: new Date(),
      },
      setWhere: sql`
        ${settings.value} is distinct from ${JSON.stringify(input.value)}::jsonb
        or ${settings.description} is distinct from ${input.description}
      `,
    });
}

async function main() {
  const owner = await upsertOwnerUser();

  const settingValues: SeedSetting[] = [
    {
      ...baseSeededSettings[0],
      value: "gpt-5.4",
    },
    {
      ...baseSeededSettings[1],
      value: 10,
    },
    {
      ...baseSeededSettings[2],
      value: 600,
    },
    {
      ...baseSeededSettings[3],
      value: "prompts/invoice-gen.md",
    },
    {
      ...baseSeededSettings[4],
      value: true,
    },
    {
      ...baseSeededSettings[5],
      value: "USD",
    },
    {
      ...baseSeededSettings[6],
      value: owner.id,
    },
  ];

  for (const setting of settingValues) {
    await upsertSetting(setting);
  }

  const [ownerUserIdSetting] = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.key, "owner_user_id"));

  if (!ownerUserIdSetting) {
    throw new Error("Failed to verify seeded owner_user_id setting.");
  }

  console.log(
    JSON.stringify(
      {
        ownerEmail: owner.email,
        ownerUserId: owner.id,
        ownerUserIdSetting: ownerUserIdSetting?.value ?? null,
        seededSettings: settingValues.map((setting) => setting.key),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to seed the database.");
  console.error(error);
  process.exit(1);
});
