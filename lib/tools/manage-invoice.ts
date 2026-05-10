import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { clients, invoices, lineItems, users } from "../db/schema.ts";
import { generateNextInvoiceNumber } from "../invoices/numbering.ts";
import { makeInlinePdfBlobKey, pdfUrlForBlobKey, renderInvoicePdf } from "../invoices/pdf.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitPriceCents: z.number().int().min(0),
});

const manageInvoiceSchema = z.object({
  action: z.enum(["create", "update"]),
  invoiceId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  issuedDate: z.string().optional(),
  dueDate: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
  taxCents: z.number().int().min(0).optional(),
  notes: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
});

type ManageInvoiceArgs = z.infer<typeof manageInvoiceSchema>;

type NormalizedLineItem = z.infer<typeof lineItemSchema> & {
  position: number;
  totalCents: number;
};

export const manageInvoiceTool: Tool<ManageInvoiceArgs> = {
  name: "manage_invoice",
  description:
    "Create or update draft invoices. Creates line items, calculates totals, assigns invoice numbers, and returns a PDF artifact reference.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "update"] },
      invoiceId: { type: "number", description: "Required for update." },
      clientId: { type: "number", description: "Required for create; optional on update." },
      issuedDate: { type: "string", description: "YYYY-MM-DD. Defaults to today on create." },
      dueDate: { type: "string", description: "YYYY-MM-DD. Defaults to owner's default terms on create." },
      currency: { type: "string", description: "Three-letter currency code. Defaults to USD." },
      taxCents: { type: "number", description: "Tax in cents. Defaults to 0." },
      notes: { type: "string" },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            unitPriceCents: { type: "number" },
          },
          required: ["description", "unitPriceCents"],
          additionalProperties: false,
        },
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(rawArgs, ctx) {
    const args = manageInvoiceSchema.parse(rawArgs);

    if (args.action === "create") {
      return createInvoice(args, ctx);
    }

    return updateInvoice(args, ctx);
  },
};

async function createInvoice(args: ManageInvoiceArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.clientId) {
    throw new Error("manage_invoice create requires clientId.");
  }

  if (!args.lineItems?.length) {
    throw new Error("manage_invoice create requires at least one line item.");
  }

  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
  const [client] = await ctx.db
    .select()
    .from(clients)
    .where(and(eq(clients.id, args.clientId), eq(clients.userId, ctx.userId)))
    .limit(1);

  if (!owner) {
    throw new Error(`Owner user ${ctx.userId} not found.`);
  }

  if (!client) {
    throw new Error(`Client ${args.clientId} not found for current owner.`);
  }

  const issuedDate = args.issuedDate ?? todayDateString();
  const dueDate = args.dueDate ?? addDaysDateString(issuedDate, owner.defaultDueDays);
  const normalizedItems = normalizeLineItems(args.lineItems);
  const totals = calculateTotals(normalizedItems, args.taxCents ?? 0);
  const invoiceNumber = await generateNextInvoiceNumber(ctx.db, ctx.userId);

  const [invoice] = await ctx.db
    .insert(invoices)
    .values({
      userId: ctx.userId,
      clientId: client.id,
      threadId: ctx.threadId,
      status: "draft",
      invoiceNumber,
      issuedDate,
      dueDate,
      currency: args.currency ?? "USD",
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      notes: args.notes,
    })
    .returning();

  if (!invoice) {
    throw new Error("Failed to create invoice.");
  }

  await insertLineItems(ctx, invoice.id, normalizedItems);

  const persistedItems = await ctx.db
    .select()
    .from(lineItems)
    .where(eq(lineItems.invoiceId, invoice.id))
    .orderBy(lineItems.position);
  const pdfBuffer = await renderInvoicePdf({ invoice, lineItems: persistedItems, user: owner, client });
  const pdfBlobKey = makeInlinePdfBlobKey(invoice, pdfBuffer);
  const [updatedInvoice] = await ctx.db
    .update(invoices)
    .set({ pdfBlobKey, updatedAt: new Date() })
    .where(eq(invoices.id, invoice.id))
    .returning();

  return invoiceResult(updatedInvoice ?? { ...invoice, pdfBlobKey }, persistedItems, client.companyName ?? client.contactName ?? client.email);
}

