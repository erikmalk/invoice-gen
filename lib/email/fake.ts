import type { InboundEmail, OutboundEmail } from "./types.ts";

export class FakeEmailProvider {
  readonly sent: OutboundEmail[] = [];

  async send(msg: OutboundEmail) {
    this.sent.push(msg);
    return { messageId: `fake_email_${this.sent.length}` };
  }

  async verifyInboundSignature() {
    return true;
  }

  async parseInbound(): Promise<InboundEmail> {
    throw new Error("FakeEmailProvider.parseInbound is not scripted.");
  }
}
