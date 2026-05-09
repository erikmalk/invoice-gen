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

const resendModule = await import("./resend.ts");
const {
  ResendEmailProvider,
  formatEmailAddress,
} = resendModule;
type ResendClientLike = import("./resend.ts").ResendClientLike;
type ResendInboundWebhookPayload = import("./resend.ts").ResendInboundWebhookPayload;

function createProvider(event: ResendInboundWebhookPayload, overrides: Partial<ResendClientLike> = {}) {
  const sentPayloads: Record<string, unknown>[] = [];
  const receivingCalls: string[] = [];

  const client: ResendClientLike = {
    emails: {
      async send(payload) {
        sentPayloads.push(payload as Record<string, unknown>);
        return { data: { id: "outbound_123" }, error: null };
      },
      receiving: {
        async get(id) {
          receivingCalls.push(id);
          return {
            data: {
              object: "email",
              id,
              to: ["invoice-gen@trimson.ai"],
              from: "Owner <owner@example.com>",
              created_at: event.created_at,
              subject: "Need an invoice",
              bcc: [],
              cc: [],
              reply_to: null,
              html: "<p>Hello</p>",
              text: "Hello",
              headers: {
                "Message-ID": event.data.message_id,
                "In-Reply-To": "<root@local.test>",
                References: "<root@local.test> <prior@local.test>",
              },
              message_id: event.data.message_id,
              attachments: [
                {
                  id: "attachment_1",
                  filename: "invoice.pdf",
                  size: 123,
                  content_type: "application/pdf",
                  content_id: null,
                  content_disposition: "attachment",
                },
              ],
            },
            error: null,
          };
        },
      },
    },
    webhooks: {
      verify() {
        return event;
      },
    },
    ...overrides,
  } as ResendClientLike;

  return {
    provider: new ResendEmailProvider({
      client,
      webhookSecret: "whsec_dGVzdF9zZWNyZXQ=",
      defaultFromAddress: "bot@example.com",
      defaultFromName: "Invoice Bot",
    }),
    sentPayloads,
    receivingCalls,
  };
}

function createRequest() {
  return new Request("http://localhost/api/inbound-email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_123",
      "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
      "svix-signature": "v1,test",
    },
    body: JSON.stringify({ ok: true }),
  });
}

test("parseInbound normalizes verified inbound webhook payloads with inline content", async () => {
  const event: ResendInboundWebhookPayload = {
    type: "email.received",
    created_at: "2025-05-01T12:00:00.000Z",
    data: {
      email_id: "email_123",
      from: "Owner <owner@example.com>",
      to: ["Invoice Bot <invoice-gen@trimson.ai>"],
      cc: [],
      bcc: [],
      message_id: "inline@local.test",
      subject: "Need an invoice",
      text: "Please invoice Fable Co.",
      html: "<p>Please invoice Fable Co.</p>",
      headers: {
        "Message-ID": "<inline@local.test>",
        "In-Reply-To": "<root@local.test>",
        References: "<root@local.test> <prior@local.test>",
      },
      attachments: [
        {
          filename: "brief.txt",
          size: 42,
          content_type: "text/plain",
          content_disposition: "attachment",
        },
      ],
    },
  };

  const { provider, receivingCalls } = createProvider(event);
  const inbound = await provider.parseInbound(createRequest());

  assert.deepEqual(inbound.from, { email: "owner@example.com", name: "Owner" });
  assert.deepEqual(inbound.to, [{ email: "invoice-gen@trimson.ai", name: "Invoice Bot" }]);
  assert.equal(inbound.subject, "Need an invoice");
  assert.equal(inbound.text, "Please invoice Fable Co.");
  assert.equal(inbound.html, "<p>Please invoice Fable Co.</p>");
  assert.equal(inbound.messageId, "<inline@local.test>");
  assert.equal(inbound.inReplyTo, "<root@local.test>");
  assert.deepEqual(inbound.references, ["<root@local.test>", "<prior@local.test>"]);
  assert.deepEqual(inbound.attachments, [
    {
      id: "email_123:brief.txt",
      filename: "brief.txt",
      contentType: "text/plain",
      size: 42,
      contentId: null,
      contentDisposition: "attachment",
    },
  ]);
  assert.deepEqual(receivingCalls, []);
});

test("verifyInboundSignature returns false when webhook verification throws", async () => {
  const { provider } = createProvider(
    {
      type: "email.received",
      created_at: "2025-05-01T12:00:00.000Z",
      data: {
        email_id: "email_123",
        from: "owner@example.com",
        to: ["invoice-gen@trimson.ai"],
        cc: [],
        bcc: [],
        message_id: "<inline@local.test>",
        subject: "Need an invoice",
      },
    },
    {
      webhooks: {
        verify() {
          throw new Error("bad signature");
        },
      },
    },
  );

  assert.equal(await provider.verifyInboundSignature(createRequest()), false);
});

test("parseInbound falls back to inline webhook content when receiving.get fails", async () => {
  const event: ResendInboundWebhookPayload = {
    type: "email.received",
    created_at: "2025-05-01T12:00:00.000Z",
    data: {
      email_id: "email_456",
      from: "Owner <owner@example.com>",
      to: ["Invoice Bot <invoice-gen@trimson.ai>"],
      cc: [],
      bcc: [],
      message_id: "inline-fallback@local.test",
      subject: "Fallback invoice request",
      text: "Fallback text body",
      html: "<p>Fallback text body</p>",
      headers: {
        "Message-ID": "<inline-fallback@local.test>",
      },
    },
  };

  const { provider, receivingCalls } = createProvider(event, {
    emails: {
      async send(payload) {
        return { data: { id: "outbound_123" }, error: null };
      },
      receiving: {
        async get() {
          return {
            data: null,
            error: { message: "This API key is restricted to only send emails" },
          };
        },
      },
    },
  });

  const inbound = await provider.parseInbound(createRequest());

  assert.equal(inbound.subject, "Fallback invoice request");
  assert.equal(inbound.text, "Fallback text body");
  assert.equal(inbound.messageId, "<inline-fallback@local.test>");
  assert.deepEqual(receivingCalls, []);
});

test("send adds threading headers when replying to an existing email thread", async () => {
  const event: ResendInboundWebhookPayload = {
    type: "email.received",
    created_at: "2025-05-01T12:00:00.000Z",
    data: {
      email_id: "email_123",
      from: "owner@example.com",
      to: ["invoice-gen@trimson.ai"],
      cc: [],
      bcc: [],
      message_id: "<inline@local.test>",
      subject: "Need an invoice",
    },
  };

  const { provider, sentPayloads } = createProvider(event);
  const result = await provider.send({
    to: [{ email: "owner@example.com", name: "Owner" }],
    subject: "Draft ready",
    text: "Attached is your draft.",
    thread: {
      messageId: "<root@local.test>",
      inReplyTo: "<root@local.test>",
      references: ["<older@local.test>"],
    },
  });

  assert.equal(result.messageId, "outbound_123");
  assert.deepEqual(sentPayloads[0], {
    from: formatEmailAddress({ email: "bot@example.com", name: "Invoice Bot" }),
    to: [formatEmailAddress({ email: "owner@example.com", name: "Owner" })],
    cc: undefined,
    bcc: undefined,
    reply_to: undefined,
    subject: "Draft ready",
    text: "Attached is your draft.",
    html: undefined,
    attachments: undefined,
    headers: {
      "In-Reply-To": "<root@local.test>",
      References: "<older@local.test> <root@local.test>",
    },
  });
});
