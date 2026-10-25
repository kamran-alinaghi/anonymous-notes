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
      requestId: "order-2",
      playerIds: ["p1", 7],
    })).toMatchObject({ ok: false, requestId: "order-2", code: "MALFORMED_MESSAGE" });
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
