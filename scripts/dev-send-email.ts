import crypto from "node:crypto";

import { env } from "../lib/config/env.ts";

const defaultUrl = process.env.INBOUND_EMAIL_URL ?? "http://localhost:3000/api/inbound-email";

function signPayload(secret: string, messageId: string, timestamp: string, payload: string) {
  const secretValue = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(secretValue, "base64");
  const signedContent = `${messageId}.${timestamp}.${payload}`;
  const signature = crypto.createHmac("sha256", key).update(signedContent).digest("base64");

  return `v1,${signature}`;
}

async function main() {
  const now = new Date().toISOString();
  const webhookMessageId = `msg_${Date.now()}`;
  const messageId = process.env.MESSAGE_ID ?? `<dev-${Date.now()}@local.test>`;
  const from = process.env.FROM_EMAIL ?? env.OWNER_EMAIL;
  const to = process.env.TO_EMAIL ?? env.EMAIL_FROM_ADDRESS;
  const subject = process.env.SUBJECT ?? "Local webhook test";

  const payload = JSON.stringify({
    type: "email.received",
    created_at: now,
    data: {
      email_id: process.env.PROVIDER_EMAIL_ID ?? `email_${Date.now()}`,
      created_at: now,
      from,
      to: [to],
      bcc: [],
      cc: [],
      message_id: messageId,
      subject,
      text: process.env.BODY_TEXT ?? "Please create an invoice draft for Fable Co.",
      html:
        process.env.BODY_HTML ??
        "<p>Please create an invoice draft for <strong>Fable Co.</strong>.</p>",
      headers: {
        "Message-ID": messageId,
      },
      attachments: [],
    },
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(env.RESEND_WEBHOOK_SECRET, webhookMessageId, timestamp, payload);

  const response = await fetch(defaultUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": webhookMessageId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body: payload,
  });

  const text = await response.text();

  console.log(
    JSON.stringify(
      {
        url: defaultUrl,
        status: response.status,
        messageId,
        webhookMessageId,
        responseBody: text,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to send local inbound email webhook.");
  console.error(error);
  process.exit(1);
});
