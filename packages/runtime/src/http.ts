import { httpStatusOf } from './errors.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Endpoints answer routes they don't own with unmatched(), so the
// composition root can try the next endpoint; a real 404 lacks the header.
export const UNMATCHED_HEADER = 'x-ccc-unmatched';

export function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function unmatched(): Response {
  return new Response('Not Found', { status: 404, headers: { [UNMATCHED_HEADER]: '1' } });
}

export function isUnmatched(response: Response): boolean {
  return response.status === 404 && response.headers.get(UNMATCHED_HEADER) === '1';
}

export function errorResponse(err: Error): Response {
  return json({ error: err.message }, httpStatusOf(err));
}
