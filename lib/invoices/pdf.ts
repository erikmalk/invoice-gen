import { Buffer } from "node:buffer";

import React from "react";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

import type { Client, Invoice, LineItem, User } from "../db/schema.ts";

export interface InvoicePdfInput {
  invoice: Invoice;
  lineItems: LineItem[];
  user: User;
  client: Client;
}

const styles = StyleSheet.create({
  page: {
    padding: 48,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#111827",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 6,
  },
  invoiceNumber: {
    fontSize: 12,
    color: "#4b5563",
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    color: "#6b7280",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  twoColumns: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
    marginBottom: 24,
  },
  column: {
    flexGrow: 1,
    flexBasis: 0,
  },
  muted: {
    color: "#6b7280",
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  table: {
    borderTopWidth: 1,
    borderTopColor: "#d1d5db",
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db",
    marginTop: 8,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f3f4f6",
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db",
    fontWeight: 700,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  descriptionCell: {
    flex: 1,
    padding: 8,
  },
  numericCell: {
    width: 80,
    padding: 8,
    textAlign: "right",
  },
  totals: {
    marginLeft: "auto",
    marginTop: 14,
    width: 220,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 5,
  },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#111827",
    paddingTop: 8,
    marginTop: 4,
    fontSize: 14,
    fontWeight: 700,
  },
  notes: {
    marginTop: 28,
    padding: 12,
    backgroundColor: "#f9fafb",
  },
});

function formatCents(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function companyLabel(user: User) {
  return user.companyName ?? user.name ?? user.email;
}

function clientLabel(client: Client) {
  return client.companyName ?? client.contactName ?? client.email ?? `Client ${client.id}`;
}

function lines(value: string | null | undefined) {
  return value?.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
}

function text(value: string | number | null | undefined, fallback = "") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function invoiceDocument(input: InvoicePdfInput) {
  const { invoice, lineItems, user, client } = input;

  return React.createElement(
    Document,
    {
      title: `Invoice ${invoice.invoiceNumber}`,
      author: companyLabel(user),
      subject: `Invoice ${invoice.invoiceNumber} for ${clientLabel(client)}`,
      creator: "Example Org Invoice Generator",
    },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(
        View,
        { style: styles.header },
        React.createElement(
          View,
          null,
          React.createElement(Text, { style: styles.title }, "Invoice"),
          React.createElement(Text, { style: styles.invoiceNumber }, invoice.invoiceNumber),
        ),
        React.createElement(
          View,
          { style: { width: 190 } },
          React.createElement(View, { style: styles.metaRow }, React.createElement(Text, null, "Issued"), React.createElement(Text, null, text(invoice.issuedDate))),
          React.createElement(View, { style: styles.metaRow }, React.createElement(Text, null, "Due"), React.createElement(Text, null, text(invoice.dueDate))),
          React.createElement(View, { style: styles.metaRow }, React.createElement(Text, null, "Status"), React.createElement(Text, null, invoice.status)),
        ),
      ),
      React.createElement(
        View,
        { style: styles.twoColumns },
        React.createElement(
          View,
          { style: styles.column },
          React.createElement(Text, { style: styles.sectionTitle }, "From"),
          React.createElement(Text, null, companyLabel(user)),
          ...lines(user.companyAddress).map((line) => React.createElement(Text, { key: line, style: styles.muted }, line)),
          user.companyPhone ? React.createElement(Text, { style: styles.muted }, user.companyPhone) : null,
          user.taxId ? React.createElement(Text, { style: styles.muted }, `Tax ID: ${user.taxId}`) : null,
        ),
        React.createElement(
          View,
          { style: styles.column },
          React.createElement(Text, { style: styles.sectionTitle }, "Bill To"),
          React.createElement(Text, null, clientLabel(client)),
          client.contactName ? React.createElement(Text, { style: styles.muted }, client.contactName) : null,
          client.email ? React.createElement(Text, { style: styles.muted }, client.email) : null,
          ...lines(client.address).map((line) => React.createElement(Text, { key: line, style: styles.muted }, line)),
        ),
      ),
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, "Line items"),
        React.createElement(
          View,
          { style: styles.table },
          React.createElement(
            View,
            { style: styles.tableHeader },
            React.createElement(Text, { style: styles.descriptionCell }, "Description"),
            React.createElement(Text, { style: styles.numericCell }, "Qty"),
            React.createElement(Text, { style: styles.numericCell }, "Unit"),
            React.createElement(Text, { style: styles.numericCell }, "Amount"),
          ),
          ...lineItems.map((item) =>
            React.createElement(
              View,
              { key: item.id, style: styles.tableRow },
              React.createElement(Text, { style: styles.descriptionCell }, item.description),
              React.createElement(Text, { style: styles.numericCell }, item.quantity.toString()),
              React.createElement(Text, { style: styles.numericCell }, formatCents(item.unitPriceCents, invoice.currency)),
              React.createElement(Text, { style: styles.numericCell }, formatCents(item.totalCents, invoice.currency)),
            ),
          ),
        ),
        React.createElement(
          View,
          { style: styles.totals },
          React.createElement(View, { style: styles.totalRow }, React.createElement(Text, null, "Subtotal"), React.createElement(Text, null, formatCents(invoice.subtotalCents, invoice.currency))),
          React.createElement(View, { style: styles.totalRow }, React.createElement(Text, null, "Tax"), React.createElement(Text, null, formatCents(invoice.taxCents, invoice.currency))),
          React.createElement(View, { style: styles.grandTotal }, React.createElement(Text, null, "Total"), React.createElement(Text, null, formatCents(invoice.totalCents, invoice.currency))),
        ),
      ),
      invoice.notes
        ? React.createElement(
            View,
            { style: styles.notes },
            React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
            React.createElement(Text, null, invoice.notes),
          )
        : null,
    ),
  );
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const rendered = await renderToBuffer(invoiceDocument(input));
  return Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered);
}

export function makeInlinePdfBlobKey(invoice: Invoice, pdfBuffer: Buffer) {
  const encoded = pdfBuffer.toString("base64url");
  return `inline-pdf:${invoice.invoiceNumber}:${encoded}`;
}

export function pdfBufferFromInlineBlobKey(pdfBlobKey: string | null | undefined) {
  if (!pdfBlobKey?.startsWith("inline-pdf:")) {
    return null;
  }

  const [, , encoded] = pdfBlobKey.split(":", 3);

  if (!encoded) {
    return null;
  }

  const buffer = Buffer.from(encoded, "base64url");
  return buffer.subarray(0, 5).toString("utf8") === "%PDF-" ? buffer : null;
}

export function pdfUrlForBlobKey(pdfBlobKey: string | null) {
  return pdfBlobKey ? pdfBlobKey : null;
}
