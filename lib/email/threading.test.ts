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

const threadingModule = await import("./threading.ts");
const { determineEntryPoint, findOrCreateThreadWithStore } = threadingModule;
type ThreadingStore = import("./threading.ts").ThreadingStore;
type InboundEmail = import("./types.ts").InboundEmail;

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

test("determineEntryPoint uses the local-part of the recipient address", () => {
  assert.equal(
    determineEntryPoint([
      { email: "other@example.com" },
      { email: "invoice-gen@trimson.ai", name: "Invoice Bot" },
    ]),
    "invoice-gen",
  );
});

test("findOrCreateThreadWithStore resolves replies to an existing thread via references", async () => {
  const calls: Array<{ userId: number; messageIds: string[] }> = [];
  const store: ThreadingStore = {
    async findThreadByMessageIds(userId, messageIds) {
      calls.push({ userId, messageIds });
      return 42;
    },
    async createThread() {
      throw new Error("should not create thread");
    },
  };

  const result = await findOrCreateThreadWithStore(
    {
      userId: 7,
      inboundEmail: createInboundEmail({
        inReplyTo: "<root@local.test>",
        references: ["<root@local.test>", "<older@local.test>"],
      }),
    },
    store,
  );

  assert.deepEqual(calls, [
    {
      userId: 7,
      messageIds: ["<message@local.test>", "<root@local.test>", "<older@local.test>"],
    },
  ]);
  assert.deepEqual(result, {
    threadId: 42,
    created: false,
    entryPoint: "invoice-gen",
  });
});

test("findOrCreateThreadWithStore creates a new thread when no references match", async () => {
  const store: ThreadingStore = {
    async findThreadByMessageIds() {
      return null;
    },
    async createThread(input) {
      assert.deepEqual(input, {
        userId: 7,
        entryPoint: "invoice-gen",
        subject: "Need an invoice",
        externalRootId: "<message@local.test>",
      });

      return 99;
    },
  };

  const result = await findOrCreateThreadWithStore(
    {
      userId: 7,
      inboundEmail: createInboundEmail(),
    },
    store,
  );

  assert.deepEqual(result, {
    threadId: 99,
    created: true,
    entryPoint: "invoice-gen",
  });
});
