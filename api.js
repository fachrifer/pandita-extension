// api.js — Open WebUI API client for Pandita

const API = (() => {
  /**
   * Normalize provider-specific `content` shapes to a string (OpenAI string,
   * multimodal parts array, or nested objects from Gemini/LiteLLM proxies).
   */
  function contentChunkToString(content) {
    if (content == null || content === "") return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            if (typeof part.text === "string") return part.text;
            if (typeof part.content === "string") return part.content;
          }
          return "";
        })
        .join("");
    }
    if (typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  }

  /**
   * Extract one streaming text increment from an OpenAI-style chunk. Different
   * backends (Gemini, Anthropic via proxies, reasoning models) use different fields.
   */
  function extractStreamTextFromChunk(parsed) {
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) return "";

    const choice = choices[0];
    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      const fromContent = contentChunkToString(delta.content);
      if (fromContent) return fromContent;
      if (typeof delta.text === "string" && delta.text) return delta.text;
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content
      ) {
        return delta.reasoning_content;
      }
    }

    const msg = choice.message;
    if (msg && typeof msg === "object") {
      const fromMessage = contentChunkToString(msg.content);
      if (fromMessage) return fromMessage;
    }

    if (typeof choice.text === "string" && choice.text) return choice.text;

    return "";
  }

  /**
   * Stream a chat completion from Open WebUI.
   * Parses Server-Sent Events (SSE) and calls callbacks for each token.
   *
   * @param {Array} messages - Array of { role, content } message objects
   * @param {string} model - Model ID to use
   * @param {Function} onChunk - Called with (token, fullTextSoFar) for each token
   * @param {Function} onDone - Called with (fullText) when stream completes
   * @param {Function} onError - Called with (error) on failure
   * @returns {Function} abort - Call to cancel the stream
   */
  function streamCompletion(messages, model, onChunk, onDone, onError) {
    const controller = new AbortController();
    let fullText = "";

    (async () => {
      try {
        let effectiveModel =
          model && String(model).trim() ? String(model).trim() : "";
        if (!effectiveModel) {
          const sync = await chrome.storage.sync.get("defaultModel");
          effectiveModel = (sync.defaultModel && String(sync.defaultModel).trim()) || "";
        }
        if (!effectiveModel) {
          onError(
            new Error("No model selected. Choose a model in the extension header.")
          );
          return;
        }

        let headers;
        try {
          headers = await Auth.getAuthHeaders();
        } catch (err) {
          onError(new Error("Authentication required. Please sign in."));
          return;
        }

        const response = await fetch(`${CONFIG.BASE_URL}/api/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: effectiveModel,
            messages,
            stream: true,
          }),
        });

        if (response.status === 401) {
          await Auth.handle401();
          onError(new Error("Session expired. Please sign in again."));
          return;
        }

        if (!response.ok) {
          const errBody = await response.text().catch(() => "Unknown error");
          onError(new Error(`API error ${response.status}: ${errBody}`));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6); // Remove "data: "

            if (data === "[DONE]") {
              onDone(fullText);
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const token = extractStreamTextFromChunk(parsed);

              if (token) {
                fullText += token;
                onChunk(token, fullText);
              }
            } catch (parseErr) {
              // Skip malformed JSON lines
            }
          }
        }

        // Stream ended without [DONE] — treat as complete
        onDone(fullText);
      } catch (err) {
        if (err.name === "AbortError") {
          onDone(fullText);
          return;
        }
        onError(err);
      }
    })();

    // Return abort function
    return () => controller.abort();
  }

  /**
   * Fetch available models from Open WebUI.
   * Filters out hidden models.
   *
   * @returns {Promise<Array>} Array of model objects
   */
  async function fetchModels() {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("Authentication required to fetch models.");
    }

    const response = await fetch(`${CONFIG.BASE_URL}/api/models`, {
      method: "GET",
      headers,
    });

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();

    // The API may return { data: [...] } or just [...]
    let models = Array.isArray(data) ? data : data.data || [];

    // Filter out hidden models
    models = models.filter((m) => !m.hidden);

    return models;
  }

  /**
   * Check authentication by calling the auth endpoint.
   *
   * @returns {Promise<Object>} User info
   */
  async function checkAuth() {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("No authentication token found.");
    }

    const response = await fetch(`${CONFIG.BASE_URL}/api/v1/auths/`, {
      method: "GET",
      headers,
    });

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired.");
    }

    if (!response.ok) {
      throw new Error(`Auth check failed: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Fetch the user's pinned chats from Open WebUI.
   *
   * @returns {Promise<Array>} Array of { id, title, updated_at, created_at }
   */
  async function fetchPinnedChats() {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("Authentication required to fetch pinned chats.");
    }

    const response = await fetch(`${CONFIG.BASE_URL}/api/v1/chats/pinned`, {
      method: "GET",
      headers,
    });

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch pinned chats: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Fetch a paginated list of recent chats from Open WebUI.
   *
   * @param {number} page - Page number (1-based, 60 items per page)
   * @returns {Promise<Array>} Array of { id, title, updated_at, created_at }
   */
  async function fetchRecentChats(page = 1) {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("Authentication required to fetch recent chats.");
    }

    const response = await fetch(
      `${CONFIG.BASE_URL}/api/v1/chats/?page=${page}`,
      { method: "GET", headers }
    );

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch recent chats: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Fetch a single chat's full detail by ID.
   *
   * @param {string} id - Chat ID
   * @returns {Promise<Object>} Full ChatResponse object
   */
  async function fetchChatById(id) {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("Authentication required to fetch chat.");
    }

    const response = await fetch(`${CONFIG.BASE_URL}/api/v1/chats/${id}`, {
      method: "GET",
      headers,
    });

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch chat: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Update a chat on the server (merges into existing chat object).
   *
   * @param {string} id - Chat ID
   * @param {Object} chatPayload - The chat data to merge
   * @returns {Promise<Object>} Updated ChatResponse
   */
  async function updateChatById(id, chatPayload) {
    let headers;
    try {
      headers = await Auth.getAuthHeaders();
    } catch (err) {
      throw new Error("Authentication required to update chat.");
    }

    const response = await fetch(`${CONFIG.BASE_URL}/api/v1/chats/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ chat: chatPayload }),
    });

    if (response.status === 401) {
      await Auth.handle401();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(`Failed to update chat: ${response.status}`);
    }

    return await response.json();
  }

  return {
    streamCompletion,
    fetchModels,
    checkAuth,
    fetchPinnedChats,
    fetchRecentChats,
    fetchChatById,
    updateChatById,
  };
})();
