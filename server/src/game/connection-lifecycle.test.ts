import { describe, expect, it } from "vitest";

import { ConnectionLifecycleService } from "./connection-lifecycle.js";
import type { GamePhase, Room } from "../domain/types.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";

type RevealMode = "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES";

function roomFixture(mode: RevealMode, phase: GamePhase): Room {
  const players = [
    { id: "player-1", nickname: "One" },
    { id: "player-2", nickname: "Two" },
    { id: "player-3", nickname: "Three" },
    { id: "player-4", nickname: "Four" },
  ];
  const host = mode === "SINGLE_DEVICE"
    ? { id: "host-1", nickname: "Host" }
    : players[0]!;
  return {
    id: "room-id",
    code: "ABCDEF",
    revealMode: mode,
    host,
    players: mode === "SINGLE_DEVICE" ? players : players,
    phase,
    rounds: [{
      id: "round-1",
      number: 1,
      subject: "A subject",
      notes: [{
        kind: "INTERNAL_NOTE",
        id: "note-1",
        authorPlayerId: "player-1",
        targetPlayerId: "player-2",
        content: "private",
      }],
      revealSequence: ["note-1"],
      revealIndex: 0,
      readerAssignments: [{ noteId: "note-1", readerPlayerId: "player-3" }],
    }],
    currentRoundId: "round-1",
    currentSubjectSetterPlayerId: "player-1",
    disconnectedPlayerIds: [],
    pausedPhase: null,
  } as Room;
}

describe("ConnectionLifecycleService", () => {
  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "tracks disconnected identities and preserves game state in %s mode",
    (mode) => {
      const initial = roomFixture(mode, "REVEALING");
      const store = new InMemoryRoomStore();
      store.createIfAbsent(initial);
      const service = new ConnectionLifecycleService(store);

      const first = service.markDisconnected("ABCDEF", "room-id", "player-2");
      const second = service.markDisconnected("ABCDEF", "room-id", "player-3");
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value.disconnectedPlayerIds).toEqual(["player-2", "player-3"]);
      expect(second.value.pausedPhase).toBe("REVEALING");
      expect(second.value.rounds[0]?.revealSequence).toEqual(["note-1"]);
      expect(second.value.rounds[0]?.readerAssignments).toEqual([{ noteId: "note-1", readerPlayerId: "player-3" }]);
      expect(second.value.rounds[0]?.revealIndex).toBe(0);

      const oneBack = service.markReconnected("ABCDEF", "room-id", "player-2");
      expect(oneBack.ok).toBe(true);
      if (oneBack.ok) {
        expect(oneBack.value.disconnectedPlayerIds).toEqual(["player-3"]);
        expect(oneBack.value.pausedPhase).toBe("REVEALING");
      }

      const allBack = service.markReconnected("ABCDEF", "room-id", "player-3");
      expect(allBack.ok).toBe(true);
      if (allBack.ok) {
        expect(allBack.value.disconnectedPlayerIds).toEqual([]);
        expect(allBack.value.pausedPhase).toBeNull();
        expect(allBack.value.phase).toBe("REVEALING");
        expect(allBack.value.rounds[0]?.revealSequence).toEqual(["note-1"]);
        expect(allBack.value.rounds[0]?.readerAssignments).toEqual([{ noteId: "note-1", readerPlayerId: "player-3" }]);
        expect(allBack.value.rounds[0]?.revealIndex).toBe(0);
      }
    },
  );

  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "pauses only progression phases in %s mode",
    (mode) => {
      const phases: GamePhase[] = ["LOBBY", "CHOOSING_SUBJECT", "WRITING", "REVEALING", "ROUND_COMPLETE", "FINISHED"];
      for (const phase of phases) {
        const store = new InMemoryRoomStore();
        store.createIfAbsent(roomFixture(mode, phase));
        const service = new ConnectionLifecycleService(store);
        const result = service.markDisconnected("ABCDEF", "room-id", "player-2");
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const shouldPause = ["CHOOSING_SUBJECT", "REVEALING", "ROUND_COMPLETE"].includes(phase);
        expect(result.value.pausedPhase !== null && result.value.pausedPhase !== undefined).toBe(shouldPause);
        expect(result.value.phase).toBe(phase);
        expect(result.value.disconnectedPlayerIds).toEqual(["player-2"]);
      }
    },
  );

  it("allows only the authenticated host to terminate while a player is disconnected", () => {
    const store = new InMemoryRoomStore();
    store.createIfAbsent(roomFixture("SINGLE_DEVICE", "CHOOSING_SUBJECT"));
    const service = new ConnectionLifecycleService(store);
    service.markDisconnected("ABCDEF", "room-id", "player-2");

    const unauthorized = service.terminateGame("ABCDEF", "not-the-host");
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(store.getByCode("ABCDEF")?.phase).toBe("CHOOSING_SUBJECT");

    const terminated = service.terminateGame("ABCDEF", "host-1");
    expect(terminated).toMatchObject({ ok: true, value: { phase: "FINISHED", pausedPhase: null } });
    expect(store.getByCode("ABCDEF")?.disconnectedPlayerIds).toEqual(["player-2"]);

    const duplicate = service.terminateGame("ABCDEF", "host-1");
    expect(duplicate).toMatchObject({ ok: false, error: { code: "ROOM_UNAVAILABLE" } });
  });

  it("rejects stale room identities and treats repeated disconnects idempotently", () => {
    const store = new InMemoryRoomStore();
    store.createIfAbsent(roomFixture("SINGLE_DEVICE", "WRITING"));
    const service = new ConnectionLifecycleService(store);

    expect(service.markDisconnected("ABCDEF", "old-room-id", "player-2"))
      .toMatchObject({ ok: false, error: { code: "STALE_SESSION" } });
    expect(service.markDisconnected("ABCDEF", "room-id", "player-2").ok).toBe(true);
    expect(service.markDisconnected("ABCDEF", "room-id", "player-2").ok).toBe(true);
    expect(store.getByCode("ABCDEF")?.disconnectedPlayerIds).toEqual(["player-2"]);
    expect(store.getByCode("ABCDEF")?.pausedPhase).toBeNull();
  });
});
