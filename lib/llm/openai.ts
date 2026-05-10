import OpenAI from "openai";
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseUsage,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  JSONSchema,
  LLMClient,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "./types.ts";

export interface OpenAIClientLike {
  responses: {
    create(request: ResponseCreateParamsNonStreaming): Promise<OpenAIResponse>;
  };
}

export interface OpenAIChatClientOptions {
  apiKey?: string;
  client?: OpenAIClientLike;
}

export class OpenAIChatClient implements LLMClient {
  private readonly client: OpenAIClientLike;

  constructor(options: OpenAIChatClientOptions = {}) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.responses.create({
      model: req.model,
      input: toOpenAIResponseInput(req.messages),
      tools: req.tools ? toOpenAIResponseTools(req.tools) : undefined,
      tool_choice: toOpenAIResponseToolChoice(req.toolChoice),
      parallel_tool_calls: true,
      stream: false,
    } satisfies ResponseCreateParamsNonStreaming);

    return fromOpenAIResponse(response);
  }
}

export function toOpenAIResponseInput(messages: ChatMessage[]): ResponseInput {
  return messages.flatMap((message) => {
    switch (message.role) {
      case "system":
      case "user":
        return [{ role: message.role, content: message.content ?? "", type: "message" }];
      case "assistant":
        return toOpenAIResponseAssistantItems(message);
      case "tool":
        return [toOpenAIResponseToolOutput(message)];
      default:
        throw new Error(`Unsupported chat message role: ${message.role}`);
    }
  });
}

export function toOpenAIResponseTools(tools: ToolDefinition[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as JSONSchema,
    strict: false,
  }));
}

export function toOpenAIResponseToolChoice(
  toolChoice: ToolChoice | undefined,
): ToolChoiceOptions | undefined {
  return toolChoice;
}

export function fromOpenAIResponse(response: OpenAIResponse): ChatResponse {
  return {
    message: fromOpenAIResponseOutput(response.output),
    usage: normalizeUsage(response.usage),
    model: response.model,
  };
}

export function fromOpenAIResponseOutput(output: ResponseOutputItem[]): ChatMessage {
  const contentParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    if (isOutputMessage(item)) {
      const messageText = item.content
        .map((part) => (part.type === "output_text" ? part.text : part.refusal))
        .filter(Boolean)
        .join("\n");

      if (messageText) {
        contentParts.push(messageText);
      }
    }

    if (isFunctionToolCall(item)) {
      toolCalls.push(fromOpenAIResponseToolCall(item));
    }
  }

  return {
    role: "assistant",
    content: contentParts.length > 0 ? contentParts.join("\n") : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function toOpenAIResponseAssistantItems(message: ChatMessage): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  if (message.content) {
    items.push({
      role: "assistant",
      content: message.content,
      type: "message",
    });
  }

  for (const toolCall of message.toolCalls ?? []) {
    items.push(toOpenAIResponseToolCall(toolCall));
  }

  if (items.length === 0) {
    items.push({ role: "assistant", content: "", type: "message" });
  }

  return items;
}

function toOpenAIResponseToolCall(toolCall: ToolCall): ResponseFunctionToolCall {
  return {
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.arguments ?? {}),
  };
}

function toOpenAIResponseToolOutput(message: ChatMessage): ResponseInputItem.FunctionCallOutput {
  if (!message.toolCallId) {
    throw new Error("Tool messages require toolCallId.");
  }

  return {
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content ?? "",
  };
}

function fromOpenAIResponseToolCall(toolCall: ResponseFunctionToolCall): ToolCall {
  return {
    id: toolCall.call_id,
    name: toolCall.name,
    arguments: parseToolArguments(toolCall.arguments),
  };
}

function parseToolArguments(value: string): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI tool arguments: ${value}`, {
      cause: error,
    });
  }
}

function isOutputMessage(item: ResponseOutputItem): item is ResponseOutputMessage {
  return item.type === "message";
}

function isFunctionToolCall(item: ResponseOutputItem): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

function normalizeUsage(usage: ResponseUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    prompt: usage.input_tokens,
    completion: usage.output_tokens,
    total: usage.total_tokens,
  };
}

// Backwards-compatible exports for existing tests/imports while the app-level
// abstraction remains LLMClient.chat(...).
export const toOpenAIChatMessages = toOpenAIResponseInput;
export const toOpenAITools = toOpenAIResponseTools;
export const toOpenAIToolChoice = toOpenAIResponseToolChoice;
export const fromOpenAIChatCompletion = fromOpenAIResponse;
