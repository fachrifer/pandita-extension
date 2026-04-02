// background.js — Pandita service worker
// Handles context menus, action routing, message relay, and streaming.

importScripts("config.js", "auth.js", "api.js");

// ─── ACTION SYSTEM PROMPTS ─────────────────────────────────────────────────────

const ACTION_PROMPTS = {
  rewrite: {
    systemPrompt:
      "You are an expert editor. Rewrite the following text to improve clarity and flow. Return ONLY the rewritten text, no explanations.",
    inPlace: true,
  },
  "fix-grammar": {
    systemPrompt:
      "Fix all spelling and grammar errors in the following text. Return ONLY the corrected text, preserving the original meaning and tone.",
    inPlace: true,
  },
  "check-grammar": {
    systemPrompt:
      "Analyze the following text for grammar, spelling, and style issues. Provide detailed explanations and suggestions for each issue found.",
    inPlace: false,
  },
  expand: {
    systemPrompt:
      "Expand the following text by approximately 25%, adding more detail while maintaining the same tone and style. Return ONLY the expanded text.",
    inPlace: true,
  },
  shorten: {
    systemPrompt:
      "Condense the following text while preserving all key points. Aim for roughly 75% of the original length. Return ONLY the shortened text.",
    inPlace: true,
  },
  summarize: {
    systemPrompt:
      "Provide a concise, well-structured summary of the following text. Use bullet points for key takeaways.",
    inPlace: false,
  },
  "explain-page": {
    systemPrompt:
      "Provide a comprehensive summary and analysis of the following webpage content. Break it into sections: Overview, Key Points, and Notable Details.",
    inPlace: false,
  },
};

// ─── SIDE PANEL MESSAGING VIA STORAGE ────────────────────────────────────────────
// We use chrome.storage.local with a special key "pandita_pending_action" to pass
// messages from background to side panel. This is 100% reliable because:
// - chrome.storage persists across service worker restarts
// - The side panel reads it on init AND watches for changes via onChanged
// - No race conditions — data is there when the panel needs it

const PENDING_ACTION_KEY = "pandita_pending_action";

/**
 * Write a pending action for the side panel to pick up.
 */
async function sendToSidePanel(message) {
  await chrome.storage.local.set({
    [PENDING_ACTION_KEY]: {
      ...message,
      _timestamp: Date.now(), // ensure storage change fires even for same content
    },
  });
}

// ─── CONTEXT MENU CREATION ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Clear any stale pending actions
  chrome.storage.local.remove(PENDING_ACTION_KEY);

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pandita-selection",
      title: "Pandita",
      contexts: ["selection"],
    });

    const selectionItems = [
      { id: "summarize", title: "Summarize" },
      { id: "rewrite", title: "Rewrite" },
      { id: "check-grammar", title: "Check Grammar" },
      { id: "fix-grammar", title: "Fix Grammar" },
      { id: "expand", title: "Expand" },
      { id: "shorten", title: "Shorten" },
      { id: "chat", title: "Chat" },
    ];

    for (const item of selectionItems) {
      chrome.contextMenus.create({
        id: item.id,
        parentId: "pandita-selection",
        title: item.title,
        contexts: ["selection"],
      });
    }

    chrome.contextMenus.create({
      id: "pandita-page",
      title: "Pandita",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "summarize-page",
      parentId: "pandita-page",
      title: "Summarize",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "explain-page",
      parentId: "pandita-page",
      title: "Explain This Page",
      contexts: ["page"],
    });
  });
});

