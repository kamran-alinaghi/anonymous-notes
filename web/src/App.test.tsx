import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("Anonymous Note room entry", () => {
  it("shows the home screen with create and join actions", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /anonymous note\./i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create a room/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join a room/i })).toBeInTheDocument();
  });

  it("opens the create-room form and exposes both reveal modes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /create a room/i }));

    expect(screen.getByRole("heading", { name: /create a room\./i })).toBeInTheDocument();
    expect(screen.getByLabelText(/your nickname/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /individual devices/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /single device/i })).toBeInTheDocument();
  });

  it("opens the join-room form and normalizes the room code to uppercase letters", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /join a room/i }));
    const roomCode = screen.getByLabelText(/room code/i);
    await user.type(roomCode, "abcDEF");

    expect(roomCode).toHaveValue("ABCDEF");
    expect(screen.getByLabelText(/your nickname/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^join room$/i })).toBeDisabled();
  });

  it("returns to the home screen from a form", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /join a room/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByRole("heading", { name: /anonymous note\./i })).toBeInTheDocument();
  });
});
