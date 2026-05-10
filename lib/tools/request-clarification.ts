import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { messages, threads, users } from "../db/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const requestClarificationSchema = z.object({
  messageToOwner: z.string().min(1),
});

type RequestClarificationArgs = z.infer<typeof requestClarificationSchema>;

export const requestClarificationTool: Tool<RequestClarificationArgs> = {
  name: "request_clarification",
  description:
    "Ask the owner a clear follow-up question when required invoice details are missing. Terminal for the current run.",
  terminal: true,
  parameters: {
    type: "object",
    properties: {
      messageToOwner: {
        type: "string",
        description: "Owner-facing clarification request with the exact missing information.",
      },
    },
    required: ["messageToOwner"],
    additionalProperties: false,
  },
  async run(rawArgs, ctx) {
    const args = requestClarificationSchema.parse(rawArgs);
    return requestClarification(args, ctx);
  },
};

export async function requestClarification(
  args: RequestClarificationArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, ctx.threadId)).limit(1);
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
  const latestInbound = await latestInboundMessage(ctx);

  if (!thread) {
    throw new Error(`Thread ${ctx.threadId} not found.`);
  }

  if (!owner) {
    throw new Error(`Owner user ${ctx.userId} not found.`);
  }

  const sent = await ctx.emailProvider.send({
    to: [{ email: owner.email, name: owner.name ?? undefined }],
    subject: thread.subject ? `Re: ${thread.subject}` : "Invoice details needed",
    text: args.messageToOwner,
    html: `<p>${escapeHtml(args.messageToOwner)}</p>`,
    thread: {
      messageId: thread.externalRootId ?? undefined,
      inReplyTo: latestInbound?.externalMessageId ?? thread.externalRootId,
      references: [thread.externalRootId, latestInbound?.externalMessageId].filter(
        (value): value is string => Boolean(value),
      ),
    },
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
      messageToOwner: args.messageToOwner,
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
