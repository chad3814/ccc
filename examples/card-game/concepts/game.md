---
kind: aggregate
uses: [card, user]
interface: |
  export class TableNotFull extends Error {}
  export class AlreadyDealt extends Error {}
  export class GameNotStarted extends Error {}
  export class GameFinished extends Error {}
  export class NotYourTurn extends Error {}
  export class NotSeated extends Error {}
  export type GameStatus = 'waiting' | 'playing' | 'finished';
  export interface PlayResult {
    readonly trickComplete: boolean;
    readonly trickWinner: UserId | null;
    readonly finished: boolean;
    readonly winner: UserId | null;
  }
  export interface PlayerView {
    readonly userId: UserId;
    readonly cards: number;
    readonly points: number;
  }
  export interface TablePlay {
    readonly userId: UserId;
    readonly card: Card;
  }
  export interface GameView {
    readonly id: string;
    readonly seats: number;
    readonly status: GameStatus;
    readonly players: readonly PlayerView[];
    readonly hand: readonly Card[];
    readonly table: readonly TablePlay[];
    readonly turn: UserId | null;
    readonly winner: UserId | null;
  }
  export interface SeatState {
    readonly userId: string;
    readonly hand: readonly Card[];
    readonly points: number;
  }
  export interface PlayState {
    readonly userId: string;
    readonly card: Card;
  }
  export interface GameState {
    readonly id: string;
    readonly seats: number;
    readonly seed: number;
    readonly status: GameStatus;
    readonly deck: readonly Card[];
    readonly players: readonly SeatState[];
    readonly table: readonly PlayState[];
    readonly leader: number;
    readonly winner: string | null;
  }
  export const HAND_SIZE: number;
  export class Game {
    constructor(id: string, seats: number, seed: number);
    static fromState(state: GameState): Game;
    readonly id: string;
    readonly players: Players;
    status(): GameStatus;
    deal(): void;
    turn(): UserId | null;
    play(user: UserId, played: Card): PlayResult;
    winner(): UserId | null;
    view(viewer: UserId): GameView;
    toState(): GameState;
  }
---
## Intent
One table of High Card: players join, each is dealt a hand, and they play tricks until their hands are empty. Each trick goes to the strongest card, and the player who wins the most tricks wins the game.

## Rules
- A game starts "waiting". deal() needs every seat taken (else TableNotFull) and works once (else AlreadyDealt). It shuffles a standard deck with the game's seed (Deck.standard().shuffled(seed)), deals HAND_SIZE (5) cards to each player one at a time in seat order, and makes the game "playing" with the first-seated player leading.
- Within a trick, players play one card each in seat order, starting with the leader and wrapping around. Playing out of turn throws NotYourTurn; a user who isn't seated gets NotSeated; a card not in the player's hand throws CardNotInHand (from the hand).
- When every player has played, the card that beats all others (card.beats) wins the trick: its player scores a point, the table clears, and that player leads the next trick.
- When the last trick completes the game is "finished". The winner has the most points, and ties go to the earliest-seated player. Any play before dealing throws GameNotStarted; any play after the end throws GameFinished.
- view(viewer) shows only the viewer's own hand; other players appear as card counts and points. The table lists the current trick's plays in order.
- toState() captures everything needed to continue the game; fromState(toState()) restores an identical game. The leader field is the seat index of the current trick's leader.

## Examples
- a new Game("g1", 2, 7) → status() is "waiting", turn() is null, and HAND_SIZE is 5
- given a 2-seat game that two users joined through players.join, deal() → each player's hand holds 5 cards, status() is "playing", and turn() is the first user who joined
- deal() on a 2-seat game with one player → throws TableNotFull; deal() a second time → throws AlreadyDealt
- play() before dealing → throws GameNotStarted; play() by the player whose turn it isn't → throws NotYourTurn; play() by a user who isn't seated → throws NotSeated
- given a dealt game, play(the player whose turn it is, a card that isn't in their hand) → throws CardNotInHand
- given a dealt 2-player game, after both play a card from their hand, the player whose card beats the other's scores 1 point; the second play's result has trickComplete true and that trickWinner; the table is empty; and turn() is the trick winner
- given a dealt 2-player game, after 5 complete tricks (each player plays in turn), status() is "finished", winner() has the most points (the earlier-seated player on a tie), the final result has finished true with the same winner, and another play throws GameFinished
- Game.fromState(game.toState()) of a dealt game with one card played → view(each player) equals the original game's view(each player)
- view(first player) of a dealt game → hand lists the first player's 5 cards, and players lists both players with cards 5 and points 0

## Decisions
- Seeded shuffles keep games reproducible and testable; the endpoint picks a random seed per game.
- The trick winner leads the next trick, which is the common convention.