// ─── CONTEXT MENU CLICK HANDLER ─────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const actionId = info.menuItemId;
  const tabId = tab.id;

  try {
    // ── IMPORTANT ──────────────────────────────────────────────────────
    // chrome.sidePanel.open() requires an active user-gesture context.
    // Any preceding await (storage write, script injection, etc.) can
    // expire that context, causing open() to silently fail.
    // Therefore we ALWAYS open the side panel first, synchronously
    // within the click handler, before doing any async work.
    // ───────────────────────────────────────────────────────────────────
    await chrome.sidePanel.open({ tabId });

    if (actionId === "chat") {
      await sendToSidePanel({
        type: "init-chat",
        selectedText: info.selectionText || "",
        tabId,
      });
      return;
    }

    if (actionId === "explain-page" || actionId === "summarize-page") {
      let pageContent = "";
      let pageTitle = tab.title || "";
      let pageUrl = tab.url || "";

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            text: document.body.innerText.substring(0, 15000),
            title: document.title,
            url: location.href,
          }),
        });
        const result = results[0]?.result;
        if (result) {
          pageContent = result.text || "";
          pageTitle = result.title || pageTitle;
          pageUrl = result.url || pageUrl;
        }
      } catch (err) {
        pageContent = "Unable to read page content.";
      }

      const fullText = `Page Title: ${pageTitle}\nPage URL: ${pageUrl}\n\n${pageContent}`;

      await sendToSidePanel({
        type: "process-action",
        action: actionId === "summarize-page" ? "summarize" : "explain-page",
        text: fullText,
        tabId,
      });
      return;
    }

    const actionConfig = ACTION_PROMPTS[actionId];
    if (!actionConfig) return;

    const selectedText = info.selectionText || "";
    if (!selectedText.trim()) return;

    if (actionConfig.inPlace) {
      const settings = await chrome.storage.sync.get([
        "inPlaceEnabled",
        "defaultModel",
      ]);
      const inPlaceEnabled =
        settings.inPlaceEnabled !== undefined ? settings.inPlaceEnabled : true;
      const model = settings.defaultModel || "";

      if (!inPlaceEnabled || !model) {
        await sendToSidePanel({
          type: "process-action",
          action: actionId,
          text: selectedText,
          tabId,
        });
        return;
      }

      const messages = [
        { role: "system", content: actionConfig.systemPrompt },
        { role: "user", content: selectedText },
      ];

      API.streamCompletion(
        messages,
        model,
        () => {},
        async (fullText) => {
          try {
            const response = await chrome.tabs.sendMessage(tabId, {
              type: "replace-selection",
              newText: fullText,
            });
            if (!response || !response.success) {
              await sendToSidePanel({
                type: "show-result",
                text: fullText,
                action: actionId,
              });
            }
          } catch (err) {
            await sendToSidePanel({
              type: "show-result",
              text: fullText,
              action: actionId,
            });
          }
        },
        async (error) => {
          await sendToSidePanel({
            type: "show-result",
            text: `Error: ${error.message}`,
            action: actionId,
          });
        }
      );
    } else {
      await sendToSidePanel({
        type: "process-action",
        action: actionId,
        text: selectedText,
        tabId,
      });
    }
  } catch (err) {
    console.error("Pandita: context menu handler error:", err);
  }
});

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────────

