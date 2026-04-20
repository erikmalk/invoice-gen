export type Role = "system" | "user" | "assistant" | "tool";

export type JSONSchema = {
  [key: string]: unknown;
};

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatMessage {
  role: Role;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ToolChoice = "auto" | "required" | "none";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: TokenUsage;
  model: string;
}

export interface LLMClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
