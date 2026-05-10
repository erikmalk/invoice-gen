import type { db as defaultDb } from "../db/client.ts";
import type { EmailProvider } from "../email/types.ts";
import type { JSONSchema, ToolDefinition } from "../llm/types.ts";

export type AppDb = typeof defaultDb;

export interface ToolContext {
  db: AppDb;
  userId: number;
  threadId: number;
  emailProvider: Pick<EmailProvider, "send">;
}

export interface ToolResult {
  ok: boolean;
  terminal?: boolean;
  data?: unknown;
  error?: string;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  terminal?: boolean;
  requiresApproval?: boolean;
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
