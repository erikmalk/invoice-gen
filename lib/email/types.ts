export interface NormalizedEmailAddress {
  email: string;
  name?: string;
}

export interface NormalizedEmailAttachment {
  id?: string;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  contentId?: string | null;
  contentDisposition?: string | null;
}

export interface OutboundEmail {
  from?: NormalizedEmailAddress;
  to: NormalizedEmailAddress[];
  cc?: NormalizedEmailAddress[];
  bcc?: NormalizedEmailAddress[];
  replyTo?: NormalizedEmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  thread?: {
    messageId?: string;
    inReplyTo?: string | null;
    references?: string[];
  };
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
    contentId?: string;
  }>;
}

export interface InboundEmail {
  from: NormalizedEmailAddress;
  to: NormalizedEmailAddress[];
  cc: NormalizedEmailAddress[];
  bcc: NormalizedEmailAddress[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  attachments: NormalizedEmailAttachment[];
  receivedAt?: string;
  providerMessageId?: string;
}

export interface EmailProvider {
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
  verifyInboundSignature(req: Request): Promise<boolean>;
  parseInbound(req: Request): Promise<InboundEmail>;
}
