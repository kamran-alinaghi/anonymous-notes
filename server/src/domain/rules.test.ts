import { describe, expect, it, vi } from "vitest";

import {
  assignReaders,
  beginReveal,
  createRevealSequence,
  projectNoteForPlayer,
  setCurrentSubject,
  submitNoteBatch,
  transitionRoom,
  validateNickname,
  validateNoteBatch,
  validateRoom,
  validateRoomCode,
  validateSubject,
  type NoteDraft,
} from "./rules.js";
import type { Note, Player, Room, Round, SingleDeviceRoom } from "./types.js";

const players: Player[] = [
  { id: "p1", nickname: "Alex" },
  { id: "p2", nickname: "Blair" },
  { id: "p3", nickname: "Casey" },
  { id: "p4", nickname: "Drew" },
];

const round: Round = {
  id: "r1",
  number: 1,
  subject: null,
  notes: [],
  revealSequence: null,
  readerAssignments: [],
};

type RoomOverrides = Partial<Omit<SingleDeviceRoom, "revealMode" | "host">> & {
  revealMode?: Room["revealMode"];
  host?: Room["host"];
};

function makeRoom(overrides: RoomOverrides = {}): Room {
  const base: Room = {
    id: "room-1",
    code: "ABCDEF",
    phase: "CHOOSING_SUBJECT",
    revealMode: "SINGLE_DEVICE",
    host: { id: "host", nickname: "Moderator" },
    players: players.map((player) => ({ ...player })),
    rounds: [{ ...round, notes: [] }],
    currentRoundId: "r1",
    currentSubjectSetterPlayerId: "p1",
  };
  return { ...base, ...overrides } as Room;
}

function draftsFor(authorId: string, prefix = "n"): NoteDraft[] {
  return players
    .filter((player) => player.id !== authorId)
    .map((player, index) => ({
      id: `${prefix}-${index}`,
      targetPlayerId: player.id,
      content: `Message for ${player.nickname}`,
    }));
}

function withNotes(notes: Note[], phase: Room["phase"] = "REVEALING"): Room {
  return makeRoom({
    phase,
    rounds: [{ ...round, subject: "A topic", notes, revealSequence: null }],
  });
}

describe("room and identity validation", () => {
  it("accepts exactly six uppercase letters as room codes", () => {
    expect(validateRoomCode("ABCDEF").ok).toBe(true);
    for (const code of ["abcDEF", "ABCDE", "ABCDEFG", "ABC123", " ABCDE"]) {
      expect(validateRoomCode(code).ok).toBe(false);
    }
  });

  it("validates nickname boundaries", () => {
    expect(validateNickname("A").ok).toBe(true);
    expect(validateNickname("x".repeat(40)).ok).toBe(true);
    expect(validateNickname(" ").ok).toBe(false);
    expect(validateNickname("x".repeat(41)).ok).toBe(false);
  });

  it("requires at least four actual players and case-insensitively unique nicknames", () => {
    expect(validateRoom(makeRoom()).ok).toBe(true);
    expect(validateRoom(makeRoom({ players: players.slice(0, 3) })).ok).toBe(false);
    const duplicatePlayers = players.map((player) => ({ ...player }));
    duplicatePlayers[1] = { ...duplicatePlayers[1]!, nickname: "aLeX" };
    expect(validateRoom(makeRoom({ players: duplicatePlayers })).ok).toBe(false);
  });

  it("enforces reveal-mode host membership", () => {
    const room = makeRoom({ revealMode: "INDIVIDUAL_DEVICES", host: players[0]! });
    expect(validateRoom(room).ok).toBe(true);
    expect(validateRoom(makeRoom({ host: { id: "p1", nickname: "Alex" } })).ok).toBe(false);
  });
});

