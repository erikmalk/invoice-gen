import assert from "node:assert/strict";
import test from "node:test";

import { FakeLLMClient } from "./fake.ts";
import {
  OpenAIChatClient,
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
  toOpenAITools,
} from "./openai.ts";
import type { ChatResponse, ToolDefinition } from "./types.ts";

const helloTool: ToolDefinition = {
  name: "hello_world",
  description: "Returns a greeting.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

test("roundtrips a tool call between normalized and OpenAI shapes", async () => {
  const messages = [
    {
      role: "system" as const,
      content: "You are a helpful assistant.",
    },
    {
      role: "user" as const,
      content: "Say hi to Erik.",
    },
    {
      role: "assistant" as const,
      toolCalls: [
        {
          id: "call_123",
          name: "hello_world",
          arguments: {
            name: "Erik",
          },
        },
      ],
    },
    {
      role: "tool" as const,
      toolCallId: "call_123",
      toolName: "hello_world",
      content: JSON.stringify({ greeting: "Hello, Erik!" }),
    },
  ];

  const openAIMessages = toOpenAIChatMessages(messages);

  assert.deepEqual(openAIMessages[2], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_123",
        type: "function",
        function: {
          name: "hello_world",
          arguments: JSON.stringify({ name: "Erik" }),
        },
      },
    ],
  });

  assert.deepEqual(openAIMessages[3], {
    role: "tool",
    content: JSON.stringify({ greeting: "Hello, Erik!" }),
    tool_call_id: "call_123",
  });

  assert.deepEqual(toOpenAITools([helloTool]), [
    {
      type: "function",
      function: {
        name: "hello_world",
        description: "Returns a greeting.",
        parameters: helloTool.parameters,
      },
    },
  ]);

  const response = fromOpenAIChatCompletion({
    id: "chatcmpl_123",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "hello_world",
                arguments: JSON.stringify({ name: "Erik" }),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    },
  });

  assert.deepEqual(response, {
    model: "gpt-5.4",
    usage: {
      prompt: 10,
      completion: 4,
      total: 14,
    },
    message: {
      role: "assistant",
      content: undefined,
      toolCalls: [
        {
          id: "call_123",
          name: "hello_world",
          arguments: {
            name: "Erik",
          },
        },
      ],
    },
  });
});

test("handles a response with no tool calls", async () => {
  const response: ChatResponse = {
    model: "fake-model",
    message: {
      role: "assistant",
      content: "Draft ready.",
    },
    usage: {
      prompt: 1,
      completion: 2,
      total: 3,
    },
  };

  const fake = new FakeLLMClient([response]);

  const result = await fake.chat({
    model: "fake-model",
    messages: [
      {
        role: "user",
        content: "Create a draft.",
      },
    ],
  });

  assert.deepEqual(result, response);
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.requests[0]?.messages, [
    {
      role: "user",
      content: "Create a draft.",
    },
  ]);
});

test("handles multiple tool calls in one turn", async () => {
  const client = new OpenAIChatClient({
    client: {
      chat: {
        completions: {
          async create() {
            return {
              id: "chatcmpl_multi",
              object: "chat.completion",
              created: 1,
              model: "gpt-5.4",
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  logprobs: null,
                  message: {
                    role: "assistant",
                    content: null,
                    refusal: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "hello_world",
                          arguments: JSON.stringify({ name: "Erik" }),
                        },
                      },
                      {
                        id: "call_2",
                        type: "function",
                        function: {
                          name: "hello_world",
                          arguments: JSON.stringify({ name: "Invoice Bot" }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 11,
                completion_tokens: 8,
                total_tokens: 19,
              },
            };
          },
        },
      },
    },
  });

  const result = await client.chat({
    model: "gpt-5.4",
    messages: [
      {
        role: "user",
        content: "Call the hello tool twice.",
      },
    ],
    tools: [helloTool],
    toolChoice: "required",
  });

  assert.deepEqual(result.message.toolCalls, [
    {
      id: "call_1",
      name: "hello_world",
      arguments: {
        name: "Erik",
      },
    },
    {
      id: "call_2",
      name: "hello_world",
      arguments: {
        name: "Invoice Bot",
      },
    },
  ]);
  assert.equal(result.model, "gpt-5.4");
  assert.deepEqual(result.usage, {
    prompt: 11,
    completion: 8,
    total: 19,
  });
});
