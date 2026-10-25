import type { PlayerId, RoomId } from "../domain/types.js";

export type SessionRole = "UNASSIGNED" | "HOST" | "PLAYER";

export interface ConnectionSession {
  readonly connectionId: string;
  role: SessionRole;
  roomCode: string | null;
  roomId: RoomId | null;
  playerId: PlayerId | null;
  nickname: string | null;
}

export interface SessionConnection {
  send(data: string): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
}

export class ConnectionSessions {
  private readonly byConnectionId = new Map<string, { socket: SessionConnection; session: ConnectionSession }>();
  private readonly bySocket = new WeakMap<SessionConnection, ConnectionSession>();

  constructor(private readonly generateId: () => string) {}

  register(socket: SessionConnection): ConnectionSession {
    const session: ConnectionSession = {
      connectionId: this.generateId(),
      role: "UNASSIGNED",
      roomCode: null,
      roomId: null,
      playerId: null,
      nickname: null,
    };
    this.bySocket.set(socket, session);
    this.byConnectionId.set(session.connectionId, { socket, session });
    return session;
  }

  getForSocket(socket: SessionConnection): ConnectionSession | undefined {
    return this.bySocket.get(socket);
  }

  getByConnectionId(connectionId: string): ConnectionSession | undefined {
    return this.byConnectionId.get(connectionId)?.session;
  }

  bind(
    session: ConnectionSession,
    identity: Omit<ConnectionSession, "connectionId">,
  ): boolean {
    const registration = this.byConnectionId.get(session.connectionId);
    if (!registration || registration.session !== session || session.role !== "UNASSIGNED") return false;
    Object.assign(session, identity);
    return true;
  }

  unregister(socket: SessionConnection): void {
    const session = this.bySocket.get(socket);
    if (!session) return;
    const registration = this.byConnectionId.get(session.connectionId);
    // A stale close event cannot remove a newer registration.
    if (registration?.socket === socket && registration.session === session) {
      this.byConnectionId.delete(session.connectionId);
    }
    this.bySocket.delete(socket);
  }

  get size(): number {
    return this.byConnectionId.size;
  }
}