describe("subject setting", () => {
  it("accepts trimmed nonempty subjects up to 300 characters", () => {
    expect(validateSubject("Topic").ok).toBe(true);
    expect(validateSubject("x".repeat(300)).ok).toBe(true);
    expect(validateSubject("  Topic \\n")).toMatchObject({ ok: true, value: "Topic" });
    expect(validateSubject(" ".repeat(10) + "x".repeat(300) + " ".repeat(10)).toMatchObject({
      ok: true,
      value: "x".repeat(300),
    });
    expect(validateSubject(" ").ok).toBe(false);
    expect(validateSubject("x".repeat(301)).ok).toBe(false);
  });

  it("allows only the designated setter and does not mutate on rejection", () => {
    const room = makeRoom();
    const before = structuredClone(room);
    expect(setCurrentSubject(room, "p2", "Topic").ok).toBe(false);
    expect(room).toEqual(before);
    const result = setCurrentSubject(room, "p1", "Topic");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rounds[0]?.subject).toBe("Topic");
    expect(room.rounds[0]?.subject).toBeNull();
  });
});

describe("note batch validation and atomic submission", () => {
  const writingRoom = () => makeRoom({
    phase: "WRITING",
    rounds: [{ ...round, subject: "Topic", notes: [] }],
  });

  it("accepts one valid note for every other player", () => {
    const result = validateNoteBatch(writingRoom(), "p1", draftsFor("p1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value.every((note) => note.authorPlayerId === "p1")).toBe(true);
    }
  });

  it("rejects missing, duplicate, unknown, and self-targeted recipients", () => {
    const room = writingRoom();
    expect(validateNoteBatch(room, "p1", draftsFor("p1").slice(0, 2)).ok).toBe(false);

    const valid = draftsFor("p1");
    expect(validateNoteBatch(room, "p1", [valid[0]!, valid[0]!, valid[2]!]).ok).toBe(false);

    const unknown = draftsFor("p1");
    unknown[0] = { ...unknown[0]!, targetPlayerId: "ghost" };
    expect(validateNoteBatch(room, "p1", unknown).ok).toBe(false);

    const selfTarget = draftsFor("p1");
    selfTarget[0] = { ...selfTarget[0]!, targetPlayerId: "p1" };
    expect(validateNoteBatch(room, "p1", selfTarget).ok).toBe(false);
  });

  it("rejects empty and overlong notes and does not partially accept a batch", () => {
    const room = writingRoom();
    const invalid = draftsFor("p1");
    invalid[1] = { ...invalid[1]!, content: " ".repeat(1) };
    const before = structuredClone(room);
    expect(submitNoteBatch(room, "p1", invalid).ok).toBe(false);
    expect(room).toEqual(before);

    const tooLong = draftsFor("p1");
    tooLong[1] = { ...tooLong[1]!, content: "x".repeat(1001) };
    expect(validateNoteBatch(room, "p1", tooLong).ok).toBe(false);
  });

  it("trims note content before enforcing the 1–1000 character limit", () => {
    const room = writingRoom();
    const valid = draftsFor("p1");
    valid[0] = { ...valid[0]!, content: "  " + "x".repeat(1000) + "  \\n" };
    const first = submitNoteBatch(room, "p1", valid);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const stored = first.value.rounds[0]?.notes.find((note) => note.targetPlayerId === valid[0]!.targetPlayerId);
      expect(stored?.content).toBe("x".repeat(1000));
      expect(submitNoteBatch(first.value, "p1", draftsFor("p1", "again")).ok).toBe(false);
    }

    const tooLong = draftsFor("p1", "long");
    tooLong[0] = { ...tooLong[0]!, content: "  " + "x".repeat(1001) + "  " };
    expect(submitNoteBatch(room, "p1", tooLong).ok).toBe(false);
  });
});

