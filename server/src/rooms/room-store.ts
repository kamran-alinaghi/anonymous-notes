import type { Room } from "../domain/types.js";

/** Storage contract for active rooms. Implementations must make each method atomic. */
export interface RoomStore {
  getByCode(code: string): Room | undefined;
  hasCode(code: string): boolean;
  createIfAbsent(room: Room): boolean;
  updateIfPresent(code: string, update: (current: Room) => Room | undefined): Room | undefined;
  remove(code: string): boolean;
}

function cloneRoom(room: Room): Room {
  return {
    ...room,
    host: { ...room.host },
    players: room.players.map((player) => ({ ...player })),
    rounds: room.rounds.map((round) => ({
      ...round,
      notes: round.notes.map((note) => ({ ...note })),
      revealSequence: round.revealSequence === null ? null : [...round.revealSequence],
      readerAssignments: round.readerAssignments.map((assignment) => ({ ...assignment })),
    })),
  } as Room;
}

/**
 * In-memory active-room storage. Methods are synchronous, so each operation
 * runs to completion before another JavaScript task can interleave.
 * Copies prevent callers from mutating stored state through returned objects.
 */
export class InMemoryRoomStore implements RoomStore {
  private readonly roomsByCode = new Map<string, Room>();

  getByCode(code: string): Room | undefined {
    const room = this.roomsByCode.get(code);
    return room === undefined ? undefined : cloneRoom(room);
  }

  hasCode(code: string): boolean {
    return this.roomsByCode.has(code);
  }

  createIfAbsent(room: Room): boolean {
    if (this.roomsByCode.has(room.code)) return false;
    this.roomsByCode.set(room.code, cloneRoom(room));
    return true;
  }

  updateIfPresent(code: string, update: (current: Room) => Room | undefined): Room | undefined {
    const current = this.roomsByCode.get(code);
    if (current === undefined) return undefined;

    // The callback operates on a copy. A thrown error or undefined result leaves
    // the original stored room unchanged.
    const proposed = update(cloneRoom(current));
    if (proposed === undefined) return undefined;
    if (proposed.code !== code) throw new Error("Room updates cannot change the room code.");
    this.roomsByCode.set(code, cloneRoom(proposed));
    return cloneRoom(proposed);
  }

  remove(code: string): boolean {
    return this.roomsByCode.delete(code);
  }
}
