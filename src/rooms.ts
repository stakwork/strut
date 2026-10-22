/**
 * ROOMS (plans/chained-orchestrators.md §3): the callback contract — what a
 * run tells its host, `run.end` and `job.update` (specs/CALLBACKS.md) —
 * over a socket the CLIENT holds open, for a host that cannot be called: a
 * person's laptop behind NAT keeps one open to an org's strut and hears
 * the jobs it started there.
 *
 * A room is an ACTOR. Who joins is the gate's call (`GET /rooms`,
 * createStrut's `upgrade`); a launch's `callback: { room: true }` names the
 * launching actor's room, kept as `room:<actor>` where a URL would be
 * (callback.ts), so the stores and the jobs' inheritance carry it as they
 * carry a URL. Every open socket of the room gets each message; with none
 * open, a bounded queue holds them and the next join flushes it in order.
 * Not durable: the log is the record, and a client reconciles by reading
 * (`GET /jobs?mine=1`, `GET /jobs/:id`). One registry per data directory,
 * where the targets are kept.
 */

import { resolve } from "node:path";

/** Messages a room keeps while nobody is in it; the oldest go first. */
export const ROOM_QUEUE_MAX = 1000;
/** How often an open socket is pinged, so a proxy never closes it idle. */
export const ROOM_PING_MS = 30_000;

/** What a room needs of a socket — `ws`'s `WebSocket`. */
export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  ping?(): void;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface Rooms {
  /** Put a socket in the actor's room: what waited is sent to it first, in
   *  order; it leaves when it closes. */
  join(actor: string, socket: RoomSocket): void;
  /** Send `payload` (as JSON) to every open socket of the actor's room, or
   *  queue it when none is open. Never throws. */
  deliver(actor: string, payload: unknown): void;
  /** How many sockets are open in the actor's room. */
  open(actor: string): number;
}

const OPEN = 1;

interface Room {
  sockets: Set<RoomSocket>;
  queue: string[];
  dropped: number;
}

export function createRooms(max = ROOM_QUEUE_MAX): Rooms {
  const rooms = new Map<string, Room>();
  const roomOf = (actor: string): Room => {
    let room = rooms.get(actor);
    if (!room) rooms.set(actor, (room = { sockets: new Set(), queue: [], dropped: 0 }));
    return room;
  };
  const openIn = (room: Room) => [...room.sockets].filter((s) => s.readyState === OPEN);
  return {
    join(actor, socket) {
      const room = roomOf(actor);
      room.sockets.add(socket);
      const ping = socket.ping
        ? setInterval(() => {
            if (socket.readyState === OPEN) socket.ping!();
          }, ROOM_PING_MS)
        : undefined;
      ping?.unref?.();
      const leave = () => {
        clearInterval(ping);
        room.sockets.delete(socket);
        if (rooms.get(actor) === room && room.sockets.size === 0 && room.queue.length === 0) rooms.delete(actor);
      };
      socket.on("close", leave);
      socket.on("error", leave);
      if (room.dropped) console.warn(`[rooms] ${actor}: ${room.dropped} message(s) dropped while the room was empty`);
      room.dropped = 0;
      for (const msg of room.queue.splice(0)) socket.send(msg);
    },
    deliver(actor, payload) {
      const room = roomOf(actor);
      const msg = JSON.stringify(payload);
      const open = openIn(room);
      if (open.length) {
        for (const s of open) {
          try {
            s.send(msg);
          } catch (err) {
            console.warn(`[rooms] ${actor}: a send failed:`, (err as Error).message);
          }
        }
        return;
      }
      room.queue.push(msg);
      if (room.queue.length > max) room.dropped += room.queue.splice(0, room.queue.length - max).length;
    },
    open(actor) {
      const room = rooms.get(actor);
      return room ? openIn(room).length : 0;
    },
  };
}

const registries = new Map<string, Rooms>();

/** The rooms of the strut that keeps its callback targets under `dataDir`
 *  — created on first use, one per data directory in the process. */
export function roomsFor(dataDir: string): Rooms {
  const key = resolve(dataDir);
  let rooms = registries.get(key);
  if (!rooms) registries.set(key, (rooms = createRooms()));
  return rooms;
}
