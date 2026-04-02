// content-gsheets.js — Google Sheets integration for Pandita
// Handles text capture from formula bar/cells, clipboard-based editing,
// and context menu injection.

(() => {
  if (window.__panditaGSheetsLoaded) return;
  window.__panditaGSheetsLoaded = true;

  // ─── TEXT CAPTURE ──────────────────────────────────────────────────────────

  /**
   * Get text from the active cell, formula bar, or selection in Google Sheets.
   */
  function getSheetsSelectionDOM() {
    // 1. Try native browser selection (works when editing a cell)
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      return selection.toString().trim();
    }

    // 2. Try the formula bar input
    const formulaSelectors = [
      "#t-formula-bar-input",
      '[aria-label="Formula input"]',
      ".cell-input",
      ".formulabar-input",
    ];
    for (const sel of formulaSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent || el.value || "";
        if (text.trim()) return text.trim();
      }
    }

    // 3. Try the active cell editor
    const cellEditor = document.querySelector(
      '.cell-input [contenteditable="true"], .input-editing-area [contenteditable="true"]'
    );
    if (cellEditor && cellEditor.textContent.trim()) {
      return cellEditor.textContent.trim();
    }

    return "";
  }

  /**
   * Get selected text with clipboard fallback.
   */
  async function getSheetsSelection() {
    const domText = getSheetsSelectionDOM();
    if (domText) return domText;

    // Clipboard trick fallback
    try {
      let originalClipboard = "";
      try {
        originalClipboard = await navigator.clipboard.readText();
      } catch (e) {}

      document.execCommand("copy");
      await new Promise((r) => setTimeout(r, 200));

      const selectedText = await navigator.clipboard.readText();

      try {
        if (selectedText !== originalClipboard) {
          await navigator.clipboard.writeText(originalClipboard);
        }
      } catch (e) {}

      return selectedText || "";
    } catch (err) {
      return "";
    }
  }

  // ─── CLIPBOARD-BASED TEXT REPLACEMENT ──────────────────────────────────────

  async function replaceSheetsSelection(newText) {
    try {
      let originalClipboard = "";
      try {
        originalClipboard = await navigator.clipboard.readText();
      } catch (e) {}

      await navigator.clipboard.writeText(newText);
      document.execCommand("paste");
      await new Promise((r) => setTimeout(r, 200));

      try {
        await navigator.clipboard.writeText(originalClipboard);
      } catch (e) {}

      return true;
    } catch (err) {
      console.warn("Pandita: Sheets paste failed:", err);
      return false;
    }
  }

  // ─── CONTEXT MENU INJECTION ────────────────────────────────────────────────

  const PANDITA_MENU_ITEMS = [
    { id: "rewrite", label: "Rewrite" },
    { id: "fix-grammar", label: "Fix Grammar" },
    { id: "check-grammar", label: "Check Grammar" },
    { id: "expand", label: "Expand" },
    { id: "shorten", label: "Shorten" },
    { id: "summarize", label: "Summarize" },
    { id: "chat", label: "Chat" },
  ];

  function createMenuItem(item) {
    const menuItem = document.createElement("div");
    menuItem.className = "goog-menuitem";
    menuItem.setAttribute("role", "menuitem");
    menuItem.setAttribute("id", `pandita-${item.id}`);
    menuItem.style.cssText =
      "user-select: none; padding: 6px 16px; cursor: pointer; font-size: 13px;";

    const content = document.createElement("div");
    content.className = "goog-menuitem-content";
    content.textContent = `Pandita: ${item.label}`;

    menuItem.appendChild(content);

    menuItem.addEventListener("mouseenter", () => {
      menuItem.style.backgroundColor = "#e8eaed";
    });
    menuItem.addEventListener("mouseleave", () => {
      menuItem.style.backgroundColor = "";
    });

    menuItem.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const menuEl = menuItem.closest('[role="menu"], .goog-menu');
      if (menuEl) {
        menuEl.style.display = "none";
        menuEl.style.visibility = "hidden";
      }

      const selectedText = await getSheetsSelection();
      if (!selectedText.trim()) return;

      if (item.id === "chat") {
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
          action: item.id,
          selectedText,
        });
      }
    });

    return menuItem;
  }

  function injectMenuItems(menuContainer) {
    if (menuContainer.dataset.panditaInjected) return;
    menuContainer.dataset.panditaInjected = "true";

    const separator = document.createElement("div");
    separator.className = "goog-menuseparator";
    separator.setAttribute("role", "separator");
    separator.style.cssText =
      "border-top: 1px solid #e0e0e0; margin: 4px 0; padding: 0;";
    menuContainer.appendChild(separator);

    for (const item of PANDITA_MENU_ITEMS) {
      menuContainer.appendChild(createMenuItem(item));
    }
  }

  // ─── MUTATION OBSERVER ─────────────────────────────────────────────────────

  let debounceTimer = null;

  function scanForMenus() {
    const candidates = document.querySelectorAll(
      '[role="menu"], .goog-menu, .goog-menu-vertical'
    );

    for (const menu of candidates) {
      const isVisible =
        menu.offsetParent !== null ||
        getComputedStyle(menu).display !== "none";

      if (isVisible && !menu.dataset.panditaInjected) {
        const hasItems =
          menu.querySelector('[role="menuitem"], .goog-menuitem');
        if (hasItems) {
          injectMenuItems(menu);
        }
      }
    }
  }

  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanForMenus, 80);
  });

  function startObserving() {
    const target = document.body || document.documentElement;
    if (target) {
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
  }

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener("DOMContentLoaded", startObserving);
  }

  // ─── OVERRIDE MESSAGE HANDLERS ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "replace-selection") {
      replaceSheetsSelection(message.newText).then((success) => {
        sendResponse({ success });
      });
      return true;
    }

    if (message.type === "get-selection") {
      getSheetsSelection().then((text) => {
        sendResponse(text);
      });
      return true;
    }
  });
})();
