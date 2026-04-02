// content-gdocs.js — Google Docs integration for Pandita
// Handles clipboard-based text capture/replacement and native context menu injection.
// Google Docs renders text on a canvas, so standard DOM selection doesn't work.

(() => {
  if (window.__panditaGDocsLoaded) return;
  window.__panditaGDocsLoaded = true;

  // ─── CLIPBOARD-BASED TEXT CAPTURE ──────────────────────────────────────────

  /**
   * Capture selected text from Google Docs via the clipboard.
   * Falls back to the hidden accessibility text layer if clipboard fails.
   */
  async function getGDocsSelection() {
    // Strategy 1: Try reading from Google Docs' hidden accessibility elements
    // Google Docs renders an offscreen <textarea> or aria elements with selected text
    const accessibilityText = getAccessibilitySelection();
    if (accessibilityText) return accessibilityText;

    // Strategy 2: Clipboard trick
    try {
      let originalClipboard = "";
      try {
        originalClipboard = await navigator.clipboard.readText();
      } catch (e) {
        // Clipboard might be empty or permission denied
      }

      // Focus the docs canvas to ensure execCommand works
      const canvas = document.querySelector(".kix-canvas-tile-content");
      if (canvas) canvas.focus();

      document.execCommand("copy");
      await new Promise((r) => setTimeout(r, 200));

      const selectedText = await navigator.clipboard.readText();

      // Restore clipboard (best effort)
      try {
        if (originalClipboard !== selectedText) {
          await navigator.clipboard.writeText(originalClipboard);
        }
      } catch (e) {
        // Ignore restore failure
      }

      // If we got something different from what was there before, it's our selection
      if (selectedText && selectedText !== originalClipboard) {
        return selectedText;
      }
      return selectedText || "";
    } catch (err) {
      console.warn("Pandita: GDocs clipboard capture failed:", err);
      return "";
    }
  }

  /**
   * Try to get selected text from Google Docs' accessibility layer.
   */
  function getAccessibilitySelection() {
    // Google Docs has a hidden contenteditable div for screen readers
    const editableEl = document.querySelector(
      '.docs-texteventtarget-iframe'
    );
    if (editableEl && editableEl.contentDocument) {
      const body = editableEl.contentDocument.body;
      if (body && body.textContent.trim()) {
        return body.textContent.trim();
      }
    }

    // Also try the rename input or native selection as fallback
    const nativeSelection = window.getSelection();
    if (nativeSelection && nativeSelection.toString().trim()) {
      return nativeSelection.toString().trim();
    }

    return "";
  }

  // ─── CLIPBOARD-BASED TEXT REPLACEMENT ──────────────────────────────────────

  async function replaceGDocsSelection(newText) {
    try {
      let originalClipboard = "";
      try {
        originalClipboard = await navigator.clipboard.readText();
      } catch (e) {}

      await navigator.clipboard.writeText(newText);

      // Focus docs canvas
      const canvas = document.querySelector(".kix-canvas-tile-content");
      if (canvas) canvas.focus();

      document.execCommand("paste");
      await new Promise((r) => setTimeout(r, 200));

      // Restore clipboard
      try {
        await navigator.clipboard.writeText(originalClipboard);
      } catch (e) {}

      return true;
    } catch (err) {
      console.warn("Pandita: GDocs paste failed:", err);
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
    menuItem.className = "goog-menuitem apps-menuitem";
    menuItem.setAttribute("role", "menuitem");
    menuItem.setAttribute("id", `pandita-${item.id}`);
    menuItem.style.cssText = "user-select: none; cursor: pointer;";

    const content = document.createElement("div");
    content.className = "goog-menuitem-content";
    content.style.cssText = "padding: 4px 7em 4px 28px;";

    const label = document.createElement("span");
    label.className = "goog-menuitem-label";
    label.textContent = `Pandita: ${item.label}`;

    content.appendChild(label);
    menuItem.appendChild(content);

    menuItem.addEventListener("mouseenter", () => {
      menuItem.classList.add("goog-menuitem-highlight");
    });
    menuItem.addEventListener("mouseleave", () => {
      menuItem.classList.remove("goog-menuitem-highlight");
    });

    menuItem.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Close the context menu
      const menuEl = menuItem.closest(
        '[role="menu"], .goog-menu, .docs-material-menu-content'
      );
      if (menuEl) {
        menuEl.style.display = "none";
        menuEl.style.visibility = "hidden";
      }

      const selectedText = await getGDocsSelection();
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

    // Separator
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
  // Google Docs context menus use various class names depending on the version.
  // We use broad selectors and check visibility.

  let debounceTimer = null;

  function scanForMenus() {
    // Broad selector: any visible menu with role="menu" or known Google classes
    const candidates = document.querySelectorAll(
      '[role="menu"], .goog-menu, .docs-material-menu-content, .docs-menu-hide-mnemonics'
    );

    for (const menu of candidates) {
      // Check visibility: offsetParent is null for hidden elements
      const isVisible =
        menu.offsetParent !== null ||
        getComputedStyle(menu).display !== "none";

      if (isVisible && !menu.dataset.panditaInjected) {
        // Check it has child menuitems (to avoid injecting into empty containers)
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

  // ─── OVERRIDE MESSAGE HANDLERS FOR GOOGLE DOCS ─────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "replace-selection") {
      replaceGDocsSelection(message.newText).then((success) => {
        sendResponse({ success });
      });
      return true;
    }

    if (message.type === "get-selection") {
      getGDocsSelection().then((text) => {
        sendResponse(text);
      });
      return true;
    }
  });
})();
