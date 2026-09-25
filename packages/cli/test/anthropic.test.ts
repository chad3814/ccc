import type {
  BetaContentBlock,
  BetaMessageStreamParams,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicGenerator, MAX_TOKENS, buildRequest, modelProfile, type StreamedReply } from '../src/anthropic.js';
import { GeneratorUnavailable } from '../src/llm.js';

function reply(content: BetaContentBlock[], stopReason: BetaStopReason = 'tool_use'): StreamedReply {
  return {
    content,
    stop_reason: stopReason,
    model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: null },
  };
}
const writeCall = (id: string, code: string): BetaContentBlock => ({ type: 'tool_use', id, name: 'write_module', input: { code } });
const text = (value: string): BetaContentBlock => ({ type: 'text', text: value, citations: null });

function scripted(replies: StreamedReply[]) {
  const params: BetaMessageStreamParams[] = [];
  const generator = new AnthropicGenerator(async (request) => {
    params.push(request);
    const next = replies.shift();
    if (next === undefined) throw new Error('no scripted reply left');
    return next;
  });
  return { params, generator };
}

describe('AnthropicGenerator', () => {
  it('sends the request shape ccc relies on', async () => {
    const { params, generator } = scripted([reply([writeCall('t1', 'export {};')])]);
    const turn = await generator.start({ model: 'claude-opus-5', system: 'sys' }).send('write it');
    expect(turn).toEqual({ code: 'export {};', note: '', usage: { inputTokens: 13, outputTokens: 5 }, model: 'claude-opus-5' });
    const [first] = params;
    expect(first?.model).toBe('claude-opus-5');
    expect(first?.max_tokens).toBe(MAX_TOKENS);
    expect(first?.system).toBe('sys');
    expect(first?.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(first?.fallbacks).toBe('default');
    expect(first?.thinking).toEqual({ type: 'adaptive' });
    expect(first?.tool_choice).toEqual({ type: 'auto' });
    expect(first?.tools?.[0]).toMatchObject({ name: 'write_module', strict: true });
    expect(first?.messages).toEqual([{ role: 'user', content: 'write it' }]);
  });

  it('answers the previous tool call with an error result when sending feedback', async () => {
    const { params, generator } = scripted([reply([text('ok'), writeCall('t1', 'a')]), reply([writeCall('t2', 'b')])]);
    const session = generator.start({ model: 'claude-opus-5', system: 's' });
    await session.send('first');
    const second = await session.send('fix it');
    expect(second.code).toBe('b');
    const messages = params[1]?.messages ?? [];
    expect(messages[1]).toEqual({ role: 'assistant', content: [text('ok'), writeCall('t1', 'a')] });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'fix it' }],
    });
  });

  it('treats a reply without a tool call as a failed turn and continues with plain text', async () => {
    const { params, generator } = scripted([reply([text('I think...')], 'end_turn'), reply([writeCall('t1', 'c')])]);
    const session = generator.start({ model: 'claude-opus-5', system: 's' });
    expect(await session.send('go')).toMatchObject({ code: null, note: 'you did not call write_module' });
    await session.send('call the tool');
    expect(params[1]?.messages[2]).toEqual({ role: 'user', content: 'call the tool' });
  });

  it('reports refusals and truncation, and still closes a truncated tool call', async () => {
    const refusal = scripted([reply([], 'refusal')]);
    expect(await refusal.generator.start({ model: 'claude-opus-5', system: 's' }).send('go')).toMatchObject({
      code: null,
      note: 'the model declined this request',
    });

    const truncated: BetaContentBlock = { type: 'tool_use', id: 't9', name: 'write_module', input: {} };
    const cut = scripted([reply([truncated], 'max_tokens'), reply([writeCall('t10', 'd')])]);
    const session = cut.generator.start({ model: 'claude-opus-5', system: 's' });
    expect((await session.send('go')).note).toBe('the reply hit max_tokens (64000) and was cut off; write a shorter module');
    await session.send('shorter please');
    expect(cut.params[1]?.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'shorter please' }],
    });
  });
});

describe('model-aware requests', () => {
  const messages = [{ role: 'user' as const, content: 'x' }];

  it('uses adaptive thinking and server-side fallbacks on current frontier models', () => {
    const request = buildRequest({ model: 'claude-opus-5', system: 's' }, messages);
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.fallbacks).toBe('default');
    expect(request.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('uses adaptive thinking without fallbacks on Sonnet 5', () => {
    const request = buildRequest({ model: 'claude-sonnet-5', system: 's' }, messages);
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.fallbacks).toBeUndefined();
    expect(request.betas).toBeUndefined();
  });

  it('uses a thinking budget on Haiku 4.5', () => {
    const request = buildRequest({ model: 'claude-haiku-4-5', system: 's' }, messages);
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
    expect(request.fallbacks).toBeUndefined();
    expect(request.max_tokens).toBe(MAX_TOKENS);
  });

  it('sends no thinking or fallback settings for models it does not know', () => {
    const request = buildRequest({ model: 'some-future-model', system: 's' }, messages);
    expect(request.thinking).toBeUndefined();
    expect(request.fallbacks).toBeUndefined();
    expect(modelProfile('some-future-model')).toEqual({ thinking: 'none', fallbacks: false });
  });
});

describe('unavailable generators', () => {
  function failing(error: Error) {
    return new AnthropicGenerator(async () => {
      throw error;
    });
  }

  it('turns a persistent 429 into GeneratorUnavailable, noting missing rate-limit headers', async () => {
    const error = new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', new Headers());
    const send = failing(error).start({ model: 'claude-opus-5', system: 's' }).send('go');
    await expect(send).rejects.toBeInstanceOf(GeneratorUnavailable);
    await expect(send).rejects.toThrow(
      'claude-opus-5 is rate-limited for this API key, and the response had no rate-limit headers, which usually means the organization has no allowance for this model; check the console under Settings → Limits, or set another model in ccc.config.ts',
    );
  });

  it('reports ordinary rate limits with the limit that was hit', async () => {
    const headers = new Headers({ 'anthropic-ratelimit-output-tokens-limit': '8000', 'retry-after': '30' });
    const error = new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', headers);
    await expect(failing(error).start({ model: 'claude-opus-5', system: 's' }).send('go')).rejects.toThrow(
      'claude-opus-5 is still rate-limited after retries (retry after 30s); lower concurrency in ccc.config.ts or try again later',
    );
  });

  it('turns authentication and missing-model errors into GeneratorUnavailable', async () => {
    const auth = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
    await expect(failing(auth).start({ model: 'claude-opus-5', system: 's' }).send('go')).rejects.toThrow(
      'authentication failed; check ANTHROPIC_API_KEY (or your `ant auth login` profile)',
    );
    const missing = new Anthropic.NotFoundError(404, { type: 'error' }, 'model not found', new Headers());
    await expect(failing(missing).start({ model: 'claude-nope', system: 's' }).send('go')).rejects.toThrow(
      "model 'claude-nope' is not available to this API key",
    );
  });
});
