import assert from "node:assert/strict";
import test from "node:test";

import type { Response as OpenAIResponse } from "openai/resources/responses/responses";

import { FakeLLMClient } from "./fake.ts";
import {
  OpenAIChatClient,
  fromOpenAIResponse,
  toOpenAIResponseInput,
  toOpenAIResponseTools,
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

test("roundtrips a tool call between normalized and OpenAI Responses shapes", async () => {
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

  const openAIInput = toOpenAIResponseInput(messages);

  assert.deepEqual(openAIInput[2], {
    type: "function_call",
    call_id: "call_123",
    name: "hello_world",
    arguments: JSON.stringify({ name: "Erik" }),
  });

  assert.deepEqual(openAIInput[3], {
    type: "function_call_output",
    call_id: "call_123",
    output: JSON.stringify({ greeting: "Hello, Erik!" }),
  });

  assert.deepEqual(toOpenAIResponseTools([helloTool]), [
    {
      type: "function",
      name: "hello_world",
      description: "Returns a greeting.",
      parameters: helloTool.parameters,
      strict: false,
    },
  ]);

  const response = fromOpenAIResponse({
    id: "resp_123",
    object: "response",
    created_at: 1,
    model: "gpt-5.4",
    output: [
      {
        id: "fc_123",
        type: "function_call",
        call_id: "call_123",
        name: "hello_world",
        arguments: JSON.stringify({ name: "Erik" }),
        status: "completed",
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as OpenAIResponse);

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

test("handles multiple tool calls in one Responses turn", async () => {
  const client = new OpenAIChatClient({
    client: {
      responses: {
        async create(request) {
          assert.equal(request.model, "gpt-5.4");
          assert.equal(request.tool_choice, "required");
          assert.equal(request.parallel_tool_calls, true);

          return {
            id: "resp_multi",
            object: "response",
            created_at: 1,
            model: "gpt-5.4",
            output: [
              {
                id: "fc_1",
                type: "function_call",
                call_id: "call_1",
                name: "hello_world",
                arguments: JSON.stringify({ name: "Erik" }),
                status: "completed",
              },
              {
                id: "fc_2",
                type: "function_call",
                call_id: "call_2",
                name: "hello_world",
                arguments: JSON.stringify({ name: "Invoice Bot" }),
                status: "completed",
              },
            ],
            usage: {
              input_tokens: 11,
              output_tokens: 8,
              total_tokens: 19,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          } as OpenAIResponse;
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