describe("phase transitions", () => {
  it("allows valid transitions and rejects invalid ones without mutation", () => {
    const room = makeRoom({ phase: "LOBBY" });
    const before = structuredClone(room);
    expect(transitionRoom(room, "WRITING").ok).toBe(false);
    expect(room).toEqual(before);

    const start = transitionRoom(room, "CHOOSING_SUBJECT");
    expect(start.ok).toBe(true);
    if (start.ok) {
      const subjectRoom = setCurrentSubject(start.value, "p1", "Topic");
      expect(subjectRoom.ok).toBe(true);
      if (subjectRoom.ok) expect(transitionRoom(subjectRoom.value, "WRITING").ok).toBe(true);
    }
  });

  it("does not enter reveal until every actual player has submitted a full batch", () => {
    const room = makeRoom({ phase: "WRITING", rounds: [{ ...round, subject: "Topic", notes: [] }] });
    expect(transitionRoom(room, "REVEALING").ok).toBe(false);
    let filled = room;
    for (const player of players) {
      const result = submitNoteBatch(filled, player.id, draftsFor(player.id, player.id));
      expect(result.ok).toBe(true);
      if (result.ok) filled = result.value;
    }
    expect(transitionRoom(filled, "REVEALING").ok).toBe(true);
  });
});

describe("reveal sequence and privacy", () => {
  const notes: Note[] = [
    { kind: "INTERNAL_NOTE", id: "n1", authorPlayerId: "p1", targetPlayerId: "p2", content: "one" },
    { kind: "INTERNAL_NOTE", id: "n2", authorPlayerId: "p2", targetPlayerId: "p3", content: "two" },
    { kind: "INTERNAL_NOTE", id: "n3", authorPlayerId: "p3", targetPlayerId: "p4", content: "three" },
    { kind: "INTERNAL_NOTE", id: "n4", authorPlayerId: "p4", targetPlayerId: "p1", content: "four" },
  ];

  it("uses Fisher–Yates output and includes every note exactly once", () => {
    const sequence = createRevealSequence(notes, () => 0);
    expect(sequence).toEqual(["n2", "n3", "n4", "n1"]);
    expect([...sequence].sort()).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("stores reveal order once and preserves it during active reveal", () => {
    const room = withNotes(notes);
    const first = beginReveal(room, () => 0.1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const sequence = first.value.rounds[0]?.revealSequence;
    const random = vi.fn(() => 0.9);
    const second = beginReveal(first.value, random);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.rounds[0]?.revealSequence).toEqual(sequence);
    expect(random).not.toHaveBeenCalled();
  });

  it("projects notes without author or target fields", () => {
    const projection = projectNoteForPlayer(notes[0]!);
    expect(projection).toEqual({ kind: "PLAYER_FACING_NOTE", id: "n1", content: "one" });
    expect(projection).not.toHaveProperty("authorPlayerId");
    expect(projection).not.toHaveProperty("targetPlayerId");
  });
});

describe("reader assignment", () => {
  it("never assigns a note to its author or target and balances eligible readers", () => {
    const manyNotes: Note[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "INTERNAL_NOTE",
      id: `note-${index}`,
      authorPlayerId: players[index % 4]!.id,
      targetPlayerId: players[(index + 1) % 4]!.id,
      content: "content",
    }));
    const result = assignReaders(manyNotes, players, () => 0.25);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = new Map<string, number>();
    for (const assignment of result.value) {
      const note = manyNotes.find((item) => item.id === assignment.noteId)!;
      expect(assignment.readerPlayerId).not.toBe(note.authorPlayerId);
      expect(assignment.readerPlayerId).not.toBe(note.targetPlayerId);
      counts.set(assignment.readerPlayerId, (counts.get(assignment.readerPlayerId) ?? 0) + 1);
    }
    expect(result.value).toHaveLength(manyNotes.length);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
  });

  it("fails when no eligible reader exists", () => {
    const note: Note = {
      kind: "INTERNAL_NOTE",
      id: "n",
      authorPlayerId: "p1",
      targetPlayerId: "p2",
      content: "x",
    };
    expect(assignReaders([note], players.slice(0, 2), () => 0).ok).toBe(false);
  });
});
