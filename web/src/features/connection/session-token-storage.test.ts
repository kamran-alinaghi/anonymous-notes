import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserSessionTokenStorage } from "./session-token-storage";

describe("browser session token storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("persists the credential in localStorage so it survives closing a tab", () => {
    const storage = createBrowserSessionTokenStorage();
    storage.write("server-issued-token");

    expect(window.localStorage.getItem("anonymous-note.session-token")).toBe("server-issued-token");
    expect(storage.read()).toBe("server-issued-token");
  });

  it("migrates an existing sessionStorage credential to localStorage", () => {
    window.sessionStorage.setItem("anonymous-note.session-token", "legacy-token");

    const storage = createBrowserSessionTokenStorage();

    expect(storage.read()).toBe("legacy-token");
    expect(window.localStorage.getItem("anonymous-note.session-token")).toBe("legacy-token");
    expect(window.sessionStorage.getItem("anonymous-note.session-token")).toBeNull();
  });

  it("clears persistent and legacy credentials", () => {
    window.localStorage.setItem("anonymous-note.session-token", "persistent-token");
    window.sessionStorage.setItem("anonymous-note.session-token", "legacy-token");

    createBrowserSessionTokenStorage().clear();

    expect(window.localStorage.getItem("anonymous-note.session-token")).toBeNull();
    expect(window.sessionStorage.getItem("anonymous-note.session-token")).toBeNull();
  });
});
