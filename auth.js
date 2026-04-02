// auth.js — SSO-only authentication manager for Pandita
// No email/password login — SSO is the only authentication method.
//
// KEY INSIGHT: Chrome extensions cannot send cookies from extension pages
// (side panel, options page) to third-party domains via fetch. The cookies
// belong to the Open WebUI domain, not the chrome-extension:// origin.
//
// Solution: After SSO login, we extract the JWT token from the Open WebUI
// tab's localStorage using chrome.scripting.executeScript, then store it
// in chrome.storage.local for use in all API calls via Authorization header.

const Auth = (() => {
  const TOKEN_KEY = "pandita_auth_token";
  const USER_KEY = "pandita_user";

  // ─── STORAGE HELPERS ──────────────────────────────────────────────────────

  async function getStoredToken() {
    const result = await chrome.storage.local.get(TOKEN_KEY);
    return result[TOKEN_KEY] || null;
  }

  async function storeToken(token) {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
  }

  async function storeUser(user) {
    await chrome.storage.local.set({ [USER_KEY]: user });
  }

  async function getStoredUser() {
    const result = await chrome.storage.local.get(USER_KEY);
    return result[USER_KEY] || null;
  }

  async function clearStorage() {
    await chrome.storage.local.remove([TOKEN_KEY, USER_KEY]);
  }

  // ─── TOKEN VALIDATION ─────────────────────────────────────────────────────

  /**
   * Validate a token by calling the auth API.
   * Uses Authorization header (NOT cookies — cookies don't work from extension origin).
   */
  async function validateToken(token) {
    try {
      const response = await fetch(`${CONFIG.BASE_URL}/api/v1/auths/`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (err) {
      console.warn("Pandita: token validation failed:", err.message);
      return null;
    }
  }

  // ─── CHECK SESSION ─────────────────────────────────────────────────────────

  /**
   * Check if we have a valid stored session.
   * Returns { authenticated: true, user } or { authenticated: false }
   */
  async function checkSession() {
    try {
      const token = await getStoredToken();
      if (!token) {
        return { authenticated: false };
      }

      const user = await validateToken(token);
      if (user) {
        await storeUser(user);
        return { authenticated: true, user };
      }

      // Token is invalid, clear it
      await clearStorage();
      return { authenticated: false };
    } catch (err) {
      console.error("Pandita: checkSession error:", err);
      return { authenticated: false };
    }
  }

  // ─── SSO LOGIN FLOW ────────────────────────────────────────────────────────

  /**
   * Open the SSO login page in a new Chrome tab.
   * Returns the tab ID so we can later extract the token from it.
   */
  async function openSSOLogin() {
    const tab = await chrome.tabs.create({ url: CONFIG.BASE_URL, active: true });
    return tab.id;
  }

  /**
   * Extract the JWT token from an Open WebUI tab's localStorage.
   * Open WebUI stores the token in localStorage under the key "token".
   * We use chrome.scripting.executeScript to read it from the tab.
   */
  async function extractTokenFromTab(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Open WebUI stores JWT in localStorage under "token"
          return localStorage.getItem("token");
        },
      });

      const token = results?.[0]?.result;
      return token || null;
    } catch (err) {
      // Tab may not be ready yet, or URL may have changed
      return null;
    }
  }

  /**
   * Poll for SSO session by checking the Open WebUI tab for a token.
   *
   * @param {number} ssoTabId - The tab ID where the SSO login was opened
   * @returns {Promise<Object>} Resolves with user data on success
   */
  async function pollForSession(ssoTabId) {
    let attempts = 0;
    const maxAttempts = CONFIG.AUTH_POLL_MAX_ATTEMPTS;
    const interval = CONFIG.AUTH_POLL_INTERVAL_MS;

    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        attempts++;

        try {
          // Try to extract token from the SSO tab
          const token = await extractTokenFromTab(ssoTabId);

          if (token) {
            // Validate the token
            const user = await validateToken(token);

            if (user) {
              clearInterval(timer);
              await storeToken(token);
              await storeUser(user);
              resolve(user);
              return;
            }
          }
        } catch (err) {
          // Continue polling
          console.warn("Pandita: poll attempt failed:", err.message);
        }

        if (attempts >= maxAttempts) {
          clearInterval(timer);
          reject(new Error("SSO login timed out. Please try again."));
        }
      }, interval);

      // Also listen for the tab being closed
      const tabRemovedListener = (closedTabId) => {
        if (closedTabId === ssoTabId) {
          // Tab was closed — give a few more seconds then check one last time
          chrome.tabs.onRemoved.removeListener(tabRemovedListener);
          // Don't stop polling immediately — the token may already be stored
        }
      };
      chrome.tabs.onRemoved.addListener(tabRemovedListener);
    });
  }

  // ─── LOGOUT ────────────────────────────────────────────────────────────────

  async function logout() {
    try {
      const token = await getStoredToken();
      if (token) {
        try {
          await fetch(`${CONFIG.BASE_URL}/api/v1/auths/signout`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (err) {
          // Ignore signout errors
        }
      }
    } catch (err) {
      // Ignore
    }

    await clearStorage();

    try {
      chrome.runtime.sendMessage({ type: "auth-expired" }).catch(() => {});
    } catch (err) {
      // Ignore if no listeners
    }
  }

  // ─── AUTH HEADERS ──────────────────────────────────────────────────────────

  /**
   * Get authorization headers for API calls.
   * All API calls MUST use the Authorization header (not cookies).
   */
  async function getAuthHeaders() {
    const token = await getStoredToken();
    if (!token) {
      throw new Error("AUTH_REQUIRED");
    }
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Handle 401 responses — clear token and broadcast auth-expired
   */
  async function handle401() {
    await clearStorage();
    try {
      chrome.runtime.sendMessage({ type: "auth-expired" }).catch(() => {});
    } catch (err) {
      // Ignore
    }
  }

  return {
    checkSession,
    openSSOLogin,
    pollForSession,
    extractTokenFromTab,
    validateToken,
    logout,
    getAuthHeaders,
    getStoredToken,
    getStoredUser,
    storeToken,
    storeUser,
    handle401,
    clearStorage,
  };
})();
