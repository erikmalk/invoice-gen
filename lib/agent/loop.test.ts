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

const { buildLLMMessages, runAgentLoop } = await import("./loop.ts");
const { FakeLLMClient } = await import("../llm/fake.ts");
type AgentStore = import("./loop.ts").AgentStore;
type ThreadContext = import("./loop.ts").ThreadContext;
type PersonaConfig = import("./types.ts").PersonaConfig;
type Tool = import("../tools/types.ts").Tool;
type AppDb = import("../tools/types.ts").AppDb;

function createThreadContext(): ThreadContext {
  return {
    thread: {
      id: 42,
      userId: 1,
      entryPoint: "invoice-gen",
      subject: "Invoice Fable for wig fitting",
      externalRootId: "<root@example.com>",
      status: "active",
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 1,
      email: "owner@example.com",
      name: "Owner",
      companyName: "Owner Co",
      companyAddress: null,
      companyPhone: null,
      taxId: null,
      defaultDueDays: 14,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    messages: [
      {
        id: 10,
        threadId: 42,
        sequenceNum: 1,
        role: "user",
        content: "Please bill $200 plus a $25 kit fee.",
        externalMessageId: "<msg@example.com>",
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        tokenUsage: null,
        model: null,
        createdAt: new Date(),
      },
    ],
  };
}

const persona: PersonaConfig = {
  entryPoint: "invoice-gen",
  name: "Invoice Generator",
  systemPrompt: "test system prompt for {{user_profile}}",
  toolNames: ["terminal_tool"],
  model: "fake-model",
  maxSteps: 5,
  maxWallClockSeconds: 60,
};

test("agent context includes both thread subject and message body", () => {
  const messages = buildLLMMessages(createThreadContext(), "system prompt");
  const userMessage = messages.find((message) => message.role === "user");

  assert.ok(userMessage?.content?.includes("Subject: Invoice Fable for wig fitting"));
  assert.ok(userMessage?.content?.includes("Body:\nPlease bill $200 plus a $25 kit fee."));
});

test("agent context replays persisted tool messages without inline PDF data", () => {
  const context = createThreadContext();
  context.messages.push({
    id: 11,
    threadId: 42,
    sequenceNum: 2,
    role: "tool",
    content: JSON.stringify({
      ok: true,
      data: {
        invoice: {
          id: 123,
          invoiceNumber: "2026-0001",
          pdfAvailable: true,
        },
      },
    }),
    externalMessageId: null,
    toolCalls: null,
    toolCallId: "call_1",
    toolName: "manage_invoice",
    tokenUsage: null,
    model: null,
    createdAt: new Date(),
  });

  const messages = buildLLMMessages(context, "system prompt");
  const serialized = JSON.stringify(messages);

  assert.ok(!serialized.includes("inline-pdf:"));
  assert.ok(!serialized.includes("pdfBlobKey"));
  assert.ok(!serialized.includes("pdfUrl"));
  assert.ok(serialized.includes("pdfAvailable"));
});

test("terminal tool execution stops the loop without another LLM call", async () => {
  const context = createThreadContext();
  const persistedRoles: string[] = [];
  const statuses: string[] = [];
  const store: AgentStore = {
    async loadThreadContext() {
      return context;
    },
    async persistAssistantMessage() {
      persistedRoles.push("assistant");
    },
    async persistToolMessage() {
      persistedRoles.push("tool");
    },
    async setThreadStatus(_threadId, status) {
      statuses.push(status);
    },
  };
  const terminalTool: Tool = {
    name: "terminal_tool",
    description: "Stops the loop.",
    terminal: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return { ok: true, terminal: true, data: { stopped: true } };
    },
  };
  const llm = new FakeLLMClient([
    {
      model: "fake-model",
      message: {
        role: "assistant",
        toolCalls: [{ id: "call_1", name: "terminal_tool", arguments: {} }],
      },
    },
  ]);

  const result = await runAgentLoop(42, {
    db: {} as AppDb,
    store,
    persona,
    tools: [terminalTool],
    llmClient: llm,
    emailProvider: { async send() { return { messageId: "unused" }; } },
    async loadSystemPrompt() {
      return "system prompt";
    },
  });

  assert.equal(result.status, "terminal");
  assert.equal(result.terminalToolName, "terminal_tool");
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(persistedRoles, ["assistant", "tool"]);
  assert.deepEqual(statuses, []);
});
