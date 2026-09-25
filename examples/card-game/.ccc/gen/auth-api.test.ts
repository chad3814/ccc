import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { createApp } from './server.js';

interface SessionBody {
  readonly token: string;
  readonly userId: string;
}

interface ErrorBody {
  readonly error: string;
}

type App = (request: Request) => Promise<Response>;

async function makeApp(): Promise<App> {
  const db = pgliteDatabase();
  await db.exec(schemaSql);
  return await createApp(db, { endpoints: ['auth-api'] });
}

function post(app: App, path: string, body: unknown): Promise<Response> {
  return app(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readSession(response: Response): Promise<SessionBody> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('expected a JSON object body');
  }
  const { token, userId } = payload;
  if (typeof token !== 'string' || typeof userId !== 'string') {
    throw new Error(`expected token and userId strings, got ${JSON.stringify(payload)}`);
  }
  return { token, userId };
}

async function readError(response: Response): Promise<ErrorBody> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('expected a JSON object body');
  }
  const { error } = payload;
  if (typeof error !== 'string') {
    throw new Error(`expected an error string, got ${JSON.stringify(payload)}`);
  }
  return { error };
}

describe('auth-api', () => {
  it('[ex 1] signs up a new user with 201, a token and a userId', async () => {
    const app = await makeApp();

    const response = await post(app, '/auth/signup', { email: 'a@x.io', password: 'pw' });

    expect(response.status).toBe(201);
    const session = await readSession(response);
    expect(session.token.length).toBeGreaterThan(0);
    expect(session.userId.length).toBeGreaterThan(0);
  });

  it('[ex 2] rejects a second signup with the same email with 409', async () => {
    const app = await makeApp();

    const first = await post(app, '/auth/signup', { email: 'a@x.io', password: 'pw' });
    expect(first.status).toBe(201);
    await readSession(first);

    const second = await post(app, '/auth/signup', { email: 'a@x.io', password: 'pw' });

    expect(second.status).toBe(409);
    const body = await readError(second);
    expect(typeof body.error).toBe('string');
  });

  it('[ex 3] logs in with the signed-up credentials and rejects a wrong password', async () => {
    const app = await makeApp();

    const signup = await post(app, '/auth/signup', { email: 'a@x.io', password: 'pw' });
    expect(signup.status).toBe(201);
    const created = await readSession(signup);

    const ok = await post(app, '/auth/login', { email: 'a@x.io', password: 'pw' });
    expect(ok.status).toBe(200);
    const session = await readSession(ok);
    expect(session.userId).toBe(created.userId);

    const wrong = await post(app, '/auth/login', { email: 'a@x.io', password: 'nope' });
    expect(wrong.status).toBe(401);
    const body = await readError(wrong);
    expect(typeof body.error).toBe('string');
  });

  it('[ex 4] rejects a signup body without a password with 400', async () => {
    const app = await makeApp();

    const response = await post(app, '/auth/signup', { email: 'a@x.io' });

    expect(response.status).toBe(400);
    const body = await readError(response);
    expect(typeof body.error).toBe('string');
  });
});
