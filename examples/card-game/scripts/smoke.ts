// Plays one full game of High Card against the generated app, in-process on
// an in-memory database. Run after `ccc build`: pnpm smoke
import { pgliteDatabase } from '@ccc/runtime/pglite';
import { z } from 'zod';
import { createApp } from '../.ccc/gen/server.js';
import { schemaSql } from '../.ccc/gen/schema.js';

const session = z.object({ token: z.string(), userId: z.string() });
const created = z.object({ id: z.string() });
const cardShape = z.object({ rank: z.string(), suit: z.string() });
const view = z.object({
  id: z.string(),
  status: z.enum(['waiting', 'playing', 'finished']),
  hand: z.array(cardShape),
  turn: z.string().nullable(),
  winner: z.string().nullable(),
});
const played = z.object({
  result: z.object({ finished: z.boolean(), winner: z.string().nullable() }),
  view,
});
const standings = z.array(z.object({ userId: z.string(), wins: z.number() }));

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`smoke test failed: ${message}`);
  }
}

const db = pgliteDatabase();
await db.exec(schemaSql);
const app = await createApp(db);

async function call(method: string, path: string, token: string | null, body?: object) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await app(new Request(`http://smoke${path}`, init));
  const text = await response.text();
  console.log(`${method} ${path} → ${response.status}`);
  return { status: response.status, data: text === '' ? null : JSON.parse(text) };
}

const alice = session.parse((await call('POST', '/auth/signup', null, { email: 'alice@example.com', password: 'pw-a' })).data);
const bob = session.parse((await call('POST', '/auth/signup', null, { email: 'bob@example.com', password: 'pw-b' })).data);
const tokens = new Map([
  [alice.userId, alice.token],
  [bob.userId, bob.token],
]);

check((await call('POST', '/games', null, { seats: 2 })).status === 401, 'creating a game needs a token');
const game = await call('POST', '/games', alice.token, { seats: 2 });
check(game.status === 201, 'POST /games returns 201');
const { id } = created.parse(game.data);

check((await call('POST', `/games/${id}/join`, alice.token)).status === 200, 'alice joins');
const joined = await call('POST', `/games/${id}/join`, bob.token);
let state = view.parse(joined.data);
check(state.status === 'playing', 'the deal-on-full-table sync dealt when the table filled');
check(state.hand.length === 5, 'bob holds 5 cards');

let winner: string | null = null;
for (let move = 0; move < 10; move++) {
  const turn = state.turn;
  check(turn !== null, 'someone has the turn while playing');
  const token = tokens.get(turn ?? '') ?? '';
  const mine = view.parse((await call('GET', `/games/${id}`, token)).data);
  const card = mine.hand[0];
  check(card !== undefined, 'the player to move holds a card');
  const reply = played.parse((await call('POST', `/games/${id}/play`, token, card)).data);
  state = reply.view;
  if (reply.result.finished) {
    winner = reply.result.winner;
  }
}
check(state.status === 'finished', 'the game finished after 10 plays');
check(winner !== null, 'the game has a winner');

const board = standings.parse((await call('GET', '/leaderboard', null)).data);
check(
  board.some((row) => row.userId === winner && row.wins === 1),
  'the record-winner sync put the winner on the leaderboard',
);

console.log(`✓ smoke test passed: ${winner === alice.userId ? 'alice' : 'bob'} won`);
