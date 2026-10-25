import { useCallback, useEffect, useState } from "react";

import {
  type GameRoomView,
  type PublicRoomView,
  type RevealMode,
  type ServerMessage,
  type SessionRestoredMessage,
} from "./features/connection/protocol";
import { WebSocketClient, type ConnectionSnapshot } from "./features/connection/websocket-client";
import "./styles.css";

type Screen = "home" | "create" | "join" | "lobby" | "game";

interface LobbyState {
  roomCode: string;
  revealMode: RevealMode;
  phase: string;
  hostNickname: string;
  playerCount: number;
  viewerRole: "HOST" | "PLAYER";
  players: Array<{ id: string; nickname: string }>;
  nickname: string;
}

function getWebSocketUrl(): string {
  const configured = (import.meta as ImportMeta & { env?: { VITE_WS_URL?: string } }).env?.VITE_WS_URL;
  if (configured) return configured;
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname || "localhost"}:3000/ws`;
}

function lobbyFromPublicRoom(
  room: PublicRoomView,
  nickname: string,
): LobbyState {
  return {
    roomCode: room.roomCode,
    revealMode: room.revealMode,
    phase: room.phase,
    hostNickname: room.hostNickname,
    playerCount: room.playerCount,
    viewerRole: room.viewerRole,
    players: room.players ?? [],
    nickname,
  };
}

function lobbyFromRestoredRoom(
  room: GameRoomView,
  role: "HOST" | "PLAYER",
  nickname: string,
): LobbyState {
  return {
    roomCode: room.roomCode,
    revealMode: room.revealMode,
    phase: room.phase,
    hostNickname: room.hostNickname,
    playerCount: room.playerCount,
    viewerRole: role,
    players: room.players,
    nickname,
  };
}

function isRoomMessage(message: ServerMessage): message is ServerMessage & {
  room: PublicRoomView;
  nickname: string;
} {
  return (message.type === "ROOM_CREATED" || message.type === "ROOM_JOINED") &&
    typeof message.room === "object" &&
    message.room !== null &&
    typeof message.nickname === "string";
}

export default function App({ client: suppliedClient }: { client?: WebSocketClient } = {}) {
  const [connection, setConnection] = useState<ConnectionSnapshot>({
    status: "idle",
    sessionStatus: "none",
    reconnectAttempt: 0,
    lastError: null,
  });
  const [client] = useState(() => suppliedClient ?? new WebSocketClient({
    url: getWebSocketUrl(),
    onStateChange: setConnection,
  }));
  const [screen, setScreen] = useState<Screen>("home");
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [revealMode, setRevealMode] = useState<RevealMode>("INDIVIDUAL_DEVICES");
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleMessage = useCallback((message: ServerMessage) => {
    if (isRoomMessage(message)) {
      setLobby(lobbyFromPublicRoom(message.room, message.nickname));
      setNickname(message.nickname);
      setScreen("lobby");
      setError(null);
      setNotice(message.type === "ROOM_CREATED" ? "Your room is ready to share." : "You joined the room.");
      return;
    }

    if (message.type === "LOBBY_UPDATED" && typeof message.room === "object" && message.room !== null) {
      const room = message.room as PublicRoomView;
      setLobby((current) => {
        if (!current || current.roomCode !== room.roomCode) return current;
        return {
          ...current,
          phase: room.phase,
          hostNickname: room.hostNickname,
          playerCount: room.playerCount,
          revealMode: room.revealMode,
          players: room.players ?? current.players,
        };
      });
      return;
    }

    if (message.type === "SESSION_RESTORED") {
      const restored = message as SessionRestoredMessage;
      setNickname(restored.nickname);
      if (restored.room.phase === "LOBBY") {
        setLobby(lobbyFromRestoredRoom(restored.room, restored.sessionRole, restored.nickname));
        setScreen("lobby");
        setError(null);
        setNotice("Your previous session was restored.");
      } else {
        setLobby(lobbyFromRestoredRoom(restored.room, restored.sessionRole, restored.nickname));
        setScreen("game");
        setError(null);
        setNotice("Your session was restored. This game phase will be available in the next frontend step.");
      }
      return;
    }

    if (message.type === "GAME_STARTED" && typeof message.room === "object" && message.room !== null) {
      setLobby((current) => {
        if (!current) return current;
        const room = message.room as GameRoomView;
        return {
          ...current,
          phase: room.phase,
          playerCount: room.playerCount,
          players: room.players,
        };
      });
      setScreen("game");
      setNotice("The game has started. The next game screen is coming in the next implementation step.");
      setError(null);
      return;
    }

    if (message.type === "PLAYER_ORDER_UPDATED" && typeof message.room === "object" && message.room !== null) {
      const room = message.room as PublicRoomView;
      setLobby((current) => current ? {
        ...current,
        phase: room.phase,
        playerCount: room.playerCount,
        players: room.players ?? current.players,
      } : current);
      setNotice("Player order updated.");
      setError(null);
      return;
    }

    if (message.type === "ERROR" && typeof message.error === "object" && message.error !== null) {
      const serverError = message.error as { message?: unknown };
      if (typeof serverError.message === "string") setError(serverError.message);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribe(handleMessage);
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [client, handleMessage]);

  const createRoom = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanNickname = nickname.trim();
    if (!cleanNickname) {
      setError("Enter a nickname to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.request({
        type: "CREATE_ROOM",
        revealMode,
        hostNickname: cleanNickname,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create the room.");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanNickname = nickname.trim();
    const cleanRoomCode = roomCode.trim().toUpperCase();
    if (!cleanNickname) {
      setError("Enter a nickname to continue.");
      return;
    }
    if (!/^[A-Z]{6}$/.test(cleanRoomCode)) {
      setError("Enter the six-letter room code.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.request({
        type: "JOIN_ROOM",
        roomCode: cleanRoomCode,
        nickname: cleanNickname,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not join the room.");
    } finally {
      setBusy(false);
    }
  };

  const startGame = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.request({ type: "START_GAME" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not start the game.");
    } finally {
      setBusy(false);
    }
  };

  const movePlayer = async (index: number, direction: -1 | 1) => {
    if (!lobby) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= lobby.players.length) return;
    const reordered = [...lobby.players];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.request({
        type: "REORDER_PLAYERS",
        playerIds: reordered.map((player) => player.id),
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not change the player order.");
    } finally {
      setBusy(false);
    }
  };

  const goHome = () => {
    setScreen("home");
    setError(null);
    setNotice(null);
    setNickname("");
    setRoomCode("");
  };

  const statusLabel: Record<ConnectionSnapshot["status"], string> = {
    idle: "Not connected",
    connecting: "Connecting to game server",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Connection lost",
    "session-expired": "Previous session expired",
    closed: "Disconnected",
  };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="top-bar">
        <button className="wordmark" onClick={goHome} type="button" aria-label="Anonymous Note home">
          <span className="brand-mark small-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Anonymous <strong>Note.</strong></span>
        </button>
        <div className="connection-indicator" role="status">
          <span className={`status-dot ${connection.status === "connected" ? "is-online" : ""}`} aria-hidden="true" />
          {statusLabel[connection.status]}
        </div>
      </header>

      <section className="welcome-panel interactive-panel" aria-labelledby="app-title">
        {screen === "home" && (
          <>
            <p className="eyebrow">A SOCIAL GAME OF SECRETS</p>
            <h1 id="app-title">Anonymous <span>Note.</span></h1>
            <p className="welcome-copy">A little mystery. A lot of fun. Write something unexpected, keep it anonymous, and see where the room takes you.</p>
            <div className="action-stack">
              <button className="primary-button" onClick={() => { setScreen("create"); setError(null); }}>Create a room <span aria-hidden="true">↗</span></button>
              <button className="secondary-button" onClick={() => { setScreen("join"); setError(null); }}>Join a room</button>
            </div>
            {connection.status !== "connected" && (
              <p className="subtle-copy">You need a connection to the game server before creating or joining a room.</p>
            )}
          </>
        )}

        {screen === "create" && (
          <>
            <button className="back-link" type="button" onClick={() => { setScreen("home"); setError(null); }}>← Back</button>
            <p className="eyebrow">NEW GAME</p>
            <h1 id="app-title">Create <span>a room.</span></h1>
            <p className="welcome-copy compact-copy">Choose how your group will reveal notes, then share the room code with everyone.</p>
            <form className="game-form" onSubmit={createRoom}>
              <label htmlFor="host-nickname">Your nickname</label>
              <input id="host-nickname" autoComplete="nickname" maxLength={256} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Enter a nickname" required />
              <fieldset className="choice-fieldset">
                <legend>Reveal mode</legend>
                <label className={`mode-option ${revealMode === "INDIVIDUAL_DEVICES" ? "selected" : ""}`}>
                  <input type="radio" name="reveal-mode" value="INDIVIDUAL_DEVICES" checked={revealMode === "INDIVIDUAL_DEVICES"} onChange={() => setRevealMode("INDIVIDUAL_DEVICES")} />
                  <span><strong>Individual devices</strong><small>Everyone follows reveals on their own device.</small></span>
                </label>
                <label className={`mode-option ${revealMode === "SINGLE_DEVICE" ? "selected" : ""}`}>
                  <input type="radio" name="reveal-mode" value="SINGLE_DEVICE" checked={revealMode === "SINGLE_DEVICE"} onChange={() => setRevealMode("SINGLE_DEVICE")} />
                  <span><strong>Single device</strong><small>Play together around one shared screen.</small></span>
                </label>
              </fieldset>
              <button className="primary-button" type="submit" disabled={busy || !client.isReady}>{busy ? "Creating room…" : "Create room"}</button>
            </form>
          </>
        )}

        {screen === "join" && (
          <>
            <button className="back-link" type="button" onClick={() => { setScreen("home"); setError(null); }}>← Back</button>
            <p className="eyebrow">JOIN YOUR GROUP</p>
            <h1 id="app-title">Enter <span>the room.</span></h1>
            <p className="welcome-copy compact-copy">Ask the host for the six-letter room code and join the game.</p>
            <form className="game-form" onSubmit={joinRoom}>
              <label htmlFor="room-code">Room code</label>
              <input id="room-code" className="room-code-input" autoCapitalize="characters" autoComplete="off" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-z]/gi, "").toUpperCase())} placeholder="ABCDEF" required />
              <label htmlFor="player-nickname">Your nickname</label>
              <input id="player-nickname" autoComplete="nickname" maxLength={256} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Enter a nickname" required />
              <button className="primary-button" type="submit" disabled={busy || !client.isReady}>{busy ? "Joining room…" : "Join room"}</button>
            </form>
          </>
        )}

        {screen === "lobby" && lobby && (
          <>
            <p className="eyebrow">ROOM LOBBY · {lobby.viewerRole === "HOST" ? "HOST" : "PLAYER"}</p>
            <h1 id="app-title">You’re <span>in.</span></h1>
            <p className="welcome-copy compact-copy">{lobby.viewerRole === "HOST" ? "Your room is ready. Invite everyone using this code." : `You joined ${lobby.hostNickname}’s room. Hang tight until the host starts the game.`}</p>
            <div className="room-code-card">
              <span>ROOM CODE</span>
              <strong>{lobby.roomCode}</strong>
              <button type="button" className="copy-code-button" onClick={() => {
                void navigator.clipboard?.writeText(lobby.roomCode).then(() => setNotice("Room code copied."), () => setError("Could not copy the room code. Select it to copy manually."));
              }}>Copy code</button>
            </div>
            <div className="lobby-summary">
              <div><span>Players</span><strong>{lobby.playerCount}</strong></div>
              <div><span>Reveal mode</span><strong>{lobby.revealMode === "SINGLE_DEVICE" ? "Single device" : "Individual devices"}</strong></div>
            </div>
            <div className="player-list">
              <div className="section-heading"><h2>Players</h2><span>{lobby.players.length} listed</span></div>
              {lobby.players.length > 0 ? lobby.players.map((player, index) => (
                <div className="player-row" key={player.id}>
                  <span className="player-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="player-name">{player.nickname}</span>
                  {lobby.viewerRole === "HOST" && (
                    <span className="reorder-controls">
                      <button type="button" aria-label={`Move ${player.nickname} up`} disabled={busy || index === 0} onClick={() => void movePlayer(index, -1)}>↑</button>
                      <button type="button" aria-label={`Move ${player.nickname} down`} disabled={busy || index === lobby.players.length - 1} onClick={() => void movePlayer(index, 1)}>↓</button>
                    </span>
                  )}
                </div>
              )) : (
                <p className="empty-players">{lobby.viewerRole === "HOST" ? "Share the room code to invite your players." : "The host’s player list will update as the lobby changes."}</p>
              )}
            </div>
            {lobby.viewerRole === "HOST" ? (
              <button className="primary-button lobby-start-button" type="button" disabled={busy || !client.isReady} onClick={() => void startGame()}>{busy ? "Please wait…" : "Start game"}</button>
            ) : (
              <div className="waiting-message"><span className="waiting-pulse" aria-hidden="true" />Waiting for the host to start the game</div>
            )}
          </>
        )}

        {screen === "game" && lobby && (
          <>
            <p className="eyebrow">GAME IN PROGRESS</p>
            <h1 id="app-title">The room <span>is live.</span></h1>
            <p className="welcome-copy compact-copy">{notice ?? `Room ${lobby.roomCode} has moved to the ${lobby.phase.toLowerCase().replaceAll("_", " ")} phase.`}</p>
            <div className="room-code-card"><span>ROOM CODE</span><strong>{lobby.roomCode}</strong></div>
            <p className="subtle-copy">The next frontend task will implement the subject-selection and writing screens.</p>
          </>
        )}

        {error && <p className="feedback-message error-message" role="alert">{error}</p>}
        {notice && screen !== "game" && <p className="feedback-message notice-message" role="status">{notice}</p>}
        {connection.lastError && connection.status !== "connected" && <p className="subtle-copy connection-detail">{connection.lastError}</p>}
      </section>

      <footer className="app-footer">Anonymous Note <span aria-hidden="true">·</span> Play together, stay anonymous</footer>
    </main>
  );
}
