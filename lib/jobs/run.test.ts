import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/invoice_gen";
process.env.DATABASE_URL_UNPOOLED ??= "postgresql://user:pass@localhost:5432/invoice_gen";
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.RESEND_API_KEY ??= "test-resend-key";
process.env.RESEND_WEBHOOK_SECRET ??= "whsec_dGVzdF9zZWNyZXQ=";
process.env.EMAIL_FROM_ADDRESS ??= "bot@example.com";
process.env.EMAIL_FROM_NAME ??= "Invoice Bot";
process.env.CRON_SECRET ??= "cron-secret";
process.env.OWNER_EMAIL ??= "owner@example.com";

const { runJob } = await import("./run.ts");
type JobRunnerStore = import("./run.ts").JobRunnerStore;
type AppDb = import("../tools/types.ts").AppDb;

test("runJob dispatches process_inbound_email and updates status", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const store: JobRunnerStore = {
    async findJob(jobId) {
      return {
        id: jobId,
        kind: "process_inbound_email",
        payload: { threadId: 123 },
        attempts: 0,
      };
    },
    async updateJob(_jobId, values) {
      updates.push(values);
    },
  };
  const dispatched: Array<{ threadId: number; jobId: number }> = [];

  const result = await runJob(77, {
    db: {} as AppDb,
    store,
    async runAgentLoop(threadId, options) {
      dispatched.push({ threadId, jobId: options.jobId });
    },
  });

  assert.deepEqual(result, { ok: true, jobId: 77 });
  assert.deepEqual(dispatched, [{ threadId: 123, jobId: 77 }]);
  assert.equal(updates[0]?.status, "running");
  assert.equal(updates[0]?.attempts, 1);
  assert.equal(updates[1]?.status, "done");
  assert.equal(updates[1]?.lastError, null);
});

test("runJob marks failed when dispatch throws", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const store: JobRunnerStore = {
    async findJob(jobId) {
      return {
        id: jobId,
        kind: "resume_agent_thread",
        payload: { threadId: 456 },
        attempts: 2,
      };
    },
    async updateJob(_jobId, values) {
      updates.push(values);
    },
  };

  const result = await runJob(88, {
    db: {} as AppDb,
    store,
    async runAgentLoop() {
      throw new Error("boom");
    },
  });

  assert.deepEqual(result, { ok: false, jobId: 88, error: "boom" });
  assert.equal(updates[0]?.status, "running");
  assert.equal(updates[0]?.attempts, 3);
  assert.equal(updates[1]?.status, "failed");
  assert.equal(updates[1]?.lastError, "boom");
});