const activeStreams = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "stream-chat") {
    const { messages, model, streamId } = message;

    if (streamId && activeStreams.has(streamId)) {
      activeStreams.get(streamId)();
      activeStreams.delete(streamId);
    }

    const abort = API.streamCompletion(
      messages,
      model,
      (token, fullText) => {
        chrome.runtime
          .sendMessage({ type: "stream-token", token, fullText, streamId })
          .catch(() => {});
      },
      (fullText) => {
        chrome.runtime
          .sendMessage({ type: "stream-done", fullText, streamId })
          .catch(() => {});
        if (streamId) activeStreams.delete(streamId);
      },
      (error) => {
        chrome.runtime
          .sendMessage({ type: "stream-error", error: error.message, streamId })
          .catch(() => {});
        if (streamId) activeStreams.delete(streamId);
      }
    );

    if (streamId) {
      activeStreams.set(streamId, abort);
    }

    sendResponse({ started: true });
    return true;
  }

  if (message.type === "abort-stream") {
    const { streamId } = message;
    if (streamId && activeStreams.has(streamId)) {
      activeStreams.get(streamId)();
      activeStreams.delete(streamId);
    }
    sendResponse({ aborted: true });
    return true;
  }

  if (message.type === "get-page-content") {
    const { tabId } = message;
    if (tabId) {
      chrome.tabs
        .sendMessage(tabId, { type: "get-page-content" })
        .then((response) => sendResponse(response))
        .catch(() => sendResponse(null));
      return true;
    }
    sendResponse(null);
    return true;
  }

  if (message.type === "scrape-active-page") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse(null); return; }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            text: document.body.innerText.substring(0, 15000),
            title: document.title,
            url: location.href,
          }),
        });
        const result = results[0]?.result;
        if (result) {
          sendResponse({
            content: `Page Title: ${result.title}\nPage URL: ${result.url}\n\n${result.text}`,
            title: result.title,
            url: result.url,
          });
        } else {
          sendResponse(null);
        }
      } catch (err) {
        sendResponse(null);
      }
    })();
    return true;
  }

  if (message.type === "get-selection") {
    const { tabId } = message;
    if (tabId) {
      chrome.tabs
        .sendMessage(tabId, { type: "get-selection" })
        .then((response) => sendResponse(response))
        .catch(() => sendResponse(null));
      return true;
    }
    sendResponse(null);
    return true;
  }

  if (message.type === "context-action") {
    const { action, selectedText, tabId } = message;
    const actionConfig = ACTION_PROMPTS[action];
    if (!actionConfig) return;

    (async () => {
      const senderTabId = tabId || sender.tab?.id;
      if (!senderTabId) return;

      if (actionConfig.inPlace) {
        const settings = await chrome.storage.sync.get([
          "inPlaceEnabled",
          "defaultModel",
        ]);
        const inPlaceEnabled =
          settings.inPlaceEnabled !== undefined
            ? settings.inPlaceEnabled
            : true;
        const model = settings.defaultModel || "";

        if (!inPlaceEnabled || !model) {
          await sendToSidePanel({
            type: "process-action",
            action,
            text: selectedText,
            tabId: senderTabId,
          });
          await chrome.sidePanel.open({ tabId: senderTabId });
          return;
        }

        const messages = [
          { role: "system", content: actionConfig.systemPrompt },
          { role: "user", content: selectedText },
        ];

        API.streamCompletion(
          messages,
          model,
          () => {},
          async (fullText) => {
            try {
              const response = await chrome.tabs.sendMessage(senderTabId, {
                type: "replace-selection",
                newText: fullText,
              });
              if (!response || !response.success) {
                await sendToSidePanel({
                  type: "show-result",
                  text: fullText,
                  action,
                });
                await chrome.sidePanel.open({ tabId: senderTabId });
              }
            } catch (err) {
              await sendToSidePanel({
                type: "show-result",
                text: fullText,
                action,
              });
              await chrome.sidePanel.open({ tabId: senderTabId });
            }
          },
          async (error) => {
            await sendToSidePanel({
              type: "show-result",
              text: `Error: ${error.message}`,
              action,
            });
            await chrome.sidePanel.open({ tabId: senderTabId });
          }
        );
      } else {
        await sendToSidePanel({
          type: "process-action",
          action,
          text: selectedText,
          tabId: senderTabId,
        });
        await chrome.sidePanel.open({ tabId: senderTabId });
      }
    })();

    return true;
  }

  if (message.type === "open-sidepanel") {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "start-sso-login") {
    (async () => {
      try {
        const tab = await chrome.tabs.create({
          url: CONFIG.BASE_URL,
          active: true,
        });
        const ssoTabId = tab.id;

        let attempts = 0;
        const maxAttempts = CONFIG.AUTH_POLL_MAX_ATTEMPTS;
        const interval = CONFIG.AUTH_POLL_INTERVAL_MS;

        const timer = setInterval(async () => {
          attempts++;

          try {
            let tabExists = true;
            try {
              await chrome.tabs.get(ssoTabId);
            } catch (e) {
              tabExists = false;
            }

            if (tabExists) {
              const results = await chrome.scripting.executeScript({
                target: { tabId: ssoTabId },
                func: () => localStorage.getItem("token"),
              });

              const token = results?.[0]?.result;

              if (token) {
                const response = await fetch(
                  `${CONFIG.BASE_URL}/api/v1/auths/`,
                  {
                    method: "GET",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                    },
                  }
                );

                if (response.ok) {
                  const user = await response.json();
                  clearInterval(timer);

                  await chrome.storage.local.set({
                    pandita_auth_token: token,
                    pandita_user: user,
                  });

                  chrome.runtime
                    .sendMessage({ type: "sso-login-success", user })
                    .catch(() => {});
                  return;
                }
              }
            }
          } catch (err) {
            // Continue polling
          }

          if (attempts >= maxAttempts) {
            clearInterval(timer);
            chrome.runtime
              .sendMessage({
                type: "sso-login-failed",
                error: "SSO login timed out. Please try again.",
              })
              .catch(() => {});
          }
        }, interval);
      } catch (err) {
        chrome.runtime
          .sendMessage({
            type: "sso-login-failed",
            error: err.message || "Failed to open SSO login.",
          })
          .catch(() => {});
      }
    })();

    sendResponse({ started: true });
    return true;
  }
});

// ─── EXTENSION ICON CLICK → OPEN SIDE PANEL ─────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error("Pandita: failed to open side panel:", err);
  }
});

// ─── PAGE / TAB CHANGE → RESET SIDE PANEL CONTEXT ───────────────────────────────
// Notify the side panel whenever the user switches tabs or navigates to a
// different page so it can clear stale conversation context.

function notifyPageChanged(url, title) {
  chrome.runtime
    .sendMessage({ type: "page-changed", url: url || "", title: title || "" })
    .catch(() => {}); // side panel may not be open
}

// User switched to a different tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    notifyPageChanged(tab.url, tab.title);
  } catch (_) {}
});

// User navigated within the same tab (new page load, not hash/anchor changes)
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only main frame, ignore sub-frames and anchors
  if (details.frameId !== 0) return;
  // Ignore in-page navigations (anchor links, pushState)
  const inPageTypes = ["auto_subframe", "manual_subframe", "reference_fragment"];
  if (inPageTypes.includes(details.transitionType)) return;

  // Tab URL is updated after commit, get fresh info
  chrome.tabs.get(details.tabId).then((tab) => {
    notifyPageChanged(tab.url, tab.title);
  }).catch(() => {});
});
