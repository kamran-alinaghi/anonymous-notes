import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { GameRoomView, SubmissionProgressView } from "../connection/protocol";

interface GamePhaseScreenProps {
  room: GameRoomView;
  nickname: string;
  viewerRole: "HOST" | "PLAYER";
  progress: SubmissionProgressView | null;
  busy: boolean;
  onSetSubject: (subject: string) => Promise<void>;
  onSubmitBatch: (notes: Array<{ targetPlayerId: string; content: string }>) => Promise<void>;
}

export function GamePhaseScreen({
  room,
  nickname,
  viewerRole,
  progress,
  busy,
  onSetSubject,
  onSubmitBatch,
}: GamePhaseScreenProps) {
  const [subject, setSubject] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const isActualPlayer = viewerRole === "PLAYER" || room.revealMode === "INDIVIDUAL_DEVICES";
  const recipients = useMemo(
    () => room.players.filter((player) => player.nickname !== nickname),
    [room.players, nickname],
  );

  useEffect(() => {
    setSubject("");
    setDrafts({});
    setSubmitted(false);
    setLocalError(null);
  }, [room.currentRoundNumber]);

  useEffect(() => {
    if (room.phase === "WRITING") {
      setDrafts((current) => {
        const next: Record<string, string> = {};
        for (const player of recipients) next[player.id] = current[player.id] ?? "";
        return next;
      });
    }
  }, [room.phase, recipients]);

  const submitSubject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanSubject = subject.trim();
    if (!cleanSubject) {
      setLocalError("Enter a subject before continuing.");
      return;
    }
    setLocalError(null);
    try {
      await onSetSubject(cleanSubject);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not submit the subject.");
    }
  };

  const submitNotes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const notes = recipients.map((player) => ({
      targetPlayerId: player.id,
      content: (drafts[player.id] ?? "").trim(),
    }));
    if (notes.some((note) => !note.content)) {
      setLocalError("Write a note for every other player before submitting.");
      return;
    }
    setLocalError(null);
    try {
      await onSubmitBatch(notes);
      setSubmitted(true);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not submit your notes.");
    }
  };

  return (
    <>
      <p className="eyebrow">ROUND {room.currentRoundNumber} · {room.phase.replaceAll("_", " ")}</p>
      <h1 id="app-title">
        {room.phase === "CHOOSING_SUBJECT" ? <>Set the <span>subject.</span></> :
          room.phase === "WRITING" ? <>Write your <span>notes.</span></> :
            <>The game <span>continues.</span></>}
      </h1>

      {room.phase === "CHOOSING_SUBJECT" && (
        <>
          <p className="welcome-copy compact-copy">
            {room.currentSubjectSetterNickname === nickname
              ? "You choose the subject for this round. Keep it short, clear, and fun."
              : "The subject setter is choosing a prompt. You can start writing once it appears."}
          </p>
          {room.currentSubjectSetterNickname === nickname && (
            <form className="game-form" onSubmit={(event) => void submitSubject(event)}>
              <label htmlFor="round-subject">Round subject</label>
              <input
                id="round-subject"
                maxLength={300}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="e.g. The strangest thing I've ever seen"
                required
              />
              <p className="field-hint">{subject.length}/300 characters</p>
              <button className="primary-button" type="submit" disabled={busy || !subject.trim()}>
                {busy ? "Submitting subject…" : "Start writing"}
              </button>
            </form>
          )}
          {room.currentSubjectSetterNickname !== nickname && (
            <div className="waiting-message"><span className="waiting-pulse" aria-hidden="true" />Waiting for {room.currentSubjectSetterNickname ?? "the subject setter"}</div>
          )}
        </>
      )}

      {room.phase === "WRITING" && (
        <>
          <p className="welcome-copy compact-copy">Subject: <strong className="current-subject">{room.subject}</strong></p>
          {!isActualPlayer ? (
            <div className="waiting-message">You are hosting this shared-device game. Players submit notes from their own sessions.</div>
          ) : submitted ? (
            <div className="submission-confirmation" role="status">
              <strong>Your notes are in.</strong>
              <span>They are anonymous. You cannot edit them after submission.</span>
              <SubmissionProgress progress={progress} />
            </div>
          ) : (
            <form className="game-form notes-form" onSubmit={(event) => void submitNotes(event)}>
              <p className="subtle-copy notes-instruction">Write one anonymous note for every other player. Each note is private until the reveal.</p>
              {recipients.map((player, index) => (
                <div className="note-draft" key={player.id}>
                  <label htmlFor={"note-" + player.id}>Note {index + 1} <span>for {player.nickname}</span></label>
                  <textarea
                    id={"note-" + player.id}
                    maxLength={1000}
                    rows={3}
                    value={drafts[player.id] ?? ""}
                    onChange={(event) => setDrafts((current) => ({ ...current, [player.id]: event.target.value }))}
                    placeholder="Write something kind, funny, or unexpected…"
                    required
                  />
                  <span className="character-count">{(drafts[player.id] ?? "").length}/1000</span>
                </div>
              ))}
              <button
                className="primary-button"
                type="submit"
                disabled={busy || recipients.length === 0 || recipients.some((player) => !(drafts[player.id] ?? "").trim())}
              >
                {busy ? "Submitting notes…" : "Submit all notes"}
              </button>
              <p className="field-hint">All notes are submitted together. You cannot change them afterward.</p>
            </form>
          )}
          {!submitted && <SubmissionProgress progress={progress} />}
        </>
      )}

      {room.phase !== "CHOOSING_SUBJECT" && room.phase !== "WRITING" && (
        <>
          <p className="welcome-copy compact-copy">
            {room.phase === "REVEALING"
              ? "All notes have been submitted. The reveal screen is the next step."
              : room.phase === "ROUND_COMPLETE"
                ? "This round is complete. Waiting for the host to continue."
                : "This game has finished."}
          </p>
          <div className="room-code-card"><span>ROOM CODE</span><strong>{room.roomCode}</strong></div>
        </>
      )}

      {localError && <p className="feedback-message error-message" role="alert">{localError}</p>}
    </>
  );
}

function SubmissionProgress({ progress }: { progress: SubmissionProgressView | null }) {
  if (!progress) return null;
  return (
    <div className="submission-progress" aria-live="polite">
      <div className="section-heading">
        <h2>Submission progress</h2>
        <span>{progress.submittedCount} of {progress.totalPlayerCount}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label="Players who submitted notes" aria-valuemin={0} aria-valuemax={progress.totalPlayerCount} aria-valuenow={progress.submittedCount}>
        <span style={{ width: (progress.totalPlayerCount ? progress.submittedCount / progress.totalPlayerCount * 100 : 0) + "%" }} />
      </div>
      {progress.viewerRole === "HOST" && progress.players && (
        <ul className="submission-player-list">
          {progress.players.map((player) => (
            <li key={player.playerId}>
              <span>{player.nickname}</span>
              <span className={player.submitted ? "submission-state is-submitted" : "submission-state"}>
                {player.submitted ? "Submitted" : "Writing"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {progress.viewerRole === "PLAYER" && <p className="field-hint">Individual submission status stays private.</p>}
    </div>
  );
}
