import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaStopReason,
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { GeneratorUnavailable, NO_TOOL_CALL_NOTE, type Generator, type Session, type SessionOptions, type Turn } from './llm.js';

export const MAX_TOKENS = 64_000;

export const WRITE_MODULE_TOOL: BetaTool = {
  name: 'write_module',
  description: 'Write the complete TypeScript source of the requested module. Always pass the whole file.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Complete TypeScript source of the module' } },
    required: ['code'],
    additionalProperties: false,
  },
};

// The subset of BetaMessage ccc reads; the SDK's message satisfies it.
export interface StreamedReply {
  content: BetaContentBlock[];
  stop_reason: BetaStopReason | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

export type Streamer = (params: BetaMessageStreamParams) => Promise<StreamedReply>;

const writeModuleCall = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.literal('write_module'),
  input: z.object({ code: z.string() }),
});
const toolUse = z.object({ type: z.literal('tool_use'), id: z.string() });

// Credentials come from the SDK's own resolution (ANTHROPIC_API_KEY or an
// `ant auth login` profile); ccc never reads them.
export function defaultStreamer(): Streamer {
  // Extra retries so ordinary per-minute limits back off as retry-after asks.
  const client = new Anthropic({ maxRetries: 6 });
  return (params) => client.beta.messages.stream(params).finalMessage();
}

export const THINKING_BUDGET = 16_000;

export interface ModelProfile {
  thinking: 'adaptive' | 'budget' | 'none';
  fallbacks: boolean;
}

// Request settings differ by model: current frontier models take adaptive
// thinking (and server-side refusal fallbacks where offered); Haiku 4.5 takes
// a thinking budget. Unknown models get neither, which every model accepts.
const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'claude-fable-5-1': { thinking: 'adaptive', fallbacks: true },
  'claude-fable-5': { thinking: 'adaptive', fallbacks: true },
  'claude-opus-5-5': { thinking: 'adaptive', fallbacks: true },
  'claude-opus-5': { thinking: 'adaptive', fallbacks: true },
  'claude-sonnet-5': { thinking: 'adaptive', fallbacks: false },
  'claude-opus-4-8': { thinking: 'adaptive', fallbacks: false },
  'claude-opus-4-7': { thinking: 'adaptive', fallbacks: false },
  'claude-opus-4-6': { thinking: 'adaptive', fallbacks: false },
  'claude-sonnet-4-6': { thinking: 'adaptive', fallbacks: false },
  'claude-haiku-4-5': { thinking: 'budget', fallbacks: false },
};

export function modelProfile(model: string): ModelProfile {
  return PROFILES[model] ?? { thinking: 'none', fallbacks: false };
}

export function buildRequest(model: string, system: string, messages: readonly BetaMessageParam[]): BetaMessageStreamParams {
  const profile = modelProfile(model);
  const request: BetaMessageStreamParams = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    tools: [WRITE_MODULE_TOOL],
    tool_choice: { type: 'auto' },
    messages: [...messages],
  };
  if (profile.thinking === 'adaptive') {
    request.thinking = { type: 'adaptive' };
  } else if (profile.thinking === 'budget') {
    request.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET };
  }
  if (profile.fallbacks) {
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }
  return request;
}

// Errors no retry or later attempt can fix become GeneratorUnavailable.
function unavailable(model: string, err: Error): Error {
  if (err instanceof Anthropic.RateLimitError) {
    const headers = err.headers;
    const hasLimits = [...headers.keys()].some((key) => key.startsWith('anthropic-ratelimit-'));
    if (!hasLimits) {
      return new GeneratorUnavailable(
        `${model} is rate-limited for this API key, and the response had no rate-limit headers, which usually means the organization has no allowance for this model; check the console under Settings → Limits, or set another model in ccc.config.ts`,
      );
    }
    const retryAfter = headers.get('retry-after');
    return new GeneratorUnavailable(
      `${model} is still rate-limited after retries${retryAfter === null ? '' : ` (retry after ${retryAfter}s)`}; lower concurrency in ccc.config.ts or try again later`,
    );
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new GeneratorUnavailable('authentication failed; check ANTHROPIC_API_KEY (or your `ant auth login` profile)');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new GeneratorUnavailable(`model '${model}' is not available to this API key`);
  }
  return err;
}

export class AnthropicGenerator implements Generator {
  #streamer: Streamer | null;

  constructor(streamer: Streamer | null = null) {
    this.#streamer = streamer;
  }

  start(options: SessionOptions): Session {
    this.#streamer ??= defaultStreamer();
    const stream = this.#streamer;
    const messages: BetaMessageParam[] = [];
    let openToolUses: string[] = [];
    return {
      send: async (text: string, model: string): Promise<Turn> => {
        if (openToolUses.length === 0) {
          messages.push({ role: 'user', content: text });
        } else {
          // Every tool_use needs a tool_result; feedback goes on the first.
          const results: BetaToolResultBlockParam[] = openToolUses.map((id, index) => ({
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: index === 0 ? text : 'Ignored: only the first write_module call is used.',
          }));
          messages.push({ role: 'user', content: results });
        }
        let reply: StreamedReply;
        try {
          reply = await stream(buildRequest(model, options.system, messages));
        } catch (err) {
          throw err instanceof Error ? unavailable(model, err) : err;
        }
        messages.push({ role: 'assistant', content: reply.content });
        openToolUses = reply.content.flatMap((block) => {
          const parsed = toolUse.safeParse(block);
          return parsed.success ? [parsed.data.id] : [];
        });
        const usage = {
          inputTokens:
            reply.usage.input_tokens + (reply.usage.cache_read_input_tokens ?? 0) + (reply.usage.cache_creation_input_tokens ?? 0),
          outputTokens: reply.usage.output_tokens,
        };
        const turn = (code: string | null, note: string): Turn => ({ code, note, usage, model: reply.model });
        if (reply.stop_reason === 'refusal') {
          return turn(null, 'the model declined this request');
        }
        if (reply.stop_reason === 'max_tokens') {
          return turn(null, `the reply hit max_tokens (${MAX_TOKENS}) and was cut off; write a shorter module`);
        }
        for (const block of reply.content) {
          const call = writeModuleCall.safeParse(block);
          if (call.success) {
            return turn(call.data.input.code, '');
          }
        }
        return turn(null, NO_TOOL_CALL_NOTE);
      },
    };
  }
}
