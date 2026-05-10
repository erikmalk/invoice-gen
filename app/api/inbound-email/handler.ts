import { waitUntil } from "@vercel/functions";
import { eq, sql } from "drizzle-orm";

import { db } from "../../../lib/db/client.ts";
import { jobs, messages, users } from "../../../lib/db/schema.ts";
import {
  resendEmailProvider,
  type ResendEmailProvider,
} from "../../../lib/email/resend.ts";
import {
  findOrCreateThread,
  type ThreadResolutionResult,
} from "../../../lib/email/threading.ts";
import type { InboundEmail } from "../../../lib/email/types.ts";
import { runJob } from "../../../lib/jobs/run.ts";

const DMARC_PASS_PATTERN = /\bdmarc\s*=\s*pass\b/i;
const DMARC_HEADER_FROM_PATTERN = /\bheader\.from\s*=\s*([^\s;]+)/i;

export interface InboundEmailRouteDependencies {
  emailProvider: Pick<ResendEmailProvider, "verifyInboundSignature" | "parseInbound">;
  findUserByEmail(email: string): Promise<{ id: number; email: string } | null>;
  findOrCreateThread(input: {
    userId: number;
    inboundEmail: InboundEmail;
  }): Promise<ThreadResolutionResult>;
  persistInboundMessage(threadId: number, content: string, messageId: string): Promise<{ inserted: boolean }>;
  enqueueInboundJob(threadId: number): Promise<number>;
  waitUntil(task: Promise<unknown>): void;
  runJob(jobId: number): Promise<unknown>;
}

async function nextSequenceNumber(threadId: number) {
  const [row] = await db
    .select({
      nextValue: sql<number>`coalesce(max(${messages.sequenceNum}), 0) + 1`,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId));

  return row?.nextValue ?? 1;
}

async function findUserByEmail(email: string) {
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return user ?? null;
}

async function persistInboundMessage(threadId: number, content: string, messageId: string) {
  const [existingMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.externalMessageId, messageId))
    .limit(1);

  if (existingMessage) {
    return { inserted: false } as const;
  }

  const sequenceNum = await nextSequenceNumber(threadId);

  await db.insert(messages).values({
    threadId,
    sequenceNum,
    role: "user",
    content,
    externalMessageId: messageId,
  });

  return { inserted: true } as const;
}

async function enqueueInboundJob(threadId: number) {
  const [job] = await db
    .insert(jobs)
    .values({
      kind: "process_inbound_email",
      payload: { threadId },
    })
    .returning({ id: jobs.id });

  if (!job) {
    throw new Error("Failed to enqueue inbound email job.");
  }

  return job.id;
}

function hasPassingEmailAuthentication(inboundEmail: InboundEmail) {
  const senderDomain = inboundEmail.from.email.split("@").at(-1)?.toLowerCase();

  if (!senderDomain) {
    return false;
  }

  return inboundEmail.authenticationResults.some((result) =>
    DMARC_PASS_PATTERN.test(result) && dmarcHeaderFromMatchesSender(result, senderDomain),
  );
}

function dmarcHeaderFromMatchesSender(authenticationResult: string, senderDomain: string) {
  const headerFromDomain = DMARC_HEADER_FROM_PATTERN.exec(authenticationResult)?.[1]
    ?.trim()
    .toLowerCase()
    .replace(/[)>.,]+$/, "");

  return headerFromDomain === senderDomain;
}

const defaultDependencies: InboundEmailRouteDependencies = {
  emailProvider: resendEmailProvider,
  findUserByEmail,
  findOrCreateThread,
  persistInboundMessage,
  enqueueInboundJob,
  waitUntil(task) {
    waitUntil(task);
  },
  runJob,
};

export async function handleInboundEmail(
  req: Request,
  dependencies: InboundEmailRouteDependencies = defaultDependencies,
) {
  const isValid = await dependencies.emailProvider.verifyInboundSignature(req.clone());

  if (!isValid) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  const inboundEmail = await dependencies.emailProvider.parseInbound(req);
  const user = await dependencies.findUserByEmail(inboundEmail.from.email);
  const isAuthenticated = hasPassingEmailAuthentication(inboundEmail);

  if (!isAuthenticated) {
    return Response.json({ ok: false, error: "Sender authentication failed." }, { status: 403 });
  }

  if (!user) {
    return Response.json({ ok: false, error: "Unknown sender." }, { status: 403 });
  }

  const threadResolution = await dependencies.findOrCreateThread({
    userId: user.id,
    inboundEmail,
  });

  const persisted = await dependencies.persistInboundMessage(
    threadResolution.threadId,
    inboundEmail.text || inboundEmail.html || inboundEmail.subject,
    inboundEmail.messageId,
  );

  if (!persisted.inserted) {
    return Response.json({ ok: true, duplicate: true }, { status: 200 });
  }

  const jobId = await dependencies.enqueueInboundJob(threadResolution.threadId);

  dependencies.waitUntil(dependencies.runJob(jobId));

  return Response.json({ ok: true }, { status: 200 });
}
