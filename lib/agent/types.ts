export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMClient,
  ToolCall,
  ToolDefinition,
} from "../llm/types.ts";

export interface PersonaConfig {
  entryPoint: string;
  name: string;
  systemPrompt: string;
  toolNames: string[];
  model: string;
  maxSteps: number;
  maxWallClockSeconds: number;
}
