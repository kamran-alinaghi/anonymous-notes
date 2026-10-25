const SESSION_TOKEN_KEY = "anonymous-note.session-token";

export interface SessionTokenStorage {
  read(): string | null;
  write(token: string): void;
  clear(): void;
}

/**
 * Stores only the server-issued reconnect credential for this browser tab.
 * Storage failures are handled without exposing the token or breaking play.
 */
export function createBrowserSessionTokenStorage(): SessionTokenStorage {
  return {
    read() {
      try {
        return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
      } catch {
        return null;
      }
    },
    write(token) {
      try {
        window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
      } catch {
        // The current connection can still work if storage is unavailable.
      }
    },
    clear() {
      try {
        window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
      } catch {
        // Storage may be unavailable in privacy-restricted browser contexts.
      }
    },
  };
}
