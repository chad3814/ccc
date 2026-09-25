export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// One model turn: the module it wrote (null if it didn't call write_module)
// and why not.
export interface Turn {
  code: string | null;
  note: string;
  usage: Usage;
  model: string;
}

export interface Session {
  send(message: string): Promise<Turn>;
}

export interface SessionOptions {
  model: string;
  system: string;
}

export interface Generator {
  start(options: SessionOptions): Session;
}

export const NO_TOOL_CALL_NOTE = 'you did not call write_module';

// The generator can't serve any request right now (persistent rate limit,
// bad credentials, unknown model). Builds stop instead of failing every
// concept with the same error.
export class GeneratorUnavailable extends Error {}
