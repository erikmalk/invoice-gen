import { and, eq, ilike, or } from "drizzle-orm";
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
  const query = `%${args.query.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const limit = args.limit ?? 10;

  const matches = await ctx.db
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
    .where(
      and(
        eq(clients.userId, ctx.userId),
        or(
          ilike(clients.companyName, query),
          ilike(clients.contactName, query),
          ilike(clients.email, query),
          ilike(clients.address, query),
        ),
      ),
    )
    .limit(limit);

  return {
    ok: true,
    data: {
      matches,
      count: matches.length,
    },
  };
}
