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
import { NO_TOOL_CALL_NOTE, type Generator, type Session, type SessionOptions, type Turn } from './llm.js';

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
  const client = new Anthropic();
  return (params) => client.beta.messages.stream(params).finalMessage();
}

export function buildRequest(options: SessionOptions, messages: readonly BetaMessageParam[]): BetaMessageStreamParams {
  return {
    model: options.model,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: options.system,
    tools: [WRITE_MODULE_TOOL],
    tool_choice: { type: 'auto' },
    messages: [...messages],
  };
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
      send: async (text: string): Promise<Turn> => {
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
        const reply = await stream(buildRequest(options, messages));
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
