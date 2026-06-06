import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { clients, invoices } from "../db/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const manageClientsSchema = z.object({
  action: z.enum(["read", "create", "update", "delete"]),
  clientId: z.number().int().positive().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

type ManageClientsArgs = z.infer<typeof manageClientsSchema>;
type ClientRecord = typeof clients.$inferSelect;
type ClientInsert = typeof clients.$inferInsert;

const SYSTEM_FIELD_NAMES = new Set(["id", "userId", "createdAt", "updatedAt"]);
const KNOWN_NON_COLUMN_EXPORTS = new Set(["enableRLS"]);

export const manageClientsTool: Tool<ManageClientsArgs> = {
  name: "manage_clients",
  description:
    "Read, create, update, or delete client records for the current owner. For create/update, pass a JSON object in `values` whose keys are client table field names. Current writable fields are companyName, contactName, email, address, phone, and notes. Future client fields are supported automatically when their JSON keys match writable client table fields. Omitted fields are kept unchanged on update; pass null to clear nullable fields. Always read or search for the intended client first when the client identity is ambiguous.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "create", "update", "delete"],
        description: "CRUD action to perform.",
      },
      clientId: {
        type: "number",
        description: "Required for read, update, and delete. Must belong to the current owner.",
      },
      values: {
        type: "object",
        description:
          "JSON object of field names to write for create/update. Use camelCase client field names. Example: {\"companyName\":\"Acme LLC\",\"contactName\":\"Ada Lovelace\",\"email\":\"billing@acme.test\",\"address\":\"123 Main St\",\"phone\":\"555-0100\",\"notes\":\"Net 30\"}. Unknown/non-writable keys are ignored and reported; omitted keys are unchanged on update; null clears nullable fields.",
        additionalProperties: true,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(rawArgs, ctx) {
    const args = manageClientsSchema.parse(rawArgs);

    switch (args.action) {
      case "read":
        return readClient(args, ctx);
      case "create":
        return createClient(args, ctx);
      case "update":
        return updateClient(args, ctx);
      case "delete":
        return deleteClient(args, ctx);
    }
  },
};

async function readClient(args: ManageClientsArgs, ctx: ToolContext): Promise<ToolResult> {
  const existing = await requireClient(args.clientId, ctx);

  return {
    ok: true,
    data: {
      action: "read",
      client: formatClientRecord(existing),
      writableFields: getWritableClientFieldNames(),
    },
  };
}

async function createClient(args: ManageClientsArgs, ctx: ToolContext): Promise<ToolResult> {
  const { values, ignoredFields } = normalizeClientValues(args.values);

  if (!Object.keys(values).length) {
    throw new Error(
      `manage_clients create requires at least one writable value. Writable fields: ${getWritableClientFieldNames().join(", ")}.`,
    );
  }

  const [created] = await ctx.db
    .insert(clients)
    .values({
      ...values,
      userId: ctx.userId,
    })
    .returning();

  if (!created) {
    throw new Error("Failed to create client.");
  }

  return {
    ok: true,
    data: {
      action: "create",
      client: formatClientRecord(created),
      ignoredFields,
      writableFields: getWritableClientFieldNames(),
    },
  };
}

async function updateClient(args: ManageClientsArgs, ctx: ToolContext): Promise<ToolResult> {
  const existing = await requireClient(args.clientId, ctx);
  const { values, ignoredFields } = normalizeClientValues(args.values);

  if (!Object.keys(values).length) {
    throw new Error(
      `manage_clients update requires at least one writable value. Writable fields: ${getWritableClientFieldNames().join(", ")}.`,
    );
  }

  const [updated] = await ctx.db
    .update(clients)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(and(eq(clients.id, existing.id), eq(clients.userId, ctx.userId)))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update client ${existing.id}.`);
  }

  return {
    ok: true,
    data: {
      action: "update",
      previousClient: formatClientRecord(existing),
      client: formatClientRecord(updated),
      ignoredFields,
      writableFields: getWritableClientFieldNames(),
    },
  };
}

async function deleteClient(args: ManageClientsArgs, ctx: ToolContext): Promise<ToolResult> {
  const existing = await requireClient(args.clientId, ctx);
  const referencingInvoices = await invoiceReferenceSummary(existing.id, ctx);

  if (referencingInvoices.count > 0) {
    return {
      ok: false,
      error: `Client ${existing.id} cannot be deleted because ${referencingInvoices.count} invoice(s) reference it.`,
      data: {
        action: "delete",
        client: formatClientRecord(existing),
        referencingInvoices,
        guidance:
          "Keep this client record because invoices reference it. Tell the owner it cannot be deleted without first removing or reassigning those invoices.",
      },
    };
  }

  const [deleted] = await ctx.db
    .delete(clients)
    .where(and(eq(clients.id, existing.id), eq(clients.userId, ctx.userId)))
    .returning();

  if (!deleted) {
    throw new Error(`Failed to delete client ${existing.id}.`);
  }

  return {
    ok: true,
    data: {
      action: "delete",
      deletedClient: formatClientRecord(deleted),
      writableFields: getWritableClientFieldNames(),
    },
  };
}

async function invoiceReferenceSummary(clientId: number, ctx: ToolContext) {
  const [summary] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), eq(invoices.userId, ctx.userId)));
  const referencedInvoices = await ctx.db
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), eq(invoices.userId, ctx.userId)))
    .limit(10);

  return {
    count: summary?.count ?? 0,
    invoices: referencedInvoices,
  };
}

async function requireClient(clientId: number | undefined, ctx: ToolContext) {
  if (!clientId) {
    throw new Error("manage_clients action requires clientId.");
  }

  const [existing] = await ctx.db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, ctx.userId)))
    .limit(1);

  if (!existing) {
    throw new Error(`Client ${clientId} not found for current owner.`);
  }

  return existing;
}

function normalizeClientValues(rawValues: ManageClientsArgs["values"]) {
  const writableFields = new Set(getWritableClientFieldNames());
  const values: Record<string, unknown> = {};
  const ignoredFields: string[] = [];

  for (const [key, value] of Object.entries(rawValues ?? {})) {
    if (!writableFields.has(key)) {
      ignoredFields.push(key);
      continue;
    }

    values[key] = value as ClientInsert[keyof ClientInsert];
  }

  return { values, ignoredFields };
}

function getWritableClientFieldNames() {
  return getClientFieldNames().filter((fieldName) => !SYSTEM_FIELD_NAMES.has(fieldName));
}

function getClientFieldNames() {
  return Object.entries(clients)
    .filter(([fieldName, value]) => {
      if (KNOWN_NON_COLUMN_EXPORTS.has(fieldName)) {
        return false;
      }

      return Boolean(value && typeof value === "object" && "name" in value);
    })
    .map(([fieldName]) => fieldName);
}

function formatClientRecord(client: ClientRecord) {
  return Object.fromEntries(
    Object.entries(client)
      .filter(([fieldName]) => fieldName !== "userId")
      .map(([fieldName, value]) => [fieldName, serializeValue(value)]),
  );
}

function serializeValue(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}
