import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { createApp } from './server.js';
import { Auth, type Session } from './auth.js';
import type { Card } from './card.js';
import type { GameView, PlayResult } from './game.js';
import { createHandler } from './game-api.js';

// The endpoint under test is wired into the app by name; keep an explicit
// reference to the module under test so the import is not elided.
void createHandler;

type App = Awaited<ReturnType<typeof createApp>>;

interface PlayBody {
  readonly result: PlayResult;
  readonly view: GameView;
}

interface Harness {
  readonly app: App;
  readonly auth: Auth;
}

async function setup(): Promise<Harness> {
  const db = await pgliteDatabase();
  await db.exec(schemaSql);
  const app = await createApp(db, { endpoints: ['game-api'] });
  const auth = new Auth(db);
  return { app, auth };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function postGames(
  app: App,
  seats: number,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = token === undefined
    ? { 'Content-Type': 'application/json' }
    : authHeaders(token);
  return await app(
    new Request('http://test/games', {
      method: 'POST',
      headers,
      body: JSON.stringify({ seats }),
    }),
  );
}

async function createGame(
  app: App,
  token: string,
  seats: number,
): Promise<string> {
  const res = await postGames(app, seats, token);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function joinGame(
  app: App,
  token: string,
  id: string,
): Promise<Response> {
  return await app(
    new Request(`http://test/games/${id}/join`, {
      method: 'POST',
      headers: authHeaders(token),
    }),
  );
}

async function playCard(
  app: App,
  token: string,
  id: string,
  played: Card,
): Promise<Response> {
  return await app(
    new Request(`http://test/games/${id}/play`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ rank: played.rank, suit: played.suit }),
    }),
  );
}

async function getGame(
  app: App,
  token: string,
  id: string,
): Promise<Response> {
  return await app(
    new Request(`http://test/games/${id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function getView(
  app: App,
  token: string,
  id: string,
): Promise<GameView> {
  const res = await getGame(app, token, id);
  expect(res.status).toBe(200);
  return (await res.json()) as GameView;
}

/** Creates a 2-seat game that both users have joined, so it is playing. */
async function playingGame(
  app: App,
  a: Session,
  b: Session,
): Promise<string> {
  const id = await createGame(app, a.token, 2);
  const first = await joinGame(app, a.token, id);
  expect(first.status).toBe(200);
  const second = await joinGame(app, b.token, id);
  expect(second.status).toBe(200);
  return id;
}

describe('game-api', () => {
  it('[ex 1] rejects creating a game without a token', async () => {
    const { app } = await setup();

    const res = await postGames(app, 2);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('[ex 2] creates a waiting game with no players', async () => {
    const { app, auth } = await setup();
    const session = await auth.signup('creator@example.com', 'pw-creator');

    const created = await postGames(app, 2, session.token);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);

    const res = await getGame(app, session.token, body.id);
    expect(res.status).toBe(200);
    const view = (await res.json()) as GameView;
    expect(view.status).toBe('waiting');
    expect(view.players).toEqual([]);
  });

  it('[ex 3] deals when the second player joins a 2-seat game', async () => {
    const { app, auth } = await setup();
    const a = await auth.signup('a@example.com', 'pw-a');
    const b = await auth.signup('b@example.com', 'pw-b');

    const id = await createGame(app, a.token, 2);
    const first = await joinGame(app, a.token, id);
    expect(first.status).toBe(200);

    const second = await joinGame(app, b.token, id);
    expect(second.status).toBe(200);
    const view = (await second.json()) as GameView;
    expect(view.status).toBe('playing');
    expect(view.hand).toHaveLength(5);
  });

  it('[ex 4] rejects a third player joining a full 2-seat game', async () => {
    const { app, auth } = await setup();
    const a = await auth.signup('a@example.com', 'pw-a');
    const b = await auth.signup('b@example.com', 'pw-b');
    const c = await auth.signup('c@example.com', 'pw-c');

    const id = await playingGame(app, a, b);

    const res = await joinGame(app, c.token, id);
    expect(res.status).toBe(409);
  });

  it('[ex 5] rejects a play from the player whose turn it is not', async () => {
    const { app, auth } = await setup();
    const a = await auth.signup('a@example.com', 'pw-a');
    const b = await auth.signup('b@example.com', 'pw-b');

    const id = await playingGame(app, a, b);

    const viewA = await getView(app, a.token, id);
    const waiting = viewA.turn === a.userId ? b : a;
    const waitingView = waiting === a ? viewA : await getView(app, b.token, id);
    const card = waitingView.hand[0];
    expect(card).toBeDefined();

    const res = await playCard(app, waiting.token, id, card);
    expect(res.status).toBe(409);
  });

  it('[ex 6] accepts the first card from the player whose turn it is', async () => {
    const { app, auth } = await setup();
    const a = await auth.signup('a@example.com', 'pw-a');
    const b = await auth.signup('b@example.com', 'pw-b');

    const id = await playingGame(app, a, b);

    const viewA = await getView(app, a.token, id);
    const mover = viewA.turn === a.userId ? a : b;
    const moverView = mover === a ? viewA : await getView(app, b.token, id);
    const card = moverView.hand[0];
    expect(card).toBeDefined();

    const res = await playCard(app, mover.token, id, card);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlayBody;
    expect(body.result.trickComplete).toBe(false);
    expect(body.view.table.map((play) => play.card)).toContainEqual({
      rank: card.rank,
      suit: card.suit,
    });
  });

  it('[ex 7] finishes the game with a winner after every card is played', async () => {
    const { app, auth } = await setup();
    const a = await auth.signup('a@example.com', 'pw-a');
    const b = await auth.signup('b@example.com', 'pw-b');

    const id = await playingGame(app, a, b);

    let last: PlayBody | null = null;
    for (let i = 0; i < 10; i += 1) {
      const viewA = await getView(app, a.token, id);
      const mover = viewA.turn === a.userId ? a : b;
      const moverView = mover === a ? viewA : await getView(app, b.token, id);
      const card = moverView.hand[0];
      expect(card).toBeDefined();

      const res = await playCard(app, mover.token, id, card);
      expect(res.status).toBe(200);
      last = (await res.json()) as PlayBody;
    }

    expect(last).not.toBeNull();
    const final = last as PlayBody;
    expect(final.result.finished).toBe(true);
    expect(typeof final.result.winner).toBe('string');
  });

  it('[ex 8] returns 404 for an unknown game id', async () => {
    const { app, auth } = await setup();
    const session = await auth.signup('a@example.com', 'pw-a');

    const res = await getGame(app, session.token, 'unknown-id');

    expect(res.status).toBe(404);
  });
});
