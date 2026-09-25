import {
  Game,
  HAND_SIZE,
  TableNotFull,
  AlreadyDealt,
  GameNotStarted,
  GameFinished,
  NotYourTurn,
  NotSeated,
} from './game.js';
import type { PlayResult } from './game.js';
import { card, beats, sameCard } from './card.js';
import type { Card } from './card.js';
import { Deck } from './game/deck.js';
import { CardNotInHand } from './game/player/hand.js';
import { userId } from './user.js';
import type { UserId } from './user.js';

const ALICE: UserId = userId('alice');
const BOB: UserId = userId('bob');
const CAROL: UserId = userId('carol');

function fullGame(): Game {
  const game = new Game('g1', 2, 7);
  game.players.join(ALICE);
  game.players.join(BOB);
  return game;
}

function dealtGame(): Game {
  const game = fullGame();
  game.deal();
  return game;
}

function firstCardOf(game: Game, user: UserId): Card {
  const hand = game.view(user).hand;
  const first = hand[0];
  if (first === undefined) throw new Error(`hand of ${user} is empty`);
  return first;
}

function currentPlayer(game: Game): UserId {
  const turn = game.turn();
  if (turn === null) throw new Error('no player to move');
  return turn;
}

describe('game', () => {
  it('[ex 1] a new game is waiting with no turn and a hand size of five', () => {
    const game = new Game('g1', 2, 7);

    expect(game.status()).toBe('waiting');
    expect(game.turn()).toBeNull();
    expect(HAND_SIZE).toBe(5);
  });

  it('[ex 2] deal gives every player five cards and starts play with the first joiner', () => {
    const game = new Game('g1', 2, 7);
    game.players.join(ALICE);
    game.players.join(BOB);

    game.deal();

    for (const player of game.players.all()) {
      expect(player.hand.size()).toBe(5);
    }
    expect(game.status()).toBe('playing');
    expect(game.turn()).toBe(ALICE);
  });

  it('[ex 3] deal rejects an incomplete table and a second deal', () => {
    const partial = new Game('g1', 2, 7);
    partial.players.join(ALICE);

    expect(() => partial.deal()).toThrow(TableNotFull);

    const dealt = dealtGame();

    expect(() => dealt.deal()).toThrow(AlreadyDealt);
  });

  it('[ex 4] play rejects an undealt game, the wrong player, and an unseated user', () => {
    const waiting = fullGame();

    expect(() => waiting.play(ALICE, card('A', '♠'))).toThrow(GameNotStarted);

    const game = dealtGame();
    const mover = currentPlayer(game);
    const other = mover === ALICE ? BOB : ALICE;

    expect(() => game.play(other, firstCardOf(game, other))).toThrow(NotYourTurn);
    expect(() => game.play(CAROL, card('A', '♠'))).toThrow(NotSeated);
  });

  it('[ex 5] play rejects a card the player does not hold', () => {
    const game = dealtGame();
    const mover = currentPlayer(game);
    const hand = game.view(mover).hand;
    const missing = Deck.standard()
      .cards()
      .find((candidate) => !hand.some((held) => sameCard(held, candidate)));
    if (missing === undefined) throw new Error('every card is in hand');

    expect(() => game.play(mover, missing)).toThrow(CardNotInHand);
  });

  it('[ex 6] the stronger card takes the trick, scores a point, and leads next', () => {
    const game = dealtGame();
    const first = currentPlayer(game);
    const firstCard = firstCardOf(game, first);
    game.play(first, firstCard);

    const second = currentPlayer(game);
    const secondCard = firstCardOf(game, second);
    const result = game.play(second, secondCard);

    const expectedWinner = beats(firstCard, secondCard) ? first : second;
    const loser = expectedWinner === first ? second : first;

    expect(result.trickComplete).toBe(true);
    expect(result.trickWinner).toBe(expectedWinner);

    const view = game.view(first);
    const winnerView = view.players.find((p) => p.userId === expectedWinner);
    const loserView = view.players.find((p) => p.userId === loser);
    expect(winnerView?.points).toBe(1);
    expect(loserView?.points).toBe(0);
    expect(view.table).toEqual([]);
    expect(game.turn()).toBe(expectedWinner);
  });

  it('[ex 7] after five tricks the game is finished and the top scorer wins', () => {
    const game = dealtGame();

    let last: PlayResult | null = null;
    for (let i = 0; i < 2 * HAND_SIZE; i++) {
      const mover = currentPlayer(game);
      last = game.play(mover, firstCardOf(game, mover));
    }
    if (last === null) throw new Error('no plays were made');

    expect(game.status()).toBe('finished');

    const players = game.view(ALICE).players;
    const best = players.reduce((leader, player) =>
      player.points > leader.points ? player : leader,
    );
    expect(game.winner()).toBe(best.userId);
    expect(last.finished).toBe(true);
    expect(last.winner).toBe(best.userId);

    expect(() => game.play(ALICE, card('A', '♠'))).toThrow(GameFinished);
  });

  it('[ex 8] a game restored from its state shows the same views', () => {
    const game = dealtGame();
    const mover = currentPlayer(game);
    game.play(mover, firstCardOf(game, mover));

    const restored = Game.fromState(game.toState());

    expect(restored.view(ALICE)).toEqual(game.view(ALICE));
    expect(restored.view(BOB)).toEqual(game.view(BOB));
  });

  it('[ex 9] a player sees their own hand and both players as counts', () => {
    const game = dealtGame();
    const alice = game.players.byUser(ALICE);
    if (alice === undefined) throw new Error('alice is not seated');

    const view = game.view(ALICE);

    expect(view.hand).toEqual(alice.hand.cards());
    expect(view.hand).toHaveLength(5);
    expect(view.players).toEqual([
      { userId: ALICE, cards: 5, points: 0 },
      { userId: BOB, cards: 5, points: 0 },
    ]);
  });

  it('[ex 10] an unseated viewer of a new game sees nothing', () => {
    const game = new Game('g1', 2, 7);

    const view = game.view(CAROL);

    expect(view.hand).toEqual([]);
    expect(view.players).toEqual([]);
    expect(view.turn).toBeNull();
    expect(view.status).toBe('waiting');
  });
});
