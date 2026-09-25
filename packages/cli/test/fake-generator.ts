import { NO_TOOL_CALL_NOTE, type Generator, type Session, type SessionOptions } from '../src/llm.js';

export interface FakeRequest {
  model: string;
  system: string;
  messages: readonly string[];
}

export type FakeResponder = (request: FakeRequest) => string | null | Promise<string | null>;

// Scripted stand-in for Claude: the responder sees the whole session so far
// and returns the code for this turn (null means "no tool call").
export class FakeGenerator implements Generator {
  readonly requests: FakeRequest[] = [];
  readonly #responder: FakeResponder;

  constructor(responder: FakeResponder) {
    this.#responder = responder;
  }

  start(options: SessionOptions): Session {
    const messages: string[] = [];
    return {
      send: async (message, model) => {
        messages.push(message);
        const request: FakeRequest = { model, system: options.system, messages: [...messages] };
        this.requests.push(request);
        const code = await this.#responder(request);
        return {
          code,
          note: code === null ? NO_TOOL_CALL_NOTE : '',
          usage: { inputTokens: 100, outputTokens: 50 },
          model,
        };
      },
    };
  }
}
