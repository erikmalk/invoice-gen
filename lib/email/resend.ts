import { Resend } from "resend";

import { env } from "../config/env.ts";
import type {
  EmailProvider,
  InboundEmail,
  NormalizedEmailAddress,
  NormalizedEmailAttachment,
  OutboundEmail,
} from "./types.ts";

const HEADER_MESSAGE_ID = "message-id";
const HEADER_IN_REPLY_TO = "in-reply-to";
const HEADER_REFERENCES = "references";
const HEADER_AUTHENTICATION_RESULTS = "authentication-results";

type ResendResponse<T> =
  | { data: T; error: null }
  | { data: null; error: { message: string } };

export interface ResendClientLike {
  emails: {
    send(payload: unknown): Promise<ResendResponse<{ id: string }>>;
    receiving: {
      get(id: string): Promise<
        ResendResponse<{
          object: "email";
          id: string;
          to: string[];
          from: string;
          created_at: string;
          subject: string;
          bcc: string[] | null;
          cc: string[] | null;
          reply_to: string[] | null;
          html: string | null;
          text: string | null;
          headers: Record<string, string> | null;
          message_id: string;
          attachments: Array<{
            id: string;
            filename: string | null;
            size: number;
            content_type: string;
            content_id: string | null;
            content_disposition: string | null;
          }>;
        }>
      >;
    };
  };
  webhooks: {
    verify(payload: {
      payload: string;
      headers: {
        id: string;
        timestamp: string;
        signature: string;
      };
      webhookSecret: string;
    }): unknown;
  };
}

export interface ResendInboundWebhookPayload {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    created_at?: string;
    from: string;
    to: string[];
    bcc?: string[];
    cc?: string[];
    message_id: string;
    subject: string;
    attachments?: Array<{
      id?: string;
      filename?: string | null;
      size?: number | null;
      content_type?: string | null;
      content_id?: string | null;
      content_disposition?: string | null;
    }>;
    text?: string | null;
    html?: string | null;
    headers?: Record<string, string> | null;
    in_reply_to?: string | null;
    references?: string[] | null;
  };
}

const resend = new Resend(env.RESEND_API_KEY);

function unwrapResendResponse<T>(
  response: ResendResponse<T>,
): T {
  if (response.error) {
    throw new Error(response.error.message);
  }

  return response.data;
}

function normalizeHeaderLookup(headers: Record<string, string> | null | undefined, name: string) {
  if (!headers) {
    return null;
  }

  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return null;
}

function parseAddressList(input: string | string[] | null | undefined): NormalizedEmailAddress[] {
  const values = Array.isArray(input) ? input : input ? [input] : [];

  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(parseEmailAddress);
}

function parseEmailAddress(input: string): NormalizedEmailAddress {
  const match = input.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);

  if (match?.[2]) {
    const [, rawName, rawEmail] = match;
    const name = rawName?.trim().replace(/^"|"$/g, "") || undefined;

    return {
      email: rawEmail.trim().toLowerCase(),
      name,
    };
  }

  return {
    email: input.trim().toLowerCase(),
  };
}

function formatEmailAddress(address: NormalizedEmailAddress) {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function parseMessageIdList(value: string | null | undefined) {
  if (!value) {
    return [];
  }

  return Array.from(value.matchAll(/<[^>]+>/g), (match) => match[0]);
}

function collectHeaderValues(headers: Record<string, string> | null | undefined, name: string) {
  if (!headers) {
    return [];
  }

  const target = name.toLowerCase();

  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === target)
    .map(([, value]) => value)
    .filter(Boolean);
}

