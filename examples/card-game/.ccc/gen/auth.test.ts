import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { Auth, EmailTaken, InvalidCredentials } from './auth.js';

async function makeAuth(): Promise<Auth> {
  const db = pgliteDatabase();
  await db.exec(schemaSql);
  return new Auth(db);
}

function bearerRequest(token: string): Request {
  return new Request('http://example.test/resource', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('auth', () => {
  it('[ex 1] authenticates a bearer token from signup', async () => {
    const auth = await makeAuth();

    const session = await auth.signup('a@x.io', 'pw');
    expect(typeof session.token).toBe('string');
    expect(session.token.length).toBeGreaterThan(0);

    const identity = await auth.authenticate(bearerRequest(session.token));
    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe(session.userId);
  });

  it('[ex 2] rejects a signup with an email that differs only by case', async () => {
    const auth = await makeAuth();

    await auth.signup('a@x.io', 'pw');

    await expect(auth.signup('A@X.io', 'other')).rejects.toBeInstanceOf(EmailTaken);
  });

  it('[ex 3] logs in with a new token for the same user', async () => {
    const auth = await makeAuth();

    const signupSession = await auth.signup('a@x.io', 'pw');
    const loginSession = await auth.login('a@x.io', 'pw');

    expect(loginSession.token).not.toBe(signupSession.token);
    expect(loginSession.userId).toBe(signupSession.userId);
  });

  it('[ex 4] rejects a wrong password or an unknown email', async () => {
    const auth = await makeAuth();

    await auth.signup('a@x.io', 'pw');

    await expect(auth.login('a@x.io', 'wrong')).rejects.toBeInstanceOf(InvalidCredentials);
    await expect(auth.login('nobody@x.io', 'pw')).rejects.toBeInstanceOf(InvalidCredentials);
  });

  it('[ex 5] returns null for a missing or unknown bearer token', async () => {
    const auth = await makeAuth();

    const noHeader = new Request('http://example.test/resource');
    expect(await auth.authenticate(noHeader)).toBeNull();

    expect(await auth.authenticate(bearerRequest('nonsense'))).toBeNull();
  });
});
