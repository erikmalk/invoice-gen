import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  customType,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: citext("email").notNull().unique(),
  name: text("name"),
  companyName: text("company_name"),
  companyAddress: text("company_address"),
  companyPhone: text("company_phone"),
  taxId: text("tax_id"),
  defaultDueDays: integer("default_due_days").notNull().default(14),
  ...timestamps,
});

export const clients = pgTable(
  "clients",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyName: text("company_name"),
    contactName: text("contact_name"),
    email: citext("email"),
    address: text("address"),
    phone: text("phone"),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    index("clients_user_id_idx").on(table.userId),
    unique("clients_user_id_company_name_email_unique").on(
      table.userId,
      table.companyName,
      table.email,
    ),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryPoint: text("entry_point").notNull(),
    subject: text("subject"),
    externalRootId: text("external_root_id").unique(),
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [index("threads_external_root_id_idx").on(table.externalRootId)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: bigint("client_id", { mode: "number" })
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    threadId: bigint("thread_id", { mode: "number" }).references(() => threads.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("draft"),
    invoiceNumber: text("invoice_number").notNull(),
    issuedDate: date("issued_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    currency: text("currency").notNull().default("USD"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    pdfBlobKey: text("pdf_blob_key"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripePaymentUrl: text("stripe_payment_url"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("invoices_user_id_idx").on(table.userId),
    unique("invoices_user_id_invoice_number_unique").on(table.userId, table.invoiceNumber),
  ],
);

export const lineItems = pgTable("line_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  invoiceId: bigint("invoice_id", { mode: "number" })
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" })
    .notNull()
    .default(1),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    threadId: bigint("thread_id", { mode: "number" })
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    sequenceNum: integer("sequence_num").notNull(),
    role: text("role").notNull(),
    content: text("content"),
    toolCalls: jsonb("tool_calls").$type<
      Array<{ id: string; name: string; arguments: unknown }>
    >(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    tokenUsage: jsonb("token_usage").$type<{
      prompt?: number;
      completion?: number;
      total?: number;
    }>(),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_thread_id_idx").on(table.threadId),
    unique("messages_thread_id_sequence_num_unique").on(table.threadId, table.sequenceNum),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("jobs_status_scheduled_for_idx").on(table.status, table.scheduledFor)],
);

export const schema = {
  users,
  clients,
  threads,
  invoices,
  lineItems,
  messages,
  settings,
  jobs,
};

export type JsonValue = typeof settings.$inferSelect.value;
export type User = typeof users.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type LineItem = typeof lineItems.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Job = typeof jobs.$inferSelect;

export const now = sql`now()`;
