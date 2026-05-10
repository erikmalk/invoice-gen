import { eq } from "drizzle-orm";
import { z } from "zod";

import { clients } from "../db/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const searchClientDbSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

type SearchClientDbArgs = z.infer<typeof searchClientDbSchema>;

export const searchClientDbTool: Tool<SearchClientDbArgs> = {
  name: "search_client_db",
  description:
    "Search the owner's client database by company, contact, email, or address. Results are scoped to the current owner.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Client/company/contact/email/address text to search for." },
      limit: { type: "number", description: "Maximum matches to return, default 10, max 20." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(rawArgs, ctx) {
    const args = searchClientDbSchema.parse(rawArgs);
    return searchClientDb(args, ctx);
  },
};

export async function searchClientDb(args: SearchClientDbArgs, ctx: ToolContext): Promise<ToolResult> {
  const rawQuery = args.query.trim();
  const normalizedQuery = normalizeSearchText(rawQuery);
  const limit = args.limit ?? 10;

  const candidates = await ctx.db
    .select({
      id: clients.id,
      companyName: clients.companyName,
      contactName: clients.contactName,
      email: clients.email,
      address: clients.address,
      phone: clients.phone,
      notes: clients.notes,
    })
    .from(clients)
    .where(eq(clients.userId, ctx.userId));

  const matches = candidates
    .map((client) => ({
      ...client,
      matchScore: scoreClientMatch(rawQuery, normalizedQuery, client),
    }))
    .filter((client) => client.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || a.id - b.id)
    .slice(0, limit);

  return {
    ok: true,
    data: {
      matches,
      count: matches.length,
    },
  };
}

const ORGANIZATION_SUFFIXES = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "lp",
  "llp",
  "pllc",
]);

function normalizeSearchText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@.]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token && !ORGANIZATION_SUFFIXES.has(token))
    .join(" ")
    .trim();
}

function scoreClientMatch(
  rawQuery: string,
  normalizedQuery: string,
  client: {
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    address: string | null;
    phone: string | null;
    notes: string | null;
  },
) {
  if (!normalizedQuery) {
    return 0;
  }

  const fieldScores = [
    scoreField(rawQuery, normalizedQuery, client.companyName, 1),
    scoreField(rawQuery, normalizedQuery, client.contactName, 0.9),
    scoreField(rawQuery, normalizedQuery, client.email, 0.95),
    scoreField(rawQuery, normalizedQuery, client.address, 0.55),
    scoreField(rawQuery, normalizedQuery, client.phone, 0.45),
    scoreField(rawQuery, normalizedQuery, client.notes, 0.35),
  ];

  return Math.max(...fieldScores);
}

function scoreField(rawQuery: string, normalizedQuery: string, value: string | null | undefined, weight: number) {
  const normalizedValue = normalizeSearchText(value);

  if (!normalizedValue) {
    return 0;
  }

  let score = 0;

  if (normalizedValue === normalizedQuery) {
    score = 100;
  } else if (normalizedValue.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedValue)) {
    score = 88;
  } else if (normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue)) {
    score = 78;
  } else {
    const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
    const valueTokens = new Set(normalizedValue.split(" ").filter(Boolean));
    const overlap = [...queryTokens].filter((token) => valueTokens.has(token)).length;
    const ratio = overlap / Math.max(queryTokens.size, 1);

    score = ratio >= 0.5 ? Math.round(65 * ratio) : 0;
  }

  const rawValue = (value ?? "").toLowerCase();
  const rawNeedle = rawQuery.toLowerCase();

  if (rawNeedle && rawValue.includes(rawNeedle)) {
    score = Math.max(score, 92);
  }

  return Math.round(score * weight);
}
