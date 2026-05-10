import { and, desc, eq, like } from "drizzle-orm";

import { invoices } from "../db/schema.ts";
import type { AppDb } from "../tools/types.ts";

function currentYear() {
  return new Date().getUTCFullYear().toString();
}

export async function generateNextInvoiceNumber(db: AppDb, userId: number, year = currentYear()) {
  const prefix = `${year}-`;
  const [latest] = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(and(eq(invoices.userId, userId), like(invoices.invoiceNumber, `${prefix}%`)))
    .orderBy(desc(invoices.invoiceNumber))
    .limit(1);

  const latestSequence = latest?.invoiceNumber?.startsWith(prefix)
    ? Number.parseInt(latest.invoiceNumber.slice(prefix.length), 10)
    : 0;
  const nextSequence = Number.isFinite(latestSequence) ? latestSequence + 1 : 1;

  return `${prefix}${nextSequence.toString().padStart(4, "0")}`;
}
