import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.ts";
import { messages, threads } from "../db/schema.ts";
import type { InboundEmail, NormalizedEmailAddress } from "./types.ts";

const SUPPORTED_ENTRY_POINTS = new Set(["invoice-gen"]);

export interface ThreadResolutionInput {
  userId: number;
  inboundEmail: InboundEmail;
}

export interface ThreadResolutionResult {
  threadId: number;
  created: boolean;
  entryPoint: string;
}

function uniqueMessageIds(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function localPart(address: NormalizedEmailAddress) {
  return address.email.split("@")[0]?.toLowerCase() ?? "";
}

export function determineEntryPoint(to: NormalizedEmailAddress[]) {
  for (const address of to) {
    const candidate = localPart(address);

    if (SUPPORTED_ENTRY_POINTS.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unsupported inbound entry point for recipients: ${to.map((item) => item.email).join(", ")}`);
}

async function findThreadByMessageIds(userId: number, messageIds: string[]) {
  if (messageIds.length === 0) {
    return null;
  }

  const [matchedMessage] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.userId, userId),
        inArray(messages.externalMessageId, messageIds),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(1);

  if (matchedMessage) {
    return matchedMessage.threadId;
  }

  const [matchedThread] = await db
    .select({ threadId: threads.id })
    .from(threads)
    .where(and(eq(threads.userId, userId), inArray(threads.externalRootId, messageIds)))
    .limit(1);

  return matchedThread?.threadId ?? null;
}

export interface ThreadingStore {
  findThreadByMessageIds(userId: number, messageIds: string[]): Promise<number | null>;
  createThread(input: {
    userId: number;
    entryPoint: string;
    subject: string;
    externalRootId: string;
  }): Promise<number>;
}

const drizzleThreadingStore: ThreadingStore = {
  async findThreadByMessageIds(userId: number, messageIds: string[]) {
    return findThreadByMessageIds(userId, messageIds);
  },
  async createThread(input) {
    const [thread] = await db
      .insert(threads)
      .values({
        userId: input.userId,
        entryPoint: input.entryPoint,
        subject: input.subject,
        externalRootId: input.externalRootId,
      })
      .returning({ id: threads.id });

    if (!thread) {
      throw new Error("Failed to create thread for inbound email.");
    }

    return thread.id;
  },
};

export async function findOrCreateThread({
  userId,
  inboundEmail,
}: ThreadResolutionInput): Promise<ThreadResolutionResult> {
  return findOrCreateThreadWithStore(
    {
      userId,
      inboundEmail,
    },
    drizzleThreadingStore,
  );
}

export async function findOrCreateThreadWithStore(
  { userId, inboundEmail }: ThreadResolutionInput,
  store: ThreadingStore,
): Promise<ThreadResolutionResult> {
  const entryPoint = determineEntryPoint(inboundEmail.to);
  const candidateMessageIds = uniqueMessageIds([
    inboundEmail.messageId,
    inboundEmail.inReplyTo,
    ...inboundEmail.references,
  ]);

  const existingThreadId = await store.findThreadByMessageIds(userId, candidateMessageIds);

  if (existingThreadId !== null) {
    return {
      threadId: existingThreadId,
      created: false,
      entryPoint,
    };
  }

  const threadId = await store.createThread({
    userId,
    entryPoint,
    subject: inboundEmail.subject,
    externalRootId: inboundEmail.messageId,
  });

  return {
    threadId,
    created: true,
    entryPoint,
  };
}
