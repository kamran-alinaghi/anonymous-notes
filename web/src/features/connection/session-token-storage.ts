const SESSION_TOKEN_KEY = "anonymous-note.session-token";

export interface SessionTokenStorage {
  read(): string | null;
  write(token: string): void;
  clear(): void;
}

/**
 * Persists the server-issued reconnect credential across browser tabs and
 * browser restarts. Existing sessionStorage credentials are migrated once.
 * The token is a bearer credential; never log it or expose it in the UI.
 */
export function createBrowserSessionTokenStorage(): SessionTokenStorage {
  const getStorage = () => window.localStorage;
  const migrateLegacyToken = (): void => {
    try {
      const persistent = getStorage();
      if (persistent.getItem(SESSION_TOKEN_KEY)) return;
      const legacyToken = window.sessionStorage.getItem(SESSION_TOKEN_KEY);
      if (legacyToken) persistent.setItem(SESSION_TOKEN_KEY, legacyToken);
      window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  };

  return {
    read() {
      try {
        migrateLegacyToken();
        const token = getStorage().getItem(SESSION_TOKEN_KEY);
        if (token) return token;
      } catch {
        // Fall back to tab-scoped storage when persistent storage is blocked.
      }
      try {
        return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
      } catch {
        return null;
      }
    },
    write(token) {
      try {
        getStorage().setItem(SESSION_TOKEN_KEY, token);
        try { window.sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch { /* Ignore legacy cleanup failures. */ }
      } catch {
        try {
          window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
        } catch {
          // The current connection can still work if all browser storage is unavailable.
        }
      }
    },
    clear() {
      try {
        getStorage().removeItem(SESSION_TOKEN_KEY);
      } catch {
        // Storage may be unavailable in privacy-restricted browser contexts.
      }
      try {
        window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
      } catch {
        // Remove any legacy tab-scoped credential when possible.
      }
    },
  };
}
