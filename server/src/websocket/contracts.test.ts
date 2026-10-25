import { describe, expect, it } from "vitest";

import { parseIncomingMessage } from "./contracts.js";

describe("WebSocket message contracts", () => {
  it("parses valid room creation and join messages", () => {
    expect(parseIncomingMessage(JSON.stringify({
      type: "CREATE_ROOM",
      requestId: "r1",
      revealMode: "SINGLE_DEVICE",
      hostNickname: "Host",
    }))).toEqual({
      ok: true,
      message: {
        type: "CREATE_ROOM",
        requestId: "r1",
        revealMode: "SINGLE_DEVICE",
        hostNickname: "Host",
      },
    });

    expect(parseIncomingMessage({
      type: "JOIN_ROOM",
      requestId: "r2",
      roomCode: "ABCDEF",
      nickname: "Sam",
    })).toEqual({
      ok: true,
      message: { type: "JOIN_ROOM", requestId: "r2", roomCode: "ABCDEF", nickname: "Sam" },
    });
  });

  it("rejects malformed JSON, non-object payloads, and missing required fields", () => {
    expect(parseIncomingMessage("{bad json")).toMatchObject({
      ok: false,
      code: "MALFORMED_MESSAGE",
    });
    expect(parseIncomingMessage("[]")).toMatchObject({
      ok: false,
      code: "MALFORMED_MESSAGE",
    });
    expect(parseIncomingMessage({ type: "JOIN_ROOM", requestId: "x", roomCode: "ABCDEF" })).toMatchObject({
      ok: false,
      requestId: "x",
      code: "MALFORMED_MESSAGE",
    });
    expect(parseIncomingMessage({ type: "CREATE_ROOM", requestId: "x", revealMode: "OTHER", hostNickname: "Host" })).toMatchObject({
      ok: false,
      requestId: "x",
      code: "MALFORMED_MESSAGE",
    });
  });

  it("parses host lobby reorder requests and rejects malformed order payloads", () => {
    expect(parseIncomingMessage({
      type: "REORDER_PLAYERS",
      requestId: "order-1",
      playerIds: ["p1", "p2"],
    })).toEqual({
      ok: true,
      message: { type: "REORDER_PLAYERS", requestId: "order-1", playerIds: ["p1", "p2"] },
    });
    expect(parseIncomingMessage({
      type: "REORDER_PLAYERS",
      requestId: "order-over-100",
      playerIds: Array.from({ length: 101 }, (_, index) => `player-${index}`),
    })).toMatchObject({ ok: true });
    expect(parseIncomingMessage({
      type: "REORDER_PLAYERS",
      requestId: "order-2",
      playerIds: ["p1", 7],
    })).toMatchObject({ ok: false, requestId: "order-2", code: "MALFORMED_MESSAGE" });
  });

  it("parses start-game and subject-selection requests", () => {
    expect(parseIncomingMessage({ type: "START_GAME", requestId: "start-1" })).toEqual({
      ok: true,
      message: { type: "START_GAME", requestId: "start-1" },
    });
    expect(parseIncomingMessage({ type: "SET_SUBJECT", requestId: "subject-1", subject: "A topic" })).toEqual({
      ok: true,
      message: { type: "SET_SUBJECT", requestId: "subject-1", subject: "A topic" },
    });
    expect(parseIncomingMessage({ type: "SET_SUBJECT", requestId: "subject-2", subject: 12 })).toMatchObject({
      ok: false,
      requestId: "subject-2",
      code: "MALFORMED_MESSAGE",
    });
  });

  it("parses note batches without accepting client-supplied author or note IDs", () => {
    expect(parseIncomingMessage({
      type: "SUBMIT_NOTE_BATCH",
      requestId: "notes-1",
      notes: [{ targetPlayerId: "player-2", content: "Hello" }],
      authorPlayerId: "forged-author",
      isHost: true,
    })).toEqual({
      ok: true,
      message: {
        type: "SUBMIT_NOTE_BATCH",
        requestId: "notes-1",
        notes: [{ targetPlayerId: "player-2", content: "Hello" }],
      },
    });
    expect(parseIncomingMessage({
      type: "SUBMIT_NOTE_BATCH",
      requestId: "notes-2",
      notes: [{ targetPlayerId: "player-2", content: "  " + "x".repeat(1000) + "  " }],
    })).toMatchObject({ ok: true });
    expect(parseIncomingMessage({
      type: "SUBMIT_NOTE_BATCH",
      requestId: "notes-over-100",
      notes: Array.from({ length: 101 }, (_, index) => ({
        targetPlayerId: `player-${index}`,
        content: "Note",
      })),
    })).toMatchObject({ ok: true });

    expect(parseIncomingMessage({
      type: "SUBMIT_NOTE_BATCH",
      requestId: "notes-2-over-transport-limit",
      notes: [{ targetPlayerId: "player-2", content: "x".repeat(10_001) }],
    })).toMatchObject({ ok: false, requestId: "notes-2-over-transport-limit", code: "MALFORMED_MESSAGE" });
    expect(parseIncomingMessage({
      type: "SUBMIT_NOTE_BATCH",
      requestId: "notes-3",
      notes: [{ targetPlayerId: "player-2", content: "ok" }, { targetPlayerId: 5, content: "bad" }],
    })).toMatchObject({ ok: false, requestId: "notes-3", code: "MALFORMED_MESSAGE" });
  });

  it("parses reveal state and navigation requests without accepting client-controlled positions", () => {
    expect(parseIncomingMessage({ type: "GET_REVEAL_STATE", requestId: "reveal-read" })).toEqual({
      ok: true,
      message: { type: "GET_REVEAL_STATE", requestId: "reveal-read" },
    });
    expect(parseIncomingMessage({ type: "NAVIGATE_REVEAL", requestId: "reveal-next", action: "NEXT", position: 99 })).toEqual({
      ok: true,
      message: { type: "NAVIGATE_REVEAL", requestId: "reveal-next", action: "NEXT" },
    });
    expect(parseIncomingMessage({ type: "NAVIGATE_REVEAL", requestId: "reveal-bad", action: "JUMP" })).toMatchObject({
      ok: false,
      requestId: "reveal-bad",
      code: "MALFORMED_MESSAGE",
    });
  });

  it("parses round completion and host game lifecycle decisions", () => {
    expect(parseIncomingMessage({ type: "COMPLETE_ROUND", requestId: "complete-1" })).toEqual({
      ok: true, message: { type: "COMPLETE_ROUND", requestId: "complete-1" },
    });
    expect(parseIncomingMessage({ type: "START_NEXT_ROUND", requestId: "next-1" })).toEqual({
      ok: true, message: { type: "START_NEXT_ROUND", requestId: "next-1" },
    });
    expect(parseIncomingMessage({ type: "FINISH_GAME", requestId: "finish-1" })).toEqual({
      ok: true, message: { type: "FINISH_GAME", requestId: "finish-1" },
    });
  });

  it("rejects unsupported types consistently and bounds request IDs", () => {
    expect(parseIncomingMessage({ type: "DELETE_ROOM", requestId: "x" })).toMatchObject({
      ok: false,
      requestId: "x",
      code: "UNSUPPORTED_MESSAGE_TYPE",
    });
    expect(parseIncomingMessage({ type: "JOIN_ROOM", requestId: "x".repeat(129), roomCode: "ABCDEF", nickname: "Sam" })).toMatchObject({
      ok: false,
      code: "MALFORMED_MESSAGE",
    });
  });
});
