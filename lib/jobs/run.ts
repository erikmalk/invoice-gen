import { eq } from "drizzle-orm";

import { runAgentLoop } from "../agent/loop.ts";
import { db as defaultDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import type { AppDb } from "../tools/types.ts";

export interface RunJobDependencies {
  db?: AppDb;
  store?: JobRunnerStore;
  runAgentLoop?: (threadId: number, options: { jobId: number; db: AppDb }) => Promise<unknown>;
}

export interface JobRunnerStore {
  findJob(jobId: number): Promise<{
    id: number;
    kind: string;
    payload: unknown;
    attempts: number;
  } | null>;
  updateJob(jobId: number, values: Record<string, unknown>): Promise<void>;
}

export type RunJobResult =
  | { ok: true; jobId: number }
  | { ok: false; jobId: number; error: string };

export async function runJob(
  jobId: number,
  dependencies: RunJobDependencies = {},
): Promise<RunJobResult> {
  const database = dependencies.db ?? defaultDb;
  const store = dependencies.store ?? createDrizzleJobStore(database);
  const dispatchAgentLoop = dependencies.runAgentLoop ?? defaultRunAgentLoop;
  const job = await store.findJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }

  const attempts = job.attempts + 1;
  const startedAt = new Date();

  await store.updateJob(jobId, {
    status: "running",
    attempts,
    startedAt,
    finishedAt: null,
    updatedAt: startedAt,
    lastError: null,
  });

  try {
    await dispatchJob(job.kind, job.payload, jobId, database, dispatchAgentLoop);

    const finishedAt = new Date();
    await store.updateJob(jobId, {
      status: "done",
      finishedAt,
      updatedAt: finishedAt,
      lastError: null,
    });

    return { ok: true, jobId };
  } catch (error) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);

    await store.updateJob(jobId, {
      status: "failed",
      lastError: message,
      finishedAt,
      updatedAt: finishedAt,
    });

    return { ok: false, jobId, error: message };
  }
}

async function dispatchJob(
  kind: string,
  payload: unknown,
  jobId: number,
  database: AppDb,
  runAgent: (threadId: number, options: { jobId: number; db: AppDb }) => Promise<unknown>,
) {
  switch (kind) {
    case "process_inbound_email":
    case "resume_agent_thread":
      await runAgent(readThreadId(payload), { jobId, db: database });
      return;
    default:
      throw new Error(`Unsupported job kind: ${kind}`);
  }
}

function readThreadId(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "threadId" in payload &&
    typeof payload.threadId === "number"
  ) {
    return payload.threadId;
  }

  throw new Error("Agent job payload must contain numeric threadId.");
}

function defaultRunAgentLoop(threadId: number, options: { jobId: number; db: AppDb }) {
  return runAgentLoop(threadId, { jobId: options.jobId, db: options.db });
}

function createDrizzleJobStore(database: AppDb): JobRunnerStore {
  return {
    async findJob(jobId) {
      const [job] = await database.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

      return job ?? null;
    },
    async updateJob(jobId, values) {
      await database.update(jobs).set(values).where(eq(jobs.id, jobId));
    },
  };
}