async function updateInvoice(args: ManageInvoiceArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.invoiceId) {
    throw new Error("manage_invoice update requires invoiceId.");
  }

  const [existing] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, args.invoiceId), eq(invoices.userId, ctx.userId)))
    .limit(1);

  if (!existing) {
    throw new Error(`Invoice ${args.invoiceId} not found for current owner.`);
  }

  if (existing.status !== "draft") {
    throw new Error(`Only draft invoices can be updated; invoice ${existing.id} is ${existing.status}.`);
  }

  const clientId = args.clientId ?? existing.clientId;
  const [client] = await ctx.db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, ctx.userId)))
    .limit(1);
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);

  if (!owner) {
    throw new Error(`Owner user ${ctx.userId} not found.`);
  }

  if (!client) {
    throw new Error(`Client ${clientId} not found for current owner.`);
  }

  let persistedItems = await ctx.db
    .select()
    .from(lineItems)
    .where(eq(lineItems.invoiceId, existing.id))
    .orderBy(lineItems.position);

  let subtotalCents = existing.subtotalCents;

  if (args.lineItems?.length) {
    const normalizedItems = normalizeLineItems(args.lineItems);
    await ctx.db.delete(lineItems).where(eq(lineItems.invoiceId, existing.id));
    await insertLineItems(ctx, existing.id, normalizedItems);
    persistedItems = await ctx.db
      .select()
      .from(lineItems)
      .where(eq(lineItems.invoiceId, existing.id))
      .orderBy(lineItems.position);
    subtotalCents = normalizedItems.reduce((sum, item) => sum + item.totalCents, 0);
  }

  const taxCents = args.taxCents ?? existing.taxCents;
  const [updatedInvoice] = await ctx.db
    .update(invoices)
    .set({
      clientId: client.id,
      issuedDate: args.issuedDate ?? existing.issuedDate,
      dueDate: args.dueDate ?? existing.dueDate,
      currency: args.currency ?? existing.currency,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
      notes: args.notes ?? existing.notes,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, existing.id))
    .returning();

  if (!updatedInvoice) {
    throw new Error(`Failed to update invoice ${existing.id}.`);
  }

  const pdfBuffer = await renderInvoicePdf({
    invoice: updatedInvoice,
    lineItems: persistedItems,
    user: owner,
    client,
  });
  const pdfBlobKey = makeInlinePdfBlobKey(updatedInvoice, pdfBuffer);
  const [invoiceWithPdf] = await ctx.db
    .update(invoices)
    .set({ pdfBlobKey, updatedAt: new Date() })
    .where(eq(invoices.id, updatedInvoice.id))
    .returning();

  return invoiceResult(
    invoiceWithPdf ?? { ...updatedInvoice, pdfBlobKey },
    persistedItems,
    client.companyName ?? client.contactName ?? client.email,
  );
}

async function insertLineItems(ctx: ToolContext, invoiceId: number, items: NormalizedLineItem[]) {
  await ctx.db.insert(lineItems).values(
    items.map((item) => ({
      invoiceId,
      position: item.position,
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
    })),
  );
}

function normalizeLineItems(items: z.infer<typeof lineItemSchema>[]): NormalizedLineItem[] {
  return items.map((item, index) => ({
    ...item,
    position: index + 1,
    totalCents: Math.round(item.quantity * item.unitPriceCents),
  }));
}

function calculateTotals(items: NormalizedLineItem[], taxCents: number) {
  const subtotalCents = items.reduce((sum, item) => sum + item.totalCents, 0);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

function invoiceResult(
  invoice: typeof invoices.$inferSelect,
  items: Array<typeof lineItems.$inferSelect>,
  clientLabel: string | null,
): ToolResult {
  return {
    ok: true,
    data: {
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        clientId: invoice.clientId,
        clientLabel,
        issuedDate: invoice.issuedDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        subtotalCents: invoice.subtotalCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        notes: invoice.notes,
        pdfBlobKey: invoice.pdfBlobKey,
        pdfUrl: pdfUrlForBlobKey(invoice.pdfBlobKey),
      },
      lineItems: items.map((item) => ({
        id: item.id,
        position: item.position,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
      })),
    },
  };
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysDateString(yyyyMmDd: string, days: number) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
