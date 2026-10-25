
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  GAME_PHASES,
  REVEAL_MODES,
} from "./types.js";

import type {
  HostIdentity,
  IndividualDevicesRoom,
  Note,
  Player,
  PlayerFacingNote,
  SingleDeviceRoom,
} from "./types.js";

describe("Domain types", () => {
  it("defines exactly the allowed game phases", () => {
    expect(GAME_PHASES).toEqual([
      "LOBBY",
      "CHOOSING_SUBJECT",
      "WRITING",
      "REVEALING",
      "ROUND_COMPLETE",
      "FINISHED",
    ]);
  });

  it("defines exactly the allowed reveal modes", () => {
    expect(REVEAL_MODES).toEqual([
      "SINGLE_DEVICE",
      "INDIVIDUAL_DEVICES",
    ]);
  });

  it("represents host identity according to reveal mode", () => {
    expectTypeOf<SingleDeviceRoom["host"]>()
      .toEqualTypeOf<HostIdentity>();

    expectTypeOf<IndividualDevicesRoom["host"]>()
      .toEqualTypeOf<Player>();
  });

  it("keeps internal notes distinct from player-facing notes", () => {
    expectTypeOf<Note>()
      .not.toMatchTypeOf<PlayerFacingNote>();
  });
});

// Compile-time regression check: internal notes must not be
// assignable directly to the player-facing representation.
if (false) {
  const internalNote: Note = {
    kind: "INTERNAL_NOTE",
    id: "note-1",
    authorPlayerId: "player-1",
    targetPlayerId: "player-2",
    content: "Example note",
  };

  // @ts-expect-error Internal notes must not be exposed directly.
  const exposedNote: PlayerFacingNote = internalNote;

  void exposedNote;
}
