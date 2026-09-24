import type {
  BetaContentBlock,
  BetaMessageStreamParams,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { AnthropicGenerator, MAX_TOKENS, type StreamedReply } from '../src/anthropic.js';

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
