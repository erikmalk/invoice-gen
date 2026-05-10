import { manageInvoiceTool } from "./manage-invoice.ts";
import { requestClarificationTool } from "./request-clarification.ts";
import { searchClientDbTool } from "./search-client-db.ts";
import { sendInvoiceForReviewTool } from "./send-invoice-for-review.ts";
import type { Tool } from "./types.ts";

export const toolRegistry = new Map<string, Tool>([
  [searchClientDbTool.name, searchClientDbTool],
  [manageInvoiceTool.name, manageInvoiceTool],
  [sendInvoiceForReviewTool.name, sendInvoiceForReviewTool],
  [requestClarificationTool.name, requestClarificationTool],
]);

export function getTool(name: string) {
  const tool = toolRegistry.get(name);

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool;
}

export function toolsForPersona(persona: { toolNames: string[] }) {
  return persona.toolNames.map(getTool);
}

export {
  manageInvoiceTool,
  requestClarificationTool,
  searchClientDbTool,
  sendInvoiceForReviewTool,
};