function normalizeMessageId(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const first = parseMessageIdList(trimmed)[0];

  if (first) {
    return first;
  }

  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed}>`;
}

function normalizeInboundAttachment(
  attachment: {
    id: string;
    filename: string | null;
    content_type: string;
    size: number;
    content_id?: string | null;
    content_disposition?: string | null;
  },
): NormalizedEmailAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type ?? null,
    size: attachment.size ?? null,
    contentId: attachment.content_id ?? null,
    contentDisposition: attachment.content_disposition ?? null,
  };
}

function hasInlineEmailContent(event: ResendInboundWebhookPayload) {
  return Boolean(
    event.data.text !== undefined ||
      event.data.html !== undefined ||
      event.data.headers !== undefined ||
      event.data.in_reply_to !== undefined ||
      event.data.references !== undefined,
  );
}

async function readReceivingEmail(
  client: ResendClientLike,
  emailId: string,
) {
  try {
    return unwrapResendResponse(await client.emails.receiving.get(emailId));
  } catch (error) {
    console.warn(
      `Falling back to inline Resend webhook payload because receiving.get failed for ${emailId}.`,
      error,
    );
    return null;
  }
}

function normalizeReferences(
  headerValue: string | null | undefined,
  fallbackValues: string[] | null | undefined,
) {
  const headerReferences = parseMessageIdList(headerValue);

  if (headerReferences.length > 0) {
    return headerReferences;
  }

  return (fallbackValues ?? [])
    .map((value) => normalizeMessageId(value))
    .filter((value): value is string => Boolean(value));
}

export interface ResendEmailProviderOptions {
  client?: ResendClientLike;
  webhookSecret?: string;
  defaultFromAddress?: string;
  defaultFromName?: string;
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: ResendClientLike;

  private readonly webhookSecret: string;

  private readonly defaultFromAddress: string;

  private readonly defaultFromName: string;

  constructor(options: ResendEmailProviderOptions = {}) {
    this.client = options.client ?? resend;
    this.webhookSecret = options.webhookSecret ?? env.RESEND_WEBHOOK_SECRET;
    this.defaultFromAddress = options.defaultFromAddress ?? env.EMAIL_FROM_ADDRESS;
    this.defaultFromName = options.defaultFromName ?? env.EMAIL_FROM_NAME;
  }

  async send(msg: OutboundEmail): Promise<{ messageId: string }> {
    const references = Array.from(
      new Set(
        [...(msg.thread?.references ?? []), ...(msg.thread?.messageId ? [msg.thread.messageId] : [])]
          .map((value) => normalizeMessageId(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const data = unwrapResendResponse(
      await this.client.emails.send({
        from: formatEmailAddress(msg.from ?? { email: this.defaultFromAddress, name: this.defaultFromName }),
        to: msg.to.map(formatEmailAddress),
        cc: msg.cc?.map(formatEmailAddress),
        bcc: msg.bcc?.map(formatEmailAddress),
        reply_to: msg.replyTo?.map(formatEmailAddress),
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: msg.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          path: attachment.path,
          contentType: attachment.contentType,
          contentId: attachment.contentId,
        })),
        headers: {
          ...(msg.thread?.inReplyTo
            ? { "In-Reply-To": normalizeMessageId(msg.thread.inReplyTo) ?? msg.thread.inReplyTo }
            : {}),
          ...(references.length > 0 ? { References: references.join(" ") } : {}),
        },
      }),
    );

    return {
      messageId: data.id,
    };
  }

  async verifyInboundSignature(req: Request): Promise<boolean> {
    try {
      await this.readVerifiedInboundEvent(req.clone());
      return true;
    } catch {
      return false;
    }
  }

  async parseInbound(req: Request): Promise<InboundEmail> {
    const event = await this.readVerifiedInboundEvent(req);
    const receivingEmail = hasInlineEmailContent(event)
      ? null
      : await readReceivingEmail(this.client, event.data.email_id);
    const headers = receivingEmail?.headers ?? event.data.headers ?? null;

    return {
      from: parseEmailAddress(receivingEmail?.from ?? event.data.from),
      to: parseAddressList(receivingEmail?.to ?? event.data.to),
      cc: parseAddressList(receivingEmail?.cc ?? event.data.cc),
      bcc: parseAddressList(receivingEmail?.bcc ?? event.data.bcc),
      authenticationResults: collectHeaderValues(headers, HEADER_AUTHENTICATION_RESULTS),
      subject: receivingEmail?.subject ?? event.data.subject ?? "",
      text: receivingEmail?.text ?? event.data.text ?? "",
      html: receivingEmail?.html ?? event.data.html ?? "",
      messageId:
        normalizeMessageId(
          receivingEmail?.message_id ??
            normalizeHeaderLookup(headers, HEADER_MESSAGE_ID) ??
            event.data.message_id,
        ) ??
        (() => {
          throw new Error("Inbound email is missing a Message-ID.");
        })(),
      inReplyTo:
        normalizeMessageId(
          normalizeHeaderLookup(headers, HEADER_IN_REPLY_TO) ?? event.data.in_reply_to,
        ) ?? null,
      references: normalizeReferences(
        normalizeHeaderLookup(headers, HEADER_REFERENCES),
        event.data.references,
      ),
      attachments: (receivingEmail?.attachments ?? event.data.attachments ?? []).map((attachment) =>
        normalizeInboundAttachment({
          id: attachment.id ?? `${event.data.email_id}:${attachment.filename ?? "attachment"}`,
          filename: attachment.filename ?? null,
          content_type: attachment.content_type ?? "application/octet-stream",
          size: attachment.size ?? 0,
          content_id: attachment.content_id ?? null,
          content_disposition: attachment.content_disposition ?? null,
        }),
      ),
      receivedAt: receivingEmail?.created_at ?? event.data.created_at ?? event.created_at,
      providerMessageId: event.data.email_id,
    };
  }

  private async readVerifiedInboundEvent(req: Request): Promise<ResendInboundWebhookPayload> {
    const payload = await req.text();

    const verifiedPayload = this.client.webhooks.verify({
      payload,
      headers: {
        id: req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? "",
        timestamp:
          req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp") ?? "",
        signature:
          req.headers.get("svix-signature") ?? req.headers.get("webhook-signature") ?? "",
      },
      webhookSecret: this.webhookSecret,
    }) as ResendInboundWebhookPayload;

    if (verifiedPayload.type !== "email.received") {
      throw new Error(`Unsupported Resend webhook event: ${verifiedPayload.type}`);
    }

    return verifiedPayload;
  }
}

export const resendEmailProvider = new ResendEmailProvider();

export {
  formatEmailAddress,
  normalizeHeaderLookup,
  normalizeMessageId,
  parseAddressList,
  parseEmailAddress,
  parseMessageIdList,
};
