import { Buffer } from "node:buffer";

import type { Client, Invoice, LineItem, User } from "../db/schema.ts";

export interface InvoicePdfInput {
  invoice: Invoice;
  lineItems: LineItem[];
  user: User;
  client: Client;
}

function formatCents(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const { invoice, lineItems, user, client } = input;
  const lines = [
    `Invoice ${invoice.invoiceNumber}`,
    "",
    `From: ${user.companyName ?? user.name ?? user.email}`,
    user.companyAddress ?? "",
    "",
    `Bill To: ${client.companyName ?? client.contactName ?? client.email ?? `Client ${client.id}`}`,
    client.contactName ? `Contact: ${client.contactName}` : "",
    client.email ? `Email: ${client.email}` : "",
    client.address ?? "",
    "",
    `Issued: ${invoice.issuedDate ?? ""}`,
    `Due: ${invoice.dueDate ?? ""}`,
    `Status: ${invoice.status}`,
    "",
    "Line items:",
    ...lineItems.map((item) =>
      `${item.position}. ${item.description} — ${item.quantity} × ${formatCents(
        item.unitPriceCents,
        invoice.currency,
      )} = ${formatCents(item.totalCents, invoice.currency)}`,
    ),
    "",
    `Subtotal: ${formatCents(invoice.subtotalCents, invoice.currency)}`,
    `Tax: ${formatCents(invoice.taxCents, invoice.currency)}`,
    `Total: ${formatCents(invoice.totalCents, invoice.currency)}`,
    invoice.notes ? `Notes: ${invoice.notes}` : "",
  ].filter((line) => line !== "");

  return Buffer.from(lines.join("\n"), "utf8");
}

export function makeInlinePdfBlobKey(invoice: Invoice, pdfBuffer: Buffer) {
  const encoded = pdfBuffer.toString("base64url");
  return `inline-pdf:${invoice.invoiceNumber}:${encoded}`;
}

export function pdfUrlForBlobKey(pdfBlobKey: string | null) {
  return pdfBlobKey ? pdfBlobKey : null;
}
