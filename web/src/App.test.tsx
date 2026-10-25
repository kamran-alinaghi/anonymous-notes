import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("Anonymous Note app shell", () => {
  it("renders the product introduction and next-step status", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /anonymous note\./i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Game interface foundation is ready",
    );
    expect(screen.getByText(/room creation and joining are the next/i)).toBeInTheDocument();
  });
});