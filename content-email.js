// content-email.js — Gmail & Outlook integration for Pandita
// Shows a floating Pandita toolbar when text is selected anywhere on the page.
// Works on mail.google.com, outlook.office.com, outlook.live.com.

(() => {
  if (window.__panditaEmailLoaded) return;
  window.__panditaEmailLoaded = true;

  const PANDITA_ACTIONS = [
    { id: "rewrite", label: "Rewrite" },
    { id: "fix-grammar", label: "Fix Grammar" },
    { id: "check-grammar", label: "Check Grammar" },
    { id: "expand", label: "Expand" },
    { id: "shorten", label: "Shorten" },
    { id: "summarize", label: "Summarize" },
    { id: "chat", label: "Chat" },
  ];

  // ─── FLOATING TOOLBAR ─────────────────────────────────────────────────────

  let toolbar = null;
  let hideTimeout = null;

  function createToolbar() {
    if (toolbar) return toolbar;

    toolbar = document.createElement("div");
    toolbar.id = "pandita-email-toolbar";

    // Use Shadow DOM to avoid style conflicts with Gmail/Outlook CSS
    const shadow = toolbar.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        position: fixed;
        z-index: 2147483647;
        display: none;
      }
      .toolbar {
        display: flex;
        flex-direction: row;
        gap: 2px;
        background: #ffffff;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        padding: 4px 6px;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
      }
      .toolbar-label {
        display: flex;
        align-items: center;
        padding: 0 6px 0 4px;
        font-weight: 600;
        color: #1976d2;
        font-size: 11px;
        border-right: 1px solid #e0e0e0;
        margin-right: 2px;
      }
      button {
        border: none;
        background: transparent;
        padding: 5px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        color: #333;
        white-space: nowrap;
        font-family: inherit;
        transition: background 0.15s;
      }
      button:hover {
        background: #e3f2fd;
        color: #1565c0;
      }
    `;

    const container = document.createElement("div");
    container.className = "toolbar";

    const label = document.createElement("span");
    label.className = "toolbar-label";
    label.textContent = "P";
    container.appendChild(label);

    for (const action of PANDITA_ACTIONS) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.dataset.action = action.id;

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const selectedText = window.getSelection().toString().trim();
        if (!selectedText) return;

        hideToolbar();

        if (action.id === "chat") {
          chrome.runtime.sendMessage({ type: "open-sidepanel" });
          setTimeout(() => {
            chrome.runtime.sendMessage({
              type: "init-chat",
              selectedText,
            });
          }, 600);
        } else {
          chrome.runtime.sendMessage({
            type: "context-action",
            action: action.id,
            selectedText,
          });
        }
      });

      container.appendChild(btn);
    }

    shadow.appendChild(style);
    shadow.appendChild(container);
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function showToolbar() {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }

    // Get the bounding rect of the SELECTION (not the click point)
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // If rect has no size, selection is collapsed
    if (rect.width === 0 && rect.height === 0) return;

    const tb = createToolbar();
    tb.style.display = "block";

    // Position: below the BOTTOM-END of the selection
    const tbWidth = 520;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - tbWidth - 8));
    const top = Math.min(rect.bottom + 6, window.innerHeight - 50);

    tb.style.left = `${left}px`;
    tb.style.top = `${top}px`;
  }

  function hideToolbar() {
    if (toolbar) {
      toolbar.style.display = "none";
    }
  }

  // ─── SELECTION DETECTION ───────────────────────────────────────────────────
  // Show toolbar on ANY text selection on the page (not just compose areas).
  // The Chrome context menu (right-click > Pandita) also works, but the
  // floating toolbar gives quicker access.

  document.addEventListener("mouseup", (e) => {
    // Don't show toolbar if clicking inside the toolbar itself
    if (toolbar && toolbar.contains(e.target)) return;

    // Small delay to let selection finalize
    setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection ? selection.toString().trim() : "";

      if (selectedText && selectedText.length > 0) {
        showToolbar();
      } else {
        hideToolbar();
      }
    }, 80);
  });

  // Hide toolbar when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) {
      hideToolbar();
    }
  });

  // Hide on scroll
  document.addEventListener("scroll", () => {
    hideTimeout = setTimeout(hideToolbar, 150);
  }, true);

  // Hide on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideToolbar();
  });
})();
