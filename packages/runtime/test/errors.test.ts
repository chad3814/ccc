import { describe, expect, it } from 'vitest';
import { Conflict, DomainError, Invalid, NotFound, Unauthorized, httpStatusOf } from '../src/errors.js';

describe('errors', () => {
  it('carry HTTP statuses and their class names', () => {
    expect(new DomainError('x').status).toBe(400);
    expect(new Invalid('x').status).toBe(400);
    expect(new Unauthorized('x').status).toBe(401);
    expect(new NotFound('x').status).toBe(404);
    expect(new Conflict('x').status).toBe(409);
    expect(new Conflict('taken').name).toBe('Conflict');
    expect(new Conflict('taken')).toBeInstanceOf(DomainError);
  });

  it('maps unknown errors to 500', () => {
    expect(httpStatusOf(new NotFound('x'))).toBe(404);
    expect(httpStatusOf(new Error('boom'))).toBe(500);
  });
});
