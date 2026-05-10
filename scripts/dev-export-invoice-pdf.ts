import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { desc, eq } from "drizzle-orm";

import { db } from "../lib/db/client.ts";
import { clients, invoices, lineItems, users } from "../lib/db/schema.ts";
import { pdfBufferFromInlineBlobKey, renderInvoicePdf } from "../lib/invoices/pdf.ts";

function readInvoiceIdArg() {
  const explicit = process.env.INVOICE_ID ?? process.argv[2];

  if (!explicit) {
    return null;
  }

  const parsed = Number.parseInt(explicit, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid invoice id: ${explicit}`);
  }

  return parsed;
}

async function findLatestInvoiceId() {
  const [invoice] = await db.select({ id: invoices.id }).from(invoices).orderBy(desc(invoices.id)).limit(1);

  if (!invoice) {
    throw new Error("No invoices found.");
  }

  return invoice.id;
}

async function main() {
  const invoiceId = readInvoiceIdArg() ?? (await findLatestInvoiceId());
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found.`);
  }

  const [owner] = await db.select().from(users).where(eq(users.id, invoice.userId)).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, invoice.clientId)).limit(1);
  const items = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.invoiceId, invoice.id))
    .orderBy(lineItems.position);

  if (!owner) {
    throw new Error(`Owner user ${invoice.userId} not found.`);
  }

  if (!client) {
    throw new Error(`Client ${invoice.clientId} not found.`);
  }

  const pdfBuffer = pdfBufferFromInlineBlobKey(invoice.pdfBlobKey) ?? (await renderInvoicePdf({ invoice, lineItems: items, user: owner, client }));
  const outDir = path.join(process.cwd(), "tmp", "invoices");
  const outPath = path.join(outDir, `invoice-${invoice.invoiceNumber}.pdf`);

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, pdfBuffer);

  console.log(
    JSON.stringify(
      {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        bytes: pdfBuffer.length,
        path: outPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to export invoice PDF.");
  console.error(error);
  process.exit(1);
});
