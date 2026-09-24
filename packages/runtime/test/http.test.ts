import { describe, expect, it } from 'vitest';
import { Conflict } from '../src/errors.js';
import { UNMATCHED_HEADER, errorResponse, isUnmatched, json, unmatched } from '../src/http.js';
import { defineConfig } from '../src/config.js';

describe('http helpers', () => {
  it('builds JSON responses', async () => {
    const response = json({ a: [1, 'b', null] }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ a: [1, 'b', null] });
  });

  it('marks unmatched routes distinctly from real 404s', () => {
    expect(isUnmatched(unmatched())).toBe(true);
    expect(unmatched().headers.get(UNMATCHED_HEADER)).toBe('1');
    expect(isUnmatched(json({ error: 'no such game' }, 404))).toBe(false);
  });

  it('turns errors into JSON error responses', async () => {
    const response = errorResponse(new Conflict('seat taken'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'seat taken' });
    expect(errorResponse(new Error('boom')).status).toBe(500);
  });

  it('passes config through defineConfig', () => {
    expect(defineConfig({ maxAttempts: 2 })).toEqual({ maxAttempts: 2 });
  });
});
