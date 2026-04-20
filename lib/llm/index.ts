import { OpenAIChatClient } from "./openai.ts";
import type { LLMClient } from "./types.ts";

export type SettingReader = (key: string) => Promise<unknown>;

export interface CreateLLMClientOptions {
  getSetting?: SettingReader;
}

const DEFAULT_MODEL_NAME = "gpt-5.4";

export async function createLLMClient(
  options: CreateLLMClientOptions = {},
): Promise<{ client: LLMClient; model: string }> {
  const readSetting = options.getSetting ?? defaultGetSetting;
  const configuredModel = await readSetting("invoice_gen_model_name");
  const model =
    typeof configuredModel === "string" && configuredModel.trim().length > 0
      ? configuredModel
      : DEFAULT_MODEL_NAME;

  return {
    client: createLLMClientForModel(model),
    model,
  };
}

export function createLLMClientForModel(model: string): LLMClient {
  if (isOpenAIModel(model)) {
    return new OpenAIChatClient();
  }

  throw new Error(`Unsupported LLM model configured: ${model}`);
}

function isOpenAIModel(model: string) {
  return model.startsWith("gpt-") || model.startsWith("o");
}

async function defaultGetSetting(key: string) {
  const { getSetting } = await import("../config/settings.ts");

  return getSetting(key);
}
