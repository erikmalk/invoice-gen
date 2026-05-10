import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { clients, invoices, lineItems, messages, threads, users } from "../db/schema.ts";
import { pdfBufferFromInlineBlobKey, renderInvoicePdf } from "../invoices/pdf.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const sendInvoiceForReviewSchema = z.object({
  invoiceId: z.number().int().positive(),
  messageToOwner: z.string().min(1),
});

type SendInvoiceForReviewArgs = z.infer<typeof sendInvoiceForReviewSchema>;

export const sendInvoiceForReviewTool: Tool<SendInvoiceForReviewArgs> = {
  name: "send_invoice_for_review",
  description:
    "Email the owner a draft invoice summary for review. This sends only to the owner and is terminal for the current run.",
  terminal: true,
  parameters: {
    type: "object",
    properties: {
      invoiceId: { type: "number" },
      messageToOwner: {
        type: "string",
        description: "Owner-facing note explaining what was drafted and what needs review.",
      },
    },
    required: ["invoiceId", "messageToOwner"],
    additionalProperties: false,
  },
  async run(rawArgs, ctx) {
    const args = sendInvoiceForReviewSchema.parse(rawArgs);
    return sendInvoiceForReview(args, ctx);
  },
};

export async function sendInvoiceForReview(
  args: SendInvoiceForReviewArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, ctx.threadId)).limit(1);
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
  const [invoice] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, args.invoiceId), eq(invoices.userId, ctx.userId)))
    .limit(1);

  if (!thread) {
    throw new Error(`Thread ${ctx.threadId} not found.`);
  }

  if (!owner) {
    throw new Error(`Owner user ${ctx.userId} not found.`);
  }

  if (!invoice) {
    throw new Error(`Invoice ${args.invoiceId} not found for current owner.`);
  }

  const [client] = await ctx.db.select().from(clients).where(eq(clients.id, invoice.clientId)).limit(1);
  const items = await ctx.db
    .select()
    .from(lineItems)
    .where(eq(lineItems.invoiceId, invoice.id))
    .orderBy(lineItems.position);
  const latestInbound = await latestInboundMessage(ctx);
  const invoiceSummary = summarizeInvoice(invoice, items, client?.companyName ?? client?.contactName ?? client?.email);
  const pdfBuffer = client ? pdfBufferFromInlineBlobKey(invoice.pdfBlobKey) ?? await renderInvoicePdf({ invoice, lineItems: items, user: owner, client }) : null;

  const sent = await ctx.emailProvider.send({
    to: [{ email: owner.email, name: owner.name ?? undefined }],
    subject: thread.subject ? `Re: ${thread.subject}` : `Review draft invoice ${invoice.invoiceNumber}`,
    text: `${args.messageToOwner}\n\n${invoiceSummary}`,
    html: `<p>${escapeHtml(args.messageToOwner)}</p><pre>${escapeHtml(invoiceSummary)}</pre>`,
    thread: {
      messageId: thread.externalRootId ?? undefined,
      inReplyTo: latestInbound?.externalMessageId ?? thread.externalRootId,
      references: [thread.externalRootId, latestInbound?.externalMessageId].filter(
        (value): value is string => Boolean(value),
      ),
    },
    attachments: pdfBuffer
      ? [
          {
            filename: `invoice-${invoice.invoiceNumber}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ]
      : undefined,
  });

  await ctx.db
    .update(threads)
    .set({ status: "awaiting_approval", updatedAt: new Date(), lastError: null })
    .where(eq(threads.id, ctx.threadId));

  return {
    ok: true,
    terminal: true,
    data: {
      sentMessageId: sent.messageId,
      threadStatus: "awaiting_approval",
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceSummary,
      pdfBlobKey: invoice.pdfBlobKey,
      pdfUrl: invoice.pdfBlobKey,
    },
  };
}

async function latestInboundMessage(ctx: ToolContext) {
  const rows = await ctx.db
    .select({ externalMessageId: messages.externalMessageId })
    .from(messages)
    .where(and(eq(messages.threadId, ctx.threadId), eq(messages.role, "user")))
    .orderBy(messages.sequenceNum);

  return rows.at(-1) ?? null;
}

function summarizeInvoice(
  invoice: typeof invoices.$inferSelect,
  items: Array<typeof lineItems.$inferSelect>,
  clientLabel: string | null | undefined,
) {
  return [
    `Invoice: ${invoice.invoiceNumber}`,
    `Client: ${clientLabel ?? `Client ${invoice.clientId}`}`,
    `Status: ${invoice.status}`,
    `Issued: ${invoice.issuedDate ?? ""}`,
    `Due: ${invoice.dueDate ?? ""}`,
    `Currency: ${invoice.currency}`,
    "Line items:",
    ...items.map(
      (item) =>
        `- ${item.description}: ${item.quantity} × ${formatCents(item.unitPriceCents, invoice.currency)} = ${formatCents(
          item.totalCents,
          invoice.currency,
        )}`,
    ),
    `Subtotal: ${formatCents(invoice.subtotalCents, invoice.currency)}`,
    `Tax: ${formatCents(invoice.taxCents, invoice.currency)}`,
    `Total: ${formatCents(invoice.totalCents, invoice.currency)}`,
    invoice.pdfBlobKey ? "PDF: attached" : "PDF: not available",
  ].join("\n");
}

function formatCents(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
