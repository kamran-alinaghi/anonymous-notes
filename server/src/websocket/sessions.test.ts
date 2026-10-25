import { describe, expect, it } from "vitest";

import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";
import { WebSocketTransport } from "./transport.js";
import type { SessionConnection } from "./sessions.js";

class FakeSocket implements SessionConnection {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  lastMessage(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
  }
}

describe("connection session lifecycle", () => {
  it("registers server-managed sessions and safely unregisters on close", () => {
    const transport = new WebSocketTransport(
      new RoomManagementService(new InMemoryRoomStore()),
      () => "connection-1",
    );
    const socket = new FakeSocket();
    transport.attach(socket);

    expect(transport.sessions.size).toBe(1);
    expect(socket.lastMessage()).toEqual({ type: "CONNECTED", connectionId: "connection-1" });

    socket.emit("close");
    expect(transport.sessions.size).toBe(0);
  });

  it("returns a safe error if a connection has lost its session registration", () => {
    const transport = new WebSocketTransport(
      new RoomManagementService(new InMemoryRoomStore()),
      () => "connection-1",
    );
    const socket = new FakeSocket();
    transport.attach(socket);
    transport.sessions.unregister(socket);

    socket.emit("message", JSON.stringify({
      type: "CREATE_ROOM",
      requestId: "request-1",
      revealMode: "SINGLE_DEVICE",
      hostNickname: "Host",
    }));

    expect(socket.lastMessage()).toEqual({
      type: "ERROR",
      error: { code: "SESSION_NOT_FOUND", message: "Connection session is unavailable." },
    });
    expect(transport.sessions.size).toBe(0);
  });

  it("cleans up a registration when sending a response fails", () => {
    class BrokenSocket extends FakeSocket {
      override send(data: string): void {
        if (data.includes('"type":"CONNECTED"')) throw new Error("socket closed");
        super.send(data);
      }
    }
    const transport = new WebSocketTransport(
      new RoomManagementService(new InMemoryRoomStore()),
      () => "connection-1",
    );
    const socket = new BrokenSocket();
    transport.attach(socket);
    expect(transport.sessions.size).toBe(0);
  });
});
