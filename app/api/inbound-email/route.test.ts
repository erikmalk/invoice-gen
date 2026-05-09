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

const routeModule = await import("./route.ts");
const { handleInboundEmail } = routeModule;
type InboundEmailRouteDependencies = import("./route.ts").InboundEmailRouteDependencies;
type InboundEmail = import("../../../lib/email/types.ts").InboundEmail;

type TestRouteDependencies = InboundEmailRouteDependencies & {
  waitUntilCalls: Promise<unknown>[];
};

function createInboundEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    from: { email: "owner@example.com", name: "Owner" },
    to: [{ email: "invoice-gen@trimson.ai", name: "Invoice Bot" }],
    cc: [],
    bcc: [],
    subject: "Need an invoice",
    text: "Please invoice Fable Co.",
    html: "<p>Please invoice Fable Co.</p>",
    messageId: "<message@local.test>",
    inReplyTo: null,
    references: [],
    attachments: [],
    ...overrides,
  };
}

function createDependencies(overrides: Partial<InboundEmailRouteDependencies> = {}): TestRouteDependencies {
  const waitUntilCalls: Promise<unknown>[] = [];

  const dependencies: InboundEmailRouteDependencies = {
    emailProvider: {
      async verifyInboundSignature() {
        return true;
      },
      async parseInbound() {
        return createInboundEmail();
      },
      async send() {
        return { messageId: "bounce_123" };
      },
    },
    async findUserByEmail(email) {
      return { id: 1, email };
    },
    async findOrCreateThread() {
      return { threadId: 10, created: true, entryPoint: "invoice-gen" };
    },
    async persistInboundMessage() {
      return { inserted: true };
    },
    async enqueueInboundJob() {
      return 77;
    },
    waitUntil(task) {
      waitUntilCalls.push(task);
    },
    async runJob() {
      return undefined;
    },
    ...overrides,
  };

  Object.assign(dependencies, { waitUntilCalls });

  return dependencies as TestRouteDependencies;
}

test("handleInboundEmail returns 401 for an invalid signature", async () => {
  const dependencies = createDependencies({
    emailProvider: {
      async verifyInboundSignature() {
        return false;
      },
      async parseInbound() {
        throw new Error("should not parse inbound");
      },
      async send() {
        return { messageId: "bounce_123" };
      },
    },
  });

  const response = await handleInboundEmail(new Request("http://localhost/api/inbound-email", { method: "POST" }), dependencies);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid signature." });
  assert.equal(dependencies.waitUntilCalls.length, 0);
});

test("handleInboundEmail persists, enqueues, and schedules a valid owner email", async () => {
  const callOrder: string[] = [];
  const dependencies = createDependencies({
    async findUserByEmail(email) {
      callOrder.push(`user:${email}`);
      return { id: 1, email };
    },
    async findOrCreateThread({ userId, inboundEmail }) {
      callOrder.push(`thread:${userId}:${inboundEmail.messageId}`);
      return { threadId: 22, created: true, entryPoint: "invoice-gen" };
    },
    async persistInboundMessage(threadId, content, messageId) {
      callOrder.push(`message:${threadId}:${messageId}:${content}`);
      return { inserted: true };
    },
    async enqueueInboundJob(threadId) {
      callOrder.push(`job:${threadId}`);
      return 91;
    },
    async runJob(jobId) {
      callOrder.push(`run:${jobId}`);
      return undefined;
    },
  });

  const started = performance.now();
  const response = await handleInboundEmail(
    new Request("http://localhost/api/inbound-email", { method: "POST" }),
    dependencies,
  );
  const elapsedMs = performance.now() - started;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(elapsedMs < 500, `Expected route to complete in under 500ms, got ${elapsedMs}`);
  assert.deepEqual(callOrder, [
    "user:owner@example.com",
    "thread:1:<message@local.test>",
    "message:22:<message@local.test>:Please invoice Fable Co.",
    "job:22",
    "run:91",
  ]);
  assert.equal(dependencies.waitUntilCalls.length, 1);
  await Promise.all(dependencies.waitUntilCalls);
});

test("handleInboundEmail treats duplicate Message-ID deliveries as a no-op for messages", async () => {
  const dependencies = createDependencies({
    async persistInboundMessage() {
      return { inserted: false };
    },
    async enqueueInboundJob() {
      throw new Error("should not enqueue duplicate jobs");
    },
  });

  const response = await handleInboundEmail(
    new Request("http://localhost/api/inbound-email", { method: "POST" }),
    dependencies,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true });
  assert.equal(dependencies.waitUntilCalls.length, 0);
});

test("handleInboundEmail rejects unknown senders and schedules a polite bounce", async () => {
  const bounceRecipients: string[] = [];
  const dependencies = createDependencies({
    emailProvider: {
      async verifyInboundSignature() {
        return true;
      },
      async parseInbound() {
        return createInboundEmail({ from: { email: "intruder@example.com" } });
      },
      async send(message) {
        bounceRecipients.push(message.to[0]?.email ?? "");
        return { messageId: "bounce_123" };
      },
    },
    async findUserByEmail() {
      return null;
    },
  });

  const response = await handleInboundEmail(
    new Request("http://localhost/api/inbound-email", { method: "POST" }),
    dependencies,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "Unknown sender." });
  assert.equal(dependencies.waitUntilCalls.length, 1);
  await Promise.all(dependencies.waitUntilCalls);
  assert.deepEqual(bounceRecipients, ["intruder@example.com"]);
});
