// content-gslides.js — Google Slides integration for Pandita
// Slides uses canvas rendering for text boxes, same clipboard approach as Google Docs.

(() => {
  if (window.__panditaGSlidesLoaded) return;
  window.__panditaGSlidesLoaded = true;

  // ─── CLIPBOARD-BASED TEXT CAPTURE ──────────────────────────────────────────

  async function getSlidesSelection() {
    // Try standard selection first (works in speaker notes, etc.)
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      return selection.toString().trim();
    }

    // Clipboard trick for canvas-rendered text boxes
    try {
      let originalClipboard = "";
      try {
        originalClipboard = await navigator.clipboard.readText();
      } catch (e) {}

      // Focus the slide canvas area
      const slideCanvas = document.querySelector(
        '.punch-viewer-svgpage-svgcontainer, .sketchy-text-content-wrapper, .slide-content'
      );
      if (slideCanvas) slideCanvas.focus();

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

  async function replaceSlidesSelection(newText) {
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
      console.warn("Pandita: Slides paste failed:", err);
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

      const menuEl = menuItem.closest(
        '[role="menu"], .goog-menu, .docs-material-menu-content'
      );
      if (menuEl) {
        menuEl.style.display = "none";
        menuEl.style.visibility = "hidden";
      }

      const selectedText = await getSlidesSelection();
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
      '[role="menu"], .goog-menu, .docs-material-menu-content'
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
      replaceSlidesSelection(message.newText).then((success) => {
        sendResponse({ success });
      });
      return true;
    }

    if (message.type === "get-selection") {
      getSlidesSelection().then((text) => {
        sendResponse(text);
      });
      return true;
    }
  });
})();
