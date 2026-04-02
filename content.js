// content.js — Universal content script for Pandita
// Runs on all pages. Handles text replacement, page content extraction, and selection retrieval.

(() => {
  // Prevent double-initialization
  if (window.__panditaContentLoaded) return;
  window.__panditaContentLoaded = true;

  /**
   * Replace selected text in a textarea or input element.
   */
  function replaceInTextInput(element, newText) {
    const start = element.selectionStart;
    const end = element.selectionEnd;

    if (start === undefined || end === undefined || start === end) {
      return false;
    }

    const before = element.value.substring(0, start);
    const after = element.value.substring(end);
    element.value = before + newText + after;

    // Set cursor position after the inserted text
    const newCursorPos = start + newText.length;
    element.selectionStart = newCursorPos;
    element.selectionEnd = newCursorPos;

    // Dispatch input event so frameworks detect the change
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    return true;
  }

  /**
   * Replace selected text in a contenteditable element using Selection/Range API.
   */
  function replaceInContentEditable(newText) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    if (range.collapsed) return false;

    // Check if the selection is inside a contenteditable element
    let node = range.commonAncestorContainer;
    let isEditable = false;
    while (node && node !== document.body) {
      if (node.isContentEditable || node.contentEditable === "true") {
        isEditable = true;
        break;
      }
      node = node.parentElement;
    }

    if (!isEditable) return false;

    // Delete current selection and insert new text
    range.deleteContents();
    const textNode = document.createTextNode(newText);
    range.insertNode(textNode);

    // Move cursor to end of inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    // Dispatch input event on the editable element
    const editableEl = node.isContentEditable ? node : node.parentElement;
    if (editableEl) {
      editableEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    return true;
  }

  /**
   * Attempt to replace the currently selected text on the page.
   */
  function replaceSelection(newText) {
    // Strategy 1: Check if active element is a textarea or input
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "TEXTAREA" ||
        (active.tagName === "INPUT" && active.type === "text"))
    ) {
      const result = replaceInTextInput(active, newText);
      if (result) return true;
    }

    // Strategy 2: Try contenteditable
    const result = replaceInContentEditable(newText);
    if (result) return true;

    // Strategy 3: Could not replace
    return false;
  }

  // ─── MESSAGE LISTENERS ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "replace-selection") {
      const success = replaceSelection(message.newText);
      sendResponse({ success });
      return true;
    }

    if (message.type === "get-page-content") {
      const content = {
        url: location.href,
        title: document.title,
        content: (document.body.innerText || "").substring(
          0,
          CONFIG.MAX_PAGE_CONTENT_LENGTH
        ),
        selection: window.getSelection().toString(),
      };
      sendResponse(content);
      return true;
    }

    if (message.type === "get-selection") {
      sendResponse(window.getSelection().toString());
      return true;
    }
  });
})();
