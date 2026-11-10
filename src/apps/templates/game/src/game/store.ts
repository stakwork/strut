import { create } from "zustand";

// The game's state, in two kinds. What the HUD draws (phase, score, time,
// coins) lives in a zustand store: a component reads one field with a
// selector and re-renders only when that field changes. What changes every
// frame and nothing draws as React (the player's position) lives in `live`,
// a plain object the frame loop writes and anyone may read — never state,
// or every frame would re-render the page.

export type Phase = "ready" | "playing" | "over";
export interface Coin {
  id: number;
  position: [number, number, number];
}

export const ROUND_SECONDS = 45;
/** Half the platform's width: coins land inside it. */
export const ARENA = 9;
const COINS = 5;

let nextId = 1;
const coins = (n: number): Coin[] =>
  Array.from({ length: n }, () => ({
    id: nextId++,
    position: [(Math.random() * 2 - 1) * (ARENA - 1), 0.8, (Math.random() * 2 - 1) * (ARENA - 1)],
  }));

interface GameState {
  phase: Phase;
  score: number;
  timeLeft: number;
  coins: Coin[];
  start(): void;
  /** Take a coin; false when no round is on. */
  collect(id: number): boolean;
  /** The clock, once a frame. */
  tick(dt: number): void;
}

export const useGame = create<GameState>((set, get) => ({
  phase: "ready",
  score: 0,
  timeLeft: ROUND_SECONDS,
  coins: coins(COINS),
  start: () => set({ phase: "playing", score: 0, timeLeft: ROUND_SECONDS, coins: coins(COINS) }),
  collect: (id) => {
    const s = get();
    if (s.phase !== "playing" || !s.coins.some((c) => c.id === id)) return false;
    set({ score: s.score + 1, coins: [...s.coins.filter((c) => c.id !== id), ...coins(1)] });
    return true;
  },
  tick: (dt) => {
    const s = get();
    if (s.phase !== "playing") return;
    const timeLeft = Math.max(0, s.timeLeft - dt);
    set(timeLeft === 0 ? { timeLeft, phase: "over" } : { timeLeft });
  },
}));

/** Written by the frame loop, read by anyone; never rendered. */
export const live = { player: { x: 0, y: 0, z: 0 } };
