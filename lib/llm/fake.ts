import type { ChatRequest, ChatResponse, LLMClient } from "./types.ts";

export class FakeLLMClient implements LLMClient {
  private readonly responses: ChatResponse[];

  readonly requests: ChatRequest[] = [];

  constructor(responses: ChatResponse[]) {
    this.responses = [...responses];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);

    const response = this.responses.shift();

    if (!response) {
      throw new Error("FakeLLMClient has no scripted responses remaining.");
    }

    return response;
  }
}
