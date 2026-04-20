import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions/completions";

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
  chat: {
    completions: {
      create(
        request: ChatCompletionCreateParamsNonStreaming,
      ): Promise<ChatCompletion>;
    };
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
    const completion = await this.client.chat.completions.create({
      model: req.model,
      messages: toOpenAIChatMessages(req.messages),
      tools: req.tools ? toOpenAITools(req.tools) : undefined,
      tool_choice: toOpenAIToolChoice(req.toolChoice),
      stream: false,
    } satisfies ChatCompletionCreateParamsNonStreaming);

    return fromOpenAIChatCompletion(completion);
  }
}

export function toOpenAIChatMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return {
          role: "system",
          content: message.content ?? "",
        };
      case "user":
        return {
          role: "user",
          content: message.content ?? "",
        };
      case "assistant":
        return toOpenAIAssistantMessage(message);
      case "tool":
        return toOpenAIToolMessage(message);
      default:
        throw new Error(`Unsupported chat message role: ${message.role}`);
    }
  });
}

export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JSONSchema,
    },
  }));
}

export function toOpenAIToolChoice(
  toolChoice: ToolChoice | undefined,
): ChatCompletionToolChoiceOption | undefined {
  return toolChoice;
}

export function fromOpenAIChatCompletion(completion: ChatCompletion): ChatResponse {
  const choice = completion.choices[0];

  if (!choice) {
    throw new Error("OpenAI returned no choices.");
  }

  return {
    message: fromOpenAIChatMessage(choice.message),
    usage: normalizeUsage(completion.usage),
    model: completion.model,
  };
}

export function fromOpenAIChatMessage(message: ChatCompletionMessage): ChatMessage {
  return {
    role: "assistant",
    content: message.content ?? undefined,
    toolCalls: message.tool_calls?.map(fromOpenAIToolCall),
  };
}

function toOpenAIAssistantMessage(message: ChatMessage): ChatCompletionAssistantMessageParam {
  const hasToolCalls = Boolean(message.toolCalls?.length);

  return {
    role: "assistant",
    content: hasToolCalls ? (message.content ?? null) : (message.content ?? ""),
    tool_calls: message.toolCalls?.map(toOpenAIToolCall),
  };
}

function toOpenAIToolMessage(message: ChatMessage): ChatCompletionToolMessageParam {
  if (!message.toolCallId) {
    throw new Error("Tool messages require toolCallId.");
  }

  return {
    role: "tool",
    content: message.content ?? "",
    tool_call_id: message.toolCallId,
  };
}

function toOpenAIToolCall(toolCall: ToolCall): ChatCompletionMessageToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  };
}

function fromOpenAIToolCall(toolCall: ChatCompletionMessageToolCall): ToolCall {
  if (toolCall.type !== "function") {
    throw new Error(`Unsupported OpenAI tool call type: ${toolCall.type}`);
  }

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
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

function normalizeUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): TokenUsage | undefined {
  if (
    usage?.prompt_tokens === undefined ||
    usage.completion_tokens === undefined ||
    usage.total_tokens === undefined
  ) {
    return undefined;
  }

  return {
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    total: usage.total_tokens,
  };
}

