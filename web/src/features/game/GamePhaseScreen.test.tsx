import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameRoomView, RevealStateView, SubmissionProgressView } from "../connection/protocol";
import { GamePhaseScreen } from "./GamePhaseScreen";

afterEach(() => cleanup());

const room: GameRoomView = {
  roomCode: "ABCDEF",
  revealMode: "INDIVIDUAL_DEVICES",
  phase: "CHOOSING_SUBJECT",
  hostNickname: "Player 1",
  playerCount: 4,
  players: [
    { id: "p1", nickname: "Player 1" },
    { id: "p2", nickname: "Player 2" },
    { id: "p3", nickname: "Player 3" },
    { id: "p4", nickname: "Player 4" },
  ],
  currentRoundNumber: 1,
  currentSubjectSetterNickname: "Player 1",
  subject: null,
};

const progress: SubmissionProgressView = {
  roomCode: "ABCDEF",
  phase: "WRITING",
  roundNumber: 1,
  submittedCount: 1,
  totalPlayerCount: 4,
  viewerRole: "HOST",
  players: [
    { playerId: "p1", nickname: "Player 1", submitted: true },
    { playerId: "p2", nickname: "Player 2", submitted: false },
    { playerId: "p3", nickname: "Player 3", submitted: false },
    { playerId: "p4", nickname: "Player 4", submitted: false },
  ],
};

describe("GamePhaseScreen", () => {
  it("lets only the current subject setter submit a subject", async () => {
    const user = userEvent.setup();
    const onSetSubject = vi.fn().mockResolvedValue(undefined);
    render(
      <GamePhaseScreen
        room={room}
        nickname="Player 1"
        viewerRole="PLAYER"
        progress={null}
        revealState={null}
        busy={false}
        onSetSubject={onSetSubject}
        onSubmitBatch={vi.fn().mockResolvedValue(undefined)}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.type(screen.getByLabelText(/round subject/i), "A funny memory");
    await user.click(screen.getByRole("button", { name: /start writing/i }));

    await waitFor(() => expect(onSetSubject).toHaveBeenCalledWith("A funny memory"));
  });

  it("shows a waiting message to players who are not the subject setter", () => {
    render(
      <GamePhaseScreen
        room={room}
        nickname="Player 2"
        viewerRole="PLAYER"
        progress={null}
        revealState={null}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/waiting for Player 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/round subject/i)).not.toBeInTheDocument();
  });

  it("submits a complete batch with one note for each other player", async () => {
    const user = userEvent.setup();
    const onSubmitBatch = vi.fn().mockResolvedValue(undefined);
    const writingRoom: GameRoomView = {
      ...room,
      phase: "WRITING",
      subject: "A funny memory",
    };
    render(
      <GamePhaseScreen
        room={writingRoom}
        nickname="Player 1"
        viewerRole="PLAYER"
        progress={progress}
        revealState={null}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={onSubmitBatch}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.type(screen.getByLabelText(/note 1 for Player 2/i), "A great teammate");
    await user.type(screen.getByLabelText(/note 2 for Player 3/i), "Always makes us laugh");
    await user.type(screen.getByLabelText(/note 3 for Player 4/i), "A kind friend");
    await user.click(screen.getByRole("button", { name: /submit all notes/i }));

    await waitFor(() => expect(onSubmitBatch).toHaveBeenCalledWith([
      { targetPlayerId: "p2", content: "A great teammate" },
      { targetPlayerId: "p3", content: "Always makes us laugh" },
      { targetPlayerId: "p4", content: "A kind friend" },
    ]));
    expect(await screen.findByText(/your notes are in/i)).toBeInTheDocument();
  });

  it("requires every note before enabling batch submission", () => {
    render(
      <GamePhaseScreen
        room={{ ...room, phase: "WRITING", subject: "A funny memory" }}
        nickname="Player 1"
        viewerRole="PLAYER"
        progress={null}
        revealState={null}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: /submit all notes/i })).toBeDisabled();
  });

  it("shows the note and recipient on the SINGLE_DEVICE host display", () => {
    const revealState: RevealStateView = {
      roomCode: "ABCDEF",
      revealMode: "SINGLE_DEVICE",
      phase: "REVEALING",
      position: 0,
      total: 3,
      displayNote: { content: "A secret compliment", targetNickname: "Player 2" },
    };
    render(
      <GamePhaseScreen
        room={{ ...room, revealMode: "SINGLE_DEVICE", phase: "REVEALING" }}
        nickname="Host"
        viewerRole="HOST"
        progress={null}
        revealState={revealState}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("A secret compliment")).toBeInTheDocument();
    expect(screen.getByText("FOR Player 2")).toBeInTheDocument();
    const position = document.querySelector(".reveal-position strong")?.textContent ?? "";
    expect(position).toContain("1");
    expect(position).toContain("3");
  });

  it("shows note content only when the individual-device server projection includes it", () => {
    const revealState: RevealStateView = {
      roomCode: "ABCDEF",
      revealMode: "INDIVIDUAL_DEVICES",
      phase: "REVEALING",
      position: 1,
      total: 3,
      displayNote: { content: "Only the assigned reader sees this" },
    };
    const { rerender } = render(
      <GamePhaseScreen
        room={{ ...room, phase: "REVEALING" }}
        nickname="Player 2"
        viewerRole="PLAYER"
        progress={null}
        revealState={revealState}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Only the assigned reader sees this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next note/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /previous note/i })).not.toBeInTheDocument();

    rerender(
      <GamePhaseScreen
        room={{ ...room, phase: "REVEALING" }}
        nickname="Player 3"
        viewerRole="PLAYER"
        progress={null}
        revealState={{ ...revealState, displayNote: undefined }}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByText("Only the assigned reader sees this")).not.toBeInTheDocument();
    expect(screen.getByText("This note is for another reader.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /next note/i })).not.toBeInTheDocument();
  });

  it("lets the host navigate the reveal using server-authoritative actions", async () => {
    const user = userEvent.setup();
    const onNavigateReveal = vi.fn().mockResolvedValue(undefined);
    const revealState: RevealStateView = {
      roomCode: "ABCDEF",
      revealMode: "INDIVIDUAL_DEVICES",
      phase: "REVEALING",
      position: 0,
      total: 2,
      displayNote: { content: "Host is the assigned reader too" },
    };
    render(
      <GamePhaseScreen
        room={{ ...room, phase: "REVEALING" }}
        nickname="Player 1"
        viewerRole="HOST"
        progress={null}
        revealState={revealState}
        busy={false}
        onSetSubject={vi.fn()}
        onSubmitBatch={vi.fn()}
        onNavigateReveal={onNavigateReveal}
      />,
    );

    expect(screen.getByRole("button", { name: /previous note/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /next note/i }));
    expect(onNavigateReveal).toHaveBeenCalledWith("NEXT");
  });
});