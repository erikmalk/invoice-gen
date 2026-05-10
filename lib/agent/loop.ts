import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client.ts";
import { jobs, messages, threads, users, type Message, type Thread, type User } from "../db/schema.ts";
import { resendEmailProvider } from "../email/resend.ts";
import type { EmailProvider } from "../email/types.ts";
import { createLLMClientForModel } from "../llm/index.ts";
import type { ChatMessage, ChatResponse, LLMClient, ToolCall } from "../llm/types.ts";
import { toolRegistry, toolsForPersona } from "../tools/registry.ts";
import { toolToDefinition, type AppDb, type Tool, type ToolContext, type ToolResult } from "../tools/types.ts";
import { personaForEntryPoint } from "./personas.ts";
import { runStep } from "./step.ts";
import type { PersonaConfig } from "./types.ts";

export interface ThreadContext {
  thread: Thread;
  user: User;
  messages: Message[];
}

export interface AgentStore {
  loadThreadContext(threadId: number): Promise<ThreadContext>;
  persistAssistantMessage(threadId: number, response: ChatResponse): Promise<void>;
  persistToolMessage(threadId: number, toolCall: ToolCall, result: ToolResult): Promise<void>;
  setThreadStatus(threadId: number, status: string, lastError?: string | null): Promise<void>;
  recordJobStepError?(jobId: number, stepName: string, error: unknown): Promise<void>;
}

export interface RunAgentLoopDependencies {
  db?: AppDb;
  store?: AgentStore;
  llmClient?: LLMClient;
  emailProvider?: Pick<EmailProvider, "send">;
  persona?: PersonaConfig;
  loadPersona?: (entryPoint: string) => Promise<PersonaConfig>;
  tools?: Tool[];
  loadSystemPrompt?: (persona: PersonaConfig, context: ThreadContext) => Promise<string>;
  jobId?: number;
}

export interface AgentLoopResult {
  status: "done" | "terminal" | "error";
  steps: number;
  terminalToolName?: string;
  error?: string;
}

export async function runAgentLoop(
  threadId: number,
  dependencies: RunAgentLoopDependencies = {},
): Promise<AgentLoopResult> {
  const database = dependencies.db ?? defaultDb;
  const store = dependencies.store ?? createDrizzleAgentStore(database);
  const emailProvider = dependencies.emailProvider ?? resendEmailProvider;
  const startedAt = Date.now();
  const stepOptions = dependencies.jobId
    ? {
        onError: (stepName: string, error: unknown) =>
          store.recordJobStepError?.(dependencies.jobId!, stepName, error),
      }
    : undefined;

  const context = await runStep("load-thread", () => store.loadThreadContext(threadId), stepOptions);
  const persona =
    dependencies.persona ??
    (await runStep(
      "load-persona",
      () => (dependencies.loadPersona ?? personaForEntryPoint)(context.thread.entryPoint),
      stepOptions,
    ));
  const tools = dependencies.tools ?? toolsForPersona(persona);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const llmClient = dependencies.llmClient ?? createLLMClientForModel(persona.model);
  const systemPrompt = await runStep(
    "compose-system-prompt",
    () =>
      dependencies.loadSystemPrompt
        ? dependencies.loadSystemPrompt(persona, context)
        : loadAndRenderSystemPrompt(persona, context),
    stepOptions,
  );
  const chatMessages = buildLLMMessages(context, systemPrompt);

  for (let stepIndex = 0; stepIndex < persona.maxSteps; stepIndex += 1) {
    if ((Date.now() - startedAt) / 1000 > persona.maxWallClockSeconds) {
      const error = `Agent wall-clock budget exhausted after ${persona.maxWallClockSeconds}s.`;
      await runStep("mark-error", () => store.setThreadStatus(threadId, "error", error), stepOptions);
      return { status: "error", steps: stepIndex, error };
    }

    const response = await runStep(
      "llm-call",
      () =>
        llmClient.chat({
          model: persona.model,
          messages: chatMessages,
          tools: tools.map(toolToDefinition),
          toolChoice: "auto",
        }),
      stepOptions,
    );

    await runStep("persist-assistant", () => store.persistAssistantMessage(threadId, response), stepOptions);
    chatMessages.push(response.message);

    const toolCalls = response.message.toolCalls ?? [];

    if (toolCalls.length === 0) {
      await runStep(
        "send-reply",
        () => sendAssistantReply(response.message.content ?? "I finished processing this thread.", context, emailProvider),
        stepOptions,
      );
      await runStep("mark-active", () => store.setThreadStatus(threadId, "active", null), stepOptions);
      return { status: "done", steps: stepIndex + 1 };
    }

    for (const toolCall of toolCalls) {
      const tool = toolMap.get(toolCall.name) ?? toolRegistry.get(toolCall.name);

      if (!tool) {
        throw new Error(`LLM requested unknown tool: ${toolCall.name}`);
      }

      const result = await runStep(
        `tool-${toolCall.name}`,
        () => tool.run(toolCall.arguments, createToolContext(database, context, emailProvider)),
        stepOptions,
      );

      await runStep(
        "persist-tool",
        () => store.persistToolMessage(threadId, toolCall, result),
        stepOptions,
      );

      chatMessages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: JSON.stringify(result),
      });

      if (result.terminal || tool.terminal) {
        return { status: "terminal", steps: stepIndex + 1, terminalToolName: toolCall.name };
      }
    }
  }

  const error = `Agent step budget exhausted after ${persona.maxSteps} steps.`;
  await runStep("mark-error", () => store.setThreadStatus(threadId, "error", error), stepOptions);
  return { status: "error", steps: persona.maxSteps, error };
}

