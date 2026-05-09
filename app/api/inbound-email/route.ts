import { handleInboundEmail } from "./handler.ts";

export async function POST(req: Request) {
  return handleInboundEmail(req);
}
