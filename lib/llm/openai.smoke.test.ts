import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIChatClient } from "./openai.ts";

const shouldRun = process.env.RUN_OPENAI_SMOKE_TEST === "1";

test("real OpenAI hello-world tool call smoke test", { skip: !shouldRun }, async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when RUN_OPENAI_SMOKE_TEST=1.");
  }

  const client = new OpenAIChatClient({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat({
    model: "gpt-5.4",
    messages: [
      {
        role: "system",
        content: "You are a concise assistant that must call the provided tool exactly once.",
      },
      {
        role: "user",
        content: "Call the hello_world tool for Erik.",
      },
    ],
    tools: [
      {
        name: "hello_world",
        description: "Returns a hello-world style greeting.",
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
      },
    ],
    toolChoice: "required",
  });

  assert.ok(
    response.model.startsWith("gpt-5.4"),
    `Expected returned model to start with gpt-5.4, received ${response.model}`,
  );
  assert.equal(response.message.toolCalls?.length, 1);
  assert.equal(response.message.toolCalls?.[0]?.name, "hello_world");
  assert.deepEqual(response.message.toolCalls?.[0]?.arguments, { name: "Erik" });
});