export function buildLLMMessages(context: ThreadContext, systemPrompt: string): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...context.messages.map((message) => messageToChatMessage(context.thread, message)),
  ];
}

export async function loadAndRenderSystemPrompt(persona: PersonaConfig, context: ThreadContext) {
  const promptPath = path.resolve(process.cwd(), persona.systemPromptPath);
  const prompt = await readFile(promptPath, "utf8");

  return prompt.replace("{{user_profile}}", renderUserProfile(context.user));
}

function messageToChatMessage(thread: Thread, message: Message): ChatMessage {
  if (message.role === "user") {
    return {
      role: "user",
      content: [`Subject: ${thread.subject ?? "(no subject)"}`, "", `Body:\n${message.content ?? ""}`].join(
        "\n",
      ),
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? undefined,
      toolCalls: message.toolCalls ?? undefined,
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content ?? "",
      toolCallId: message.toolCallId ?? undefined,
      toolName: message.toolName ?? undefined,
    };
  }

  return {
    role: "system",
    content: message.content ?? "",
  };
}

function renderUserProfile(user: User) {
  return [
    `Email: ${user.email}`,
    user.name ? `Name: ${user.name}` : null,
    user.companyName ? `Company: ${user.companyName}` : null,
    user.companyAddress ? `Company address: ${user.companyAddress}` : null,
    user.companyPhone ? `Company phone: ${user.companyPhone}` : null,
    user.taxId ? `Tax ID: ${user.taxId}` : null,
    `Default due days: ${user.defaultDueDays}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function createToolContext(
  database: AppDb,
  context: ThreadContext,
  emailProvider: Pick<EmailProvider, "send">,
): ToolContext {
  return {
    db: database,
    userId: context.user.id,
    threadId: context.thread.id,
    emailProvider,
  };
}

async function sendAssistantReply(
  content: string,
  context: ThreadContext,
  emailProvider: Pick<EmailProvider, "send">,
) {
  const latestInbound = context.messages
    .filter((message) => message.role === "user" && message.externalMessageId)
    .at(-1);

  await emailProvider.send({
    to: [{ email: context.user.email, name: context.user.name ?? undefined }],
    subject: context.thread.subject ? `Re: ${context.thread.subject}` : "Invoice Generator update",
    text: content,
    html: `<p>${escapeHtml(content).replaceAll("\n", "<br />")}</p>`,
    thread: {
      messageId: context.thread.externalRootId ?? undefined,
      inReplyTo: latestInbound?.externalMessageId ?? context.thread.externalRootId,
      references: [context.thread.externalRootId, latestInbound?.externalMessageId].filter(
        (value): value is string => Boolean(value),
      ),
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createDrizzleAgentStore(database: AppDb): AgentStore {
  return {
    async loadThreadContext(threadId) {
      const [thread] = await database.select().from(threads).where(eq(threads.id, threadId)).limit(1);

      if (!thread) {
        throw new Error(`Thread ${threadId} not found.`);
      }

      const [user] = await database.select().from(users).where(eq(users.id, thread.userId)).limit(1);

      if (!user) {
        throw new Error(`User ${thread.userId} not found for thread ${threadId}.`);
      }

      const threadMessages = await database
        .select()
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .orderBy(messages.sequenceNum);

      return { thread, user, messages: threadMessages };
    },
    async persistAssistantMessage(threadId, response) {
      await database.insert(messages).values({
        threadId,
        sequenceNum: await nextSequenceNumber(database, threadId),
        role: "assistant",
        content: response.message.content,
        toolCalls: response.message.toolCalls,
        tokenUsage: response.usage,
        model: response.model,
      });
    },
    async persistToolMessage(threadId, toolCall, result) {
      await database.insert(messages).values({
        threadId,
        sequenceNum: await nextSequenceNumber(database, threadId),
        role: "tool",
        content: JSON.stringify(result),
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
    },
    async setThreadStatus(threadId, status, lastError = null) {
      await database
        .update(threads)
        .set({ status, lastError, updatedAt: new Date() })
        .where(eq(threads.id, threadId));
    },
    async recordJobStepError(jobId, stepName, error) {
      await database
        .update(jobs)
        .set({
          lastError: `${stepName}: ${error instanceof Error ? error.message : String(error)}`,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    },
  };
}

async function nextSequenceNumber(database: AppDb, threadId: number) {
  const [row] = await database
    .select({ nextValue: sql<number>`coalesce(max(${messages.sequenceNum}), 0) + 1` })
    .from(messages)
    .where(eq(messages.threadId, threadId));

  return row?.nextValue ?? 1;
}
