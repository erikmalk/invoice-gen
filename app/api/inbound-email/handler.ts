import { waitUntil } from "@vercel/functions";
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "../../../lib/db/client.ts";
import { jobs, messages, threads, users } from "../../../lib/db/schema.ts";
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
const ACCEPTED_INBOUND_RATE_LIMIT = 30;
const ACCEPTED_INBOUND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RESEND_WEBHOOK_IPV4_ALLOWLIST = new Set([
  "44.228.126.217",
  "50.112.21.217",
  "52.24.126.164",
  "54.148.139.208",
]);
const RESEND_WEBHOOK_IPV6_CIDR = {
  network: parseIpv6ToBigInt("2600:1f24:64:8000::"),
  prefixLength: 52,
};

export interface InboundEmailRouteDependencies {
  emailProvider: Pick<ResendEmailProvider, "verifyInboundSignature" | "parseInbound">;
  findUserByEmail(email: string): Promise<{ id: number; email: string } | null>;
  countRecentAcceptedInboundMessages(userId: number, since: Date): Promise<number>;
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

async function countRecentAcceptedInboundMessages(userId: number, since: Date) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.userId, userId),
        eq(messages.role, "user"),
        gte(messages.createdAt, since),
      ),
    );

  return row?.count ?? 0;
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

function isAllowedWebhookSource(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");

  if (!forwardedFor) {
    return true;
  }

  const clientIp = forwardedFor.split(",")[0]?.trim().replace(/^::ffff:/i, "");

  if (!clientIp) {
    return false;
  }

  if (RESEND_WEBHOOK_IPV4_ALLOWLIST.has(clientIp)) {
    return true;
  }

  if (!clientIp.includes(":")) {
    return false;
  }

  const ipv6 = parseIpv6ToBigInt(clientIp);

  if (ipv6 === null) {
    return false;
  }

  return ipv6MatchesCidr(ipv6, RESEND_WEBHOOK_IPV6_CIDR.network, RESEND_WEBHOOK_IPV6_CIDR.prefixLength);
}

function parseIpv6ToBigInt(input: string) {
  const address = input.toLowerCase().split("%")[0] ?? "";
  const parts = address.split("::");

  if (parts.length > 2) {
    return null;
  }

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  const missingGroups = 8 - head.length - tail.length;

  if (missingGroups < 0 || (parts.length === 1 && missingGroups !== 0)) {
    return null;
  }

  const groups = [...head, ...Array<string>(missingGroups).fill("0"), ...tail];

  if (groups.length !== 8) {
    return null;
  }

  let value = BigInt(0);

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }

    value = (value << BigInt(16)) + BigInt(`0x${group}`);
  }

  return value;
}

function ipv6MatchesCidr(ip: bigint, network: bigint | null, prefixLength: number) {
  if (network === null) {
    return false;
  }

  const hostBits = BigInt(128 - prefixLength);
  const allBits = (BigInt(1) << BigInt(128)) - BigInt(1);
  const hostMask = (BigInt(1) << hostBits) - BigInt(1);
  const mask = allBits ^ hostMask;

  return (ip & mask) === (network & mask);
}

const defaultDependencies: InboundEmailRouteDependencies = {
  emailProvider: resendEmailProvider,
  findUserByEmail,
  countRecentAcceptedInboundMessages,
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
  if (!isAllowedWebhookSource(req)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const isValid = await dependencies.emailProvider.verifyInboundSignature(req.clone());

  if (!isValid) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  const inboundEmail = await dependencies.emailProvider.parseInbound(req);
  const isAuthenticated = hasPassingEmailAuthentication(inboundEmail);

  if (!isAuthenticated) {
    return Response.json({ ok: true, ignored: true, reason: "sender_authentication_failed" }, { status: 200 });
  }

  const user = await dependencies.findUserByEmail(inboundEmail.from.email);

  if (!user) {
    return Response.json({ ok: true, ignored: true, reason: "unknown_sender" }, { status: 200 });
  }

  const rateLimitSince = new Date(Date.now() - ACCEPTED_INBOUND_RATE_LIMIT_WINDOW_MS);
  const recentAcceptedCount = await dependencies.countRecentAcceptedInboundMessages(user.id, rateLimitSince);

  if (recentAcceptedCount >= ACCEPTED_INBOUND_RATE_LIMIT) {
    return Response.json({ ok: true, ignored: true, reason: "rate_limited" }, { status: 200 });
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
