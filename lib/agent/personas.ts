import { getSetting } from "../config/settings.ts";
import { DEFAULT_INVOICE_GEN_PROMPT } from "./default-prompts.ts";
import type { PersonaConfig } from "./types.ts";

const defaultInvoiceGenPersona: PersonaConfig = {
  entryPoint: "invoice-gen",
  name: "Invoice Generator",
  systemPrompt: DEFAULT_INVOICE_GEN_PROMPT,
  toolNames: ["search_client_db", "manage_invoice", "send_invoice_for_review", "request_clarification"],
  model: "gpt-5.4",
  maxSteps: 10,
  maxWallClockSeconds: 600,
};

export async function personaForEntryPoint(entryPoint: string): Promise<PersonaConfig> {
  if (entryPoint !== "invoice-gen") {
    throw new Error(`Unsupported persona entry point: ${entryPoint}`);
  }

  const [model, maxSteps, maxWallClockSeconds, systemPrompt] = await Promise.all([
    getSetting("invoice_gen_model_name"),
    getSetting("invoice_gen_max_agent_steps"),
    getSetting("invoice_gen_max_wall_clock_seconds"),
    getSetting("invoice_gen_system_prompt"),
  ]);

  return {
    ...defaultInvoiceGenPersona,
    model: typeof model === "string" && model.trim() ? model : defaultInvoiceGenPersona.model,
    maxSteps: typeof maxSteps === "number" ? maxSteps : defaultInvoiceGenPersona.maxSteps,
    maxWallClockSeconds:
      typeof maxWallClockSeconds === "number"
        ? maxWallClockSeconds
        : defaultInvoiceGenPersona.maxWallClockSeconds,
    systemPrompt:
      typeof systemPrompt === "string" && systemPrompt.trim()
        ? systemPrompt
        : defaultInvoiceGenPersona.systemPrompt,
  };
}

export function invoiceGenPersonaForTests(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    ...defaultInvoiceGenPersona,
    ...overrides,
  };
}
