// sidepanel.js — Pandita side panel logic
// Manages auth state, chat, streaming, output rendering, and message handling.

(() => {
  // ─── ACTION PROMPTS (mirrors background.js) ──────────────────────────────

  const ACTION_PROMPTS = {
    rewrite: {
      systemPrompt:
        "You are an expert editor. Rewrite the following text to improve clarity and flow. Return ONLY the rewritten text, no explanations.",
    },
    "fix-grammar": {
      systemPrompt:
        "Fix all spelling and grammar errors in the following text. Return ONLY the corrected text, preserving the original meaning and tone.",
    },
    "check-grammar": {
      systemPrompt:
        "Analyze the following text for grammar, spelling, and style issues. Provide detailed explanations and suggestions for each issue found.",
    },
    expand: {
      systemPrompt:
        "Expand the following text by approximately 25%, adding more detail while maintaining the same tone and style. Return ONLY the expanded text.",
    },
    shorten: {
      systemPrompt:
        "Condense the following text while preserving all key points. Aim for roughly 75% of the original length. Return ONLY the shortened text.",
    },
    summarize: {
      systemPrompt:
        "Provide a concise, well-structured summary of the following text. Use bullet points for key takeaways.",
    },
    "explain-page": {
      systemPrompt:
        "Provide a comprehensive summary and analysis of the following webpage content. Break it into sections: Overview, Key Points, and Notable Details.",
    },
  };

  const PENDING_ACTION_KEY = "pandita_pending_action";

  // ─── STATE ────────────────────────────────────────────────────────────────

  let conversationHistory = [];
  let currentPageContext = null;
  let currentSelection = "";
  let lastOutputText = "";
  let currentModel = "";
  let currentStreamId = null;
  let isStreaming = false;
  let uiReady = false;

  // ─── SERVER CHAT STATE ──────────────────────────────────────────────────

  let serverChats = [];
  let activeServerChatId = null;
  let activeServerChat = null;
  let chatRefreshTimer = null;

  // ─── DOM REFERENCES ──────────────────────────────────────────────────────

  const loginOverlay = document.getElementById("login-overlay");
  const mainContainer = document.getElementById("main-container");
  const btnSSOLogin = document.getElementById("btn-sso-login");
  const loginStatus = document.getElementById("login-status");
  const userDisplayName = document.getElementById("user-display-name");
  const modelSelect = document.getElementById("model-select");
  const btnRefreshModels = document.getElementById("btn-refresh-models");
  const btnSettings = document.getElementById("btn-settings");
  const btnLogout = document.getElementById("btn-logout");
  const outputArea = document.getElementById("output-area");
  const outputContent = document.getElementById("output-content");
  const btnCloseOutput = document.getElementById("btn-close-output");
  const btnCopy = document.getElementById("btn-copy");
  const btnCopyFormatted = document.getElementById("btn-copy-formatted");
  const btnListen = document.getElementById("btn-listen");
  const chatArea = document.getElementById("chat-area");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const btnSend = document.getElementById("btn-send");
  const bottomNav = document.getElementById("bottom-nav");
  const promptCoachArea = document.getElementById("prompt-coach-area");
  const coachPromptInput = document.getElementById("coach-prompt-input");
  const coachGoal = document.getElementById("coach-goal");
  const coachAudience = document.getElementById("coach-audience");
  const btnCoachRun = document.getElementById("btn-coach-run");
  const btnCloseCoach = document.getElementById("btn-close-coach");
  const coachResult = document.getElementById("coach-result");
  const chatSelector = document.getElementById("chat-selector");
  const chatTabs = document.getElementById("chat-tabs");
  const btnNewChat = document.getElementById("btn-new-chat");
  const syncToast = document.getElementById("sync-toast");

  // ─── PENDING ACTION ──────────────────────────────────────────────────────

  let pendingAction = null;

  async function consumePendingAction() {
    try {
      const result = await chrome.storage.local.get(PENDING_ACTION_KEY);
      const action = result[PENDING_ACTION_KEY];
      if (action) {
        await chrome.storage.local.remove(PENDING_ACTION_KEY);
        handleAction(action);
      }
    } catch (err) {
      console.error("Pandita: consumePendingAction error:", err);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PENDING_ACTION_KEY]?.newValue) {
      const action = changes[PENDING_ACTION_KEY].newValue;
      if (uiReady) {
        chrome.storage.local.remove(PENDING_ACTION_KEY);
        handleAction(action);
      } else {
        pendingAction = action;
      }
    }
  });

  // ─── SYNC TOAST ──────────────────────────────────────────────────────────

  let syncToastTimeout = null;

  function showSyncToast(text, isError = false) {
    if (!syncToast) return;
    syncToast.textContent = text;
    syncToast.className = "sync-toast visible" + (isError ? " error" : "");
    clearTimeout(syncToastTimeout);
    syncToastTimeout = setTimeout(() => {
      syncToast.className = "sync-toast";
    }, 3000);
  }

  // ─── SERVER CHAT SELECTION ALGORITHM ────────────────────────────────────

  async function loadChatSlots() {
    const max = CONFIG.MAX_CHAT_SLOTS;
    let pinned = [];
    let recent = [];

    try {
      pinned = await API.fetchPinnedChats();
    } catch (err) {
      console.warn("Pandita: failed to fetch pinned chats:", err.message);
    }

    pinned.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    const selected = pinned.slice(0, max).map((c) => ({
      id: c.id,
      title: c.title,
      updated_at: c.updated_at,
      pinned: true,
    }));

    if (selected.length < max) {
      try {
        recent = await API.fetchRecentChats(1);
      } catch (err) {
        console.warn("Pandita: failed to fetch recent chats:", err.message);
      }

      const selectedIds = new Set(selected.map((c) => c.id));
      for (const chat of recent) {
        if (selected.length >= max) break;
        if (selectedIds.has(chat.id)) continue;
        selected.push({
          id: chat.id,
          title: chat.title,
          updated_at: chat.updated_at,
          pinned: false,
        });
      }
    }

    serverChats = selected;
    renderChatSelector();
  }

  function renderChatSelector() {
    if (!chatTabs || !chatSelector) return;

    chatTabs.innerHTML = "";

    if (serverChats.length === 0) {
      chatSelector.classList.add("hidden");
      return;
    }

    chatSelector.classList.remove("hidden");

    btnNewChat.className = "chat-tab chat-tab-new" +
      (activeServerChatId === null ? " active" : "");

    for (const chat of serverChats) {
      const tab = document.createElement("button");
      tab.className = "chat-tab" + (chat.id === activeServerChatId ? " active" : "");
      tab.title = chat.title || "Untitled";
      tab.dataset.chatId = chat.id;

      let inner = "";
      if (chat.pinned) {
        inner += '<span class="material-symbols-outlined chat-tab-pin">push_pin</span>';
      }
      const title = chat.title || "Untitled";
      const truncated = title.length > 20 ? title.substring(0, 20) + "…" : title;
      inner += `<span class="chat-tab-title">${escapeHtml(truncated)}</span>`;

      tab.innerHTML = inner;
      tab.addEventListener("click", () => selectServerChat(chat.id));
      chatTabs.appendChild(tab);
    }
  }

  function renderChatSelectorLoading() {
    if (!chatTabs || !chatSelector) return;
    chatSelector.classList.remove("hidden");
    chatTabs.innerHTML = "";
    for (let i = 0; i < CONFIG.MAX_CHAT_SLOTS; i++) {
      const skel = document.createElement("div");
      skel.className = "chat-tab chat-tab-skeleton";
      skel.textContent = "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";
      chatTabs.appendChild(skel);
    }
  }

  // ─── SERVER CHAT LOADING ────────────────────────────────────────────────

  function extractMessageList(messagesMap, currentId) {
    if (!messagesMap || !currentId) return [];
    const list = [];
    let id = currentId;
    while (id && messagesMap[id]) {
      list.unshift(messagesMap[id]);
      id = messagesMap[id].parentId;
    }
    return list;
  }

  async function selectServerChat(chatId) {
    if (isStreaming) return;
    if (chatId === activeServerChatId) return;

    activeServerChatId = chatId;
    renderChatSelector();

    conversationHistory = [];
    currentPageContext = null;
    currentSelection = "";
    lastOutputText = "";
    chatMessages.innerHTML = "";
    chatInput.placeholder = "Message...";

    outputArea.classList.add("hidden");
    promptCoachArea.classList.add("hidden");
    chatArea.classList.remove("hidden");
    setActiveNav("chat");

    if (!chatId) return;

    chatMessages.innerHTML =
      '<div class="loading-dots" style="padding: 24px 16px;"><span></span><span></span><span></span></div>';

    try {
      const fullChat = await API.fetchChatById(chatId);
      activeServerChat = fullChat;

      const history = fullChat.chat?.history;
      if (!history) {
        chatMessages.innerHTML = "";
        return;
      }

      const messages = extractMessageList(history.messages, history.currentId);
      chatMessages.innerHTML = "";

      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          addChatBubble(msg.role, msg.content || "");
          conversationHistory.push({ role: msg.role, content: msg.content || "" });
        }
      }
    } catch (err) {
      console.error("Pandita: failed to load server chat:", err);
      chatMessages.innerHTML = "";
      activeServerChatId = null;
      activeServerChat = null;
      renderChatSelector();
      showSyncToast("Gagal memuat chat", true);
    }
  }

  function switchToAdHocChat() {
    if (isStreaming) return;
    activeServerChatId = null;
    activeServerChat = null;
    conversationHistory = [];
    currentPageContext = null;
    currentSelection = "";
    lastOutputText = "";
    chatMessages.innerHTML = "";
    chatInput.placeholder = "Message...";
    outputArea.classList.add("hidden");
    promptCoachArea.classList.add("hidden");
    chatArea.classList.remove("hidden");
    setActiveNav("chat");
    renderChatSelector();
    chatInput.focus();
  }

  if (btnNewChat) {
    btnNewChat.addEventListener("click", switchToAdHocChat);
  }

  // ─── SYNC TO SERVER ─────────────────────────────────────────────────────

  async function syncChatToServer() {
    if (!activeServerChatId || !activeServerChat) return;

    const history = activeServerChat.chat?.history;
    if (!history) return;

    try {
      const updated = await API.updateChatById(activeServerChatId, activeServerChat.chat);
      activeServerChat = updated;
    } catch (err) {
      console.warn("Pandita: sync failed, retrying:", err.message);
      showSyncToast("Sinkronisasi gagal, mencoba ulang...", true);
      try {
        await new Promise((r) => setTimeout(r, 3000));
        const updated = await API.updateChatById(activeServerChatId, activeServerChat.chat);
        activeServerChat = updated;
        showSyncToast("Sinkronisasi berhasil");
      } catch (retryErr) {
        console.error("Pandita: sync retry failed:", retryErr.message);
        showSyncToast("Sinkronisasi gagal", true);
      }
    }
  }

  function appendMessageToServerChat(role, content, model) {
    if (!activeServerChat?.chat?.history) return;

    const history = activeServerChat.chat.history;
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parentId = history.currentId || null;

    const message = {
      id: msgId,
      parentId,
      childrenIds: [],
      role,
      content: content || "",
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (role === "assistant" && model) {
      message.model = model;
    }

    if (parentId && history.messages[parentId]) {
      if (!history.messages[parentId].childrenIds) {
        history.messages[parentId].childrenIds = [];
      }
      history.messages[parentId].childrenIds.push(msgId);
    }

    history.messages[msgId] = message;
    history.currentId = msgId;

    return msgId;
  }

  // ─── PERIODIC REFRESH ───────────────────────────────────────────────────

  function startChatRefresh() {
    stopChatRefresh();
    chatRefreshTimer = setInterval(async () => {
      if (!uiReady) return;
      try {
        const previousIds = serverChats.map((c) => c.id);
        await loadChatSlots();

        if (activeServerChatId) {
          const stillExists = serverChats.some((c) => c.id === activeServerChatId);
          if (!stillExists) {
            showSyncToast("Chat tidak tersedia lagi", true);
            switchToAdHocChat();
            return;
          }

          const current = serverChats.find((c) => c.id === activeServerChatId);
          if (current && activeServerChat &&
              current.updated_at > (activeServerChat.updated_at || 0)) {
            try {
              const fullChat = await API.fetchChatById(activeServerChatId);
              if (fullChat.updated_at !== activeServerChat.updated_at) {
                activeServerChat = fullChat;
                const history = fullChat.chat?.history;
                if (history) {
                  const messages = extractMessageList(history.messages, history.currentId);
                  chatMessages.innerHTML = "";
                  conversationHistory = [];
                  for (const msg of messages) {
                    if (msg.role === "user" || msg.role === "assistant") {
                      addChatBubble(msg.role, msg.content || "");
                      conversationHistory.push({ role: msg.role, content: msg.content || "" });
                    }
                  }
                }
              }
            } catch (err) {
              console.warn("Pandita: failed to refresh active chat:", err.message);
            }
          }
        }
      } catch (err) {
        console.warn("Pandita: periodic refresh failed:", err.message);
      }
    }, CONFIG.CHAT_REFRESH_INTERVAL_MS);
  }

  function stopChatRefresh() {
    if (chatRefreshTimer) {
      clearInterval(chatRefreshTimer);
      chatRefreshTimer = null;
    }
  }

  // ─── INITIALIZATION ──────────────────────────────────────────────────────

  async function init() {
    try {
      const session = await Auth.checkSession();
      if (session.authenticated) {
        await showMainUI(session.user);
      } else {
        showLoginOverlay();
      }
    } catch (err) {
      console.error("Pandita: init error:", err);
      showLoginOverlay();
    }

    if (uiReady) {
      if (pendingAction) {
        const action = pendingAction;
        pendingAction = null;
        chrome.storage.local.remove(PENDING_ACTION_KEY);
        handleAction(action);
      } else {
        await consumePendingAction();
      }
    }
  }

  function showLoginOverlay() {
    loginOverlay.classList.remove("hidden");
    mainContainer.classList.add("hidden");
    loginStatus.textContent = "";
    loginStatus.className = "login-status";
  }

  async function showMainUI(user) {
    loginOverlay.classList.add("hidden");
    mainContainer.classList.remove("hidden");

    const displayName = user?.name || user?.email || "User";
    userDisplayName.textContent = displayName;

    await loadModels();

    renderChatSelectorLoading();
    loadChatSlots().catch((err) => {
      console.warn("Pandita: initial chat slots load failed:", err.message);
      if (chatSelector) chatSelector.classList.add("hidden");
    });

    uiReady = true;
    startChatRefresh();
  }

  // ─── SSO LOGIN ────────────────────────────────────────────────────────────

  btnSSOLogin.addEventListener("click", () => {
    btnSSOLogin.disabled = true;
    loginStatus.innerHTML =
      '<span class="spinner"></span> Waiting for SSO login...';
    loginStatus.className = "login-status";
    chrome.runtime.sendMessage({ type: "start-sso-login" });
  });

  // ─── MODEL MANAGEMENT ────────────────────────────────────────────────────

  async function loadModels() {
    try {
      modelSelect.innerHTML = '<option value="">Loading models...</option>';
      const models = await API.fetchModels();

      const settings = await chrome.storage.sync.get("defaultModel");
      const savedModel = settings.defaultModel || "";

      modelSelect.innerHTML = "";

      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models available</option>';
        return;
      }

      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name || model.id;
        if (model.id === savedModel) option.selected = true;
        modelSelect.appendChild(option);
      }

      currentModel = modelSelect.value || models[0]?.id || "";

      if (!savedModel && currentModel) {
        chrome.storage.sync.set({ defaultModel: currentModel });
      }
    } catch (err) {
      console.error("Pandita: failed to load models:", err);
      modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
  }

  modelSelect.addEventListener("change", () => {
    currentModel = modelSelect.value;
    chrome.storage.sync.set({ defaultModel: currentModel });
  });

  btnRefreshModels.addEventListener("click", loadModels);

  // ─── SETTINGS & LOGOUT ────────────────────────────────────────────────────

  btnSettings.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  btnLogout.addEventListener("click", async () => {
    await Auth.logout();
    stopChatRefresh();
    uiReady = false;
    conversationHistory = [];
    currentPageContext = null;
    currentSelection = "";
    lastOutputText = "";
    serverChats = [];
    activeServerChatId = null;
    activeServerChat = null;
    chatMessages.innerHTML = "";
    if (chatSelector) chatSelector.classList.add("hidden");
    outputArea.classList.add("hidden");
    chatArea.classList.remove("hidden");
    showLoginOverlay();
  });

  // ─── BOTTOM NAV ──────────────────────────────────────────────────────────

  if (bottomNav) {
    bottomNav.addEventListener("click", (e) => {
      const item = e.target.closest(".nav-item");
      if (!item) return;

      const view = item.dataset.view;

      bottomNav.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");

      switch (view) {
        case "chat":
          outputArea.classList.add("hidden");
          promptCoachArea.classList.add("hidden");
          chatArea.classList.remove("hidden");
          break;
        case "summarize":
          triggerQuickAction("summarize");
          break;
        case "explain":
          runExplainPage();
          break;
        case "prompt-coach":
          showPromptCoach();
          break;
      }
    });
  }

  function triggerQuickAction(action) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "get-selection" }, (response) => {
        const text = response?.selectedText || "";
        if (text) {
          handleAction({
            type: "process-action",
            action,
            text,
            tabId: tabs[0].id,
          });
        } else {
          chrome.runtime.sendMessage({ type: "scrape-active-page" }, (pageResponse) => {
            if (pageResponse?.content) {
              handleAction({
                type: "process-action",
                action,
                text: pageResponse.content,
                tabId: tabs[0].id,
              });
            }
          });
        }
      });
    });
  }

  // ─── MARKDOWN RENDERING ──────────────────────────────────────────────────

  function renderMarkdown(text) {
    if (!text) return "";
    if (typeof marked !== "undefined") {
      marked.setOptions({ breaks: true, gfm: true });
      return marked.parse(text);
    }
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  function applyHighlighting(container) {
    if (typeof hljs === "undefined") return;
    const codeBlocks = container.querySelectorAll("pre code");
    codeBlocks.forEach((block) => {
      hljs.highlightElement(block);
      const pre = block.parentElement;
      if (pre && !pre.parentElement.classList.contains("code-block-wrapper")) {
        const wrapper = document.createElement("div");
        wrapper.className = "code-block-wrapper";
        pre.parentElement.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-code-btn";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(block.textContent).then(() => {
            copyBtn.textContent = "Copied!";
            copyBtn.classList.add("copied");
            setTimeout(() => {
              copyBtn.textContent = "Copy";
              copyBtn.classList.remove("copied");
            }, 2000);
          });
        });
        wrapper.appendChild(copyBtn);
      }
    });
  }

  // ─── OUTPUT AREA ──────────────────────────────────────────────────────────

  function showOutput(text) {
    chatArea.classList.add("hidden");
    promptCoachArea.classList.add("hidden");
    outputArea.classList.remove("hidden");
    outputContent.innerHTML = renderMarkdown(text);
    applyHighlighting(outputContent);
    lastOutputText = text;
    outputArea.scrollTop = 0;
  }

  function showOutputLoading() {
    chatArea.classList.add("hidden");
    promptCoachArea.classList.add("hidden");
    outputArea.classList.remove("hidden");
    outputContent.innerHTML =
      '<div class="loading-dots"><span></span><span></span><span></span></div>';
  }

  function closeOutput() {
    outputArea.classList.add("hidden");
    promptCoachArea.classList.add("hidden");
    chatArea.classList.remove("hidden");
    setActiveNav("chat");
  }

  btnCloseOutput.addEventListener("click", closeOutput);

  function updateOutputStreaming(fullText) {
    outputContent.innerHTML = renderMarkdown(fullText);
  }

  function finalizeOutput(fullText) {
    outputContent.innerHTML = renderMarkdown(fullText);
    applyHighlighting(outputContent);
    lastOutputText = fullText;
  }

  // ─── COPY BUTTONS ────────────────────────────────────────────────────────

  btnCopy.addEventListener("click", () => {
    navigator.clipboard.writeText(lastOutputText).then(() => {
      btnCopy.classList.add("copied");
      const orig = btnCopy.innerHTML;
      btnCopy.innerHTML =
        '<span class="material-symbols-outlined">check</span> Copied!';
      setTimeout(() => { btnCopy.innerHTML = orig; btnCopy.classList.remove("copied"); }, 2000);
    });
  });

  btnCopyFormatted.addEventListener("click", () => {
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([outputContent.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([lastOutputText], { type: "text/plain" }),
        }),
      ])
      .then(() => {
        btnCopyFormatted.classList.add("copied");
        const orig = btnCopyFormatted.innerHTML;
        btnCopyFormatted.innerHTML =
          '<span class="material-symbols-outlined">check</span> Copied!';
        setTimeout(() => { btnCopyFormatted.innerHTML = orig; btnCopyFormatted.classList.remove("copied"); }, 2000);
      });
  });

  // ─── LISTEN BUTTON ────────────────────────────────────────────────────────

  let isSpeaking = false;

  btnListen.addEventListener("click", () => {
    if (isSpeaking) {
      speechSynthesis.cancel();
      isSpeaking = false;
      btnListen.innerHTML =
        '<span class="material-symbols-outlined">volume_up</span> Listen';
      return;
    }
    const text = outputContent.innerText || lastOutputText;
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      isSpeaking = false;
      btnListen.innerHTML =
        '<span class="material-symbols-outlined">volume_up</span> Listen';
    };
    speechSynthesis.speak(utterance);
    isSpeaking = true;
    btnListen.innerHTML =
      '<span class="material-symbols-outlined">stop</span> Stop';
  });

  // ─── PROMPT COACH ────────────────────────────────────────────────────────

  function buildCoachPrompt(prompt, goal, audience) {
    return `Kamu adalah Prompt Coach — seorang ahli prompt engineer yang mengkhususkan diri dalam menulis ulang dan menyempurnakan prompt. Kamu juga bertindak sebagai auditor kepatuhan untuk memastikan prompt aman digunakan di lingkungan pemerintahan Indonesia.

## TUGASMU:
Tulis ulang dan perbaiki prompt berikut agar jauh lebih efektif, sekaligus pastikan prompt tersebut MEMATUHI standar kepatuhan pemerintah.

## PROMPT ASLI:
"""${prompt}"""

## KONTEKS TAMBAHAN:
- Tujuan: ${goal || "Tidak ditentukan — simpulkan maksud yang paling mungkin"}
- Audiens: ${audience || "Tidak ditentukan — asumsikan audiens umum di lingkungan pemerintahan"}

## ATURAN KETAT:
1. Jika informasi penting benar-benar tidak ada dan kamu tidak bisa menyimpulkannya, ajukan tepat SATU pertanyaan lanjutan — lalu BERHENTI. Jangan ajukan banyak pertanyaan.
2. Jika kamu punya cukup info (atau bisa menyimpulkan secara wajar), langsung lanjutkan dengan penulisan ulang. JANGAN ajukan pertanyaan yang tidak perlu.
3. SELALU kembalikan PROMPT FINAL di dalam blok kode yang bersih.
4. Buat prompt lebih spesifik, jelas, terstruktur, dan berorientasi pada tujuan.
5. Tambahkan penugasan peran, konteks, batasan, dan format output jika diperlukan.
6. Hilangkan ambiguitas, ketidakjelasan, dan redundansi.
7. Pertahankan maksud asli — jangan ubah apa yang pengguna inginkan, hanya ubah cara mereka memintanya.

## PEMERIKSAAN KEPATUHAN PEMERINTAH (WAJIB):
Saat menulis ulang, pastikan prompt TIDAK mengandung:
- **Keamanan Data:** Paparan data pribadi (PII), nomor identitas (NIK/NIP/NPWP), informasi keuangan, atau data sensitif pemerintah.
- **Kerahasiaan:** Referensi ke dokumen rahasia negara, data internal kementerian/lembaga, atau informasi yang belum dipublikasikan.
- **Kebijakan & Regulasi:** Instruksi yang melanggar UU ITE, UU Perlindungan Data Pribadi (UU PDP), atau kebijakan penggunaan AI di instansi pemerintah.
- **Keamanan:** Instruksi manipulatif, jailbreak, atau yang berpotensi menghasilkan konten berbahaya/menyesatkan.
- **Bias & Etika:** Bahasa yang mengandung bias SARA, diskriminatif, atau tidak netral.

Jika ditemukan masalah kepatuhan, tandai dan perbaiki secara otomatis di PROMPT FINAL.

## FORMAT RESPONS:

### 🔍 Analisis Singkat
(Maksimal 2-3 kalimat: apa yang kurang, apa yang diperbaiki)

### 🛡️ Status Kepatuhan
- **Keamanan Data:** ✅ Aman / ⚠️ Diperbaiki
- **Kerahasiaan:** ✅ Aman / ⚠️ Diperbaiki
- **Kebijakan:** ✅ Sesuai / ⚠️ Diperbaiki
- **Keamanan:** ✅ Aman / ⚠️ Diperbaiki
(Jika ada yang diperbaiki, jelaskan singkat apa yang diubah)

### ✨ PROMPT FINAL

### 📝 Perubahan Utama
- [Perubahan 1]
- [Perubahan 2]
- [Perubahan 3]`;
  }

  function showPromptCoach() {
    chatArea.classList.add("hidden");
    outputArea.classList.add("hidden");
    promptCoachArea.classList.remove("hidden");
    coachPromptInput.focus();
  }

  function closePromptCoach() {
    promptCoachArea.classList.add("hidden");
    chatArea.classList.remove("hidden");
    setActiveNav("chat");
  }

  btnCloseCoach.addEventListener("click", closePromptCoach);

  btnCoachRun.addEventListener("click", runPromptCoach);

  coachPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runPromptCoach();
    }
  });

  function runPromptCoach() {
    const prompt = coachPromptInput.value.trim();
    if (!prompt || isStreaming) return;

    const goal = coachGoal.value.trim();
    const audience = coachAudience.value.trim();
    const systemPrompt = buildCoachPrompt(prompt, goal, audience);

    coachResult.innerHTML =
      '<div class="loading-dots"><span></span><span></span><span></span></div>';
    btnCoachRun.disabled = true;
    isStreaming = true;

    const streamId = "coach-" + Date.now();
    currentStreamId = streamId;

    chrome.runtime.sendMessage({
      type: "stream-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      model: currentModel,
      streamId,
    });
  }

  // ─── CHAT ─────────────────────────────────────────────────────────────────

  function addChatBubble(role, content) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;

    if (role === "assistant") {
      bubble.innerHTML = `
        <div class="bubble-header">
          <div class="bubble-avatar">
            <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1;">auto_awesome</span>
          </div>
          <span class="bubble-name">Pandita AI</span>
        </div>
        <div class="bubble-content">${renderMarkdown(content)}</div>`;
      applyHighlighting(bubble.querySelector(".bubble-content"));
    } else {
      bubble.innerHTML = `<div class="bubble-content">${escapeHtml(content)}</div>`;
    }

    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function addLoadingBubble() {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.id = "streaming-bubble";
    bubble.innerHTML = `
      <div class="bubble-header">
        <div class="bubble-avatar">
          <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1;">auto_awesome</span>
        </div>
        <span class="bubble-name">Pandita AI</span>
      </div>
      <div class="bubble-content">
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>`;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
  }

  function updateStreamingBubble(fullText) {
    const bubble = document.getElementById("streaming-bubble");
    if (bubble) {
      const content = bubble.querySelector(".bubble-content");
      if (content) {
        content.innerHTML = renderMarkdown(fullText);
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  function finalizeStreamingBubble(fullText) {
    const bubble = document.getElementById("streaming-bubble");
    if (bubble) {
      bubble.removeAttribute("id");
      const content = bubble.querySelector(".bubble-content");
      if (content) {
        content.innerHTML = renderMarkdown(fullText);
        applyHighlighting(content);
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // ─── CHAT INPUT ───────────────────────────────────────────────────────────

  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + "px";
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnSend.addEventListener("click", sendMessage);

  // ─── EXPLAIN-PAGE INTENT DETECTION ─────────────────────────────────────────

  const EXPLAIN_PAGE_PATTERN =
    /^(explain|summarize|summary|describe|analyse|analyze|overview|break\s*down|what(?:'s| is| does))\s*(this\s+)?(page|webpage|web\s+page|site|website|article|content)$/i;

  function isExplainPageIntent(text) {
    return EXPLAIN_PAGE_PATTERN.test(text.trim());
  }

  function setActiveNav(view) {
    bottomNav.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    const target = bottomNav.querySelector(`[data-view="${view}"]`);
    if (target) target.classList.add("active");
  }

  function runExplainPage() {
    setActiveNav("explain");
    showOutputLoading();
    isStreaming = true;

    chrome.runtime.sendMessage({ type: "scrape-active-page" }, (response) => {
      if (!response || !response.content) {
        finalizeOutput("Tidak dapat membaca konten halaman.");
        isStreaming = false;
        return;
      }

      currentPageContext = {
        content: response.content,
        title: response.title,
        url: response.url,
      };

      const actionPrompt = ACTION_PROMPTS["explain-page"];
      const streamId = "output-" + Date.now();
      currentStreamId = streamId;

      chrome.runtime.sendMessage({
        type: "stream-chat",
        messages: [
          { role: "system", content: actionPrompt.systemPrompt },
          { role: "user", content: response.content },
        ],
        model: currentModel,
        streamId,
      });
    });
  }

  // ─── SEND MESSAGE ──────────────────────────────────────────────────────────

  function sendMessage() {
    const userMessage = chatInput.value.trim();
    if (!userMessage || isStreaming) return;

    chatInput.placeholder = "Message...";
    chatInput.value = "";
    chatInput.style.height = "auto";

    addChatBubble("user", userMessage);

    if (isExplainPageIntent(userMessage)) {
      runExplainPage();
      return;
    }

    let systemContent = "You are Pandita, a helpful AI assistant.";

    if (currentPageContext) {
      systemContent += `\n\nCurrent webpage (${currentPageContext.title}, ${currentPageContext.url}):\n${currentPageContext.content}`;
    }

    if (currentSelection) {
      systemContent += `\n\nUser's selected text:\n${currentSelection}`;
    }

    if (lastOutputText) {
      systemContent += `\n\nPrevious AI output:\n${lastOutputText}`;
    }

    conversationHistory.push({ role: "user", content: userMessage });

    if (activeServerChatId && activeServerChat) {
      appendMessageToServerChat("user", userMessage);
    }

    const fullMessages = [
      { role: "system", content: systemContent },
      ...conversationHistory,
    ];

    addLoadingBubble();
    isStreaming = true;
    btnSend.disabled = true;

    currentStreamId = "stream-" + Date.now();

    chrome.runtime.sendMessage({
      type: "stream-chat",
      messages: fullMessages,
      model: currentModel,
      streamId: currentStreamId,
    });
  }

  // ─── ACTION HANDLER ──────────────────────────────────────────────────────

  function handleAction(message) {
    const welcome = document.querySelector(".chat-welcome");
    if (welcome) welcome.remove();

    switch (message.type) {
      case "show-result":
        showOutput(message.text);
        break;

      case "process-action": {
        const action = message.action;
        const text = message.text;
        const actionPrompt = ACTION_PROMPTS[action];
        if (!actionPrompt) break;

        if (action === "explain-page") {
          setActiveNav("explain");
        }

        showOutputLoading();

        const streamId = "output-" + Date.now();
        currentStreamId = streamId;
        isStreaming = true;

        const msgs = [
          { role: "system", content: actionPrompt.systemPrompt },
          { role: "user", content: text },
        ];

        chrome.runtime.sendMessage({
          type: "stream-chat",
          messages: msgs,
          model: currentModel,
          streamId,
        });

        if (message.tabId) {
          chrome.runtime.sendMessage(
            { type: "get-page-content", tabId: message.tabId },
            (response) => {
              if (response) currentPageContext = response;
            }
          );
        }
        break;
      }

      case "init-chat": {
        outputArea.classList.add("hidden");
        chatArea.classList.remove("hidden");

        currentSelection = message.selectedText || "";

        if (message.tabId) {
          chrome.runtime.sendMessage(
            { type: "get-page-content", tabId: message.tabId },
            (response) => {
              if (response) currentPageContext = response;
            }
          );
        }

        if (currentSelection) {
          chatInput.value = currentSelection;
          sendMessage();
        } else {
          requestAnimationFrame(() => {
            setTimeout(() => chatInput.focus(), 50);
          });
        }
        break;
      }
    }
  }

  // ─── RUNTIME MESSAGE LISTENER ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "stream-token":
        if (message.streamId === currentStreamId) {
          if (currentStreamId.startsWith("output-")) {
            updateOutputStreaming(message.fullText);
          } else if (currentStreamId.startsWith("coach-")) {
            coachResult.innerHTML = renderMarkdown(message.fullText);
          } else {
            updateStreamingBubble(message.fullText);
          }
        }
        break;

      case "stream-done":
        if (message.streamId === currentStreamId) {
          if (currentStreamId.startsWith("output-")) {
            finalizeOutput(message.fullText);
          } else if (currentStreamId.startsWith("coach-")) {
            coachResult.innerHTML = renderMarkdown(message.fullText);
            applyHighlighting(coachResult);
            btnCoachRun.disabled = false;
          } else {
            finalizeStreamingBubble(message.fullText);
            conversationHistory.push({
              role: "assistant",
              content: message.fullText,
            });
            lastOutputText = message.fullText;

            if (activeServerChatId && activeServerChat) {
              appendMessageToServerChat("assistant", message.fullText, currentModel);
              syncChatToServer();
            }
          }
          isStreaming = false;
          btnSend.disabled = false;
          currentStreamId = null;
        }
        break;

      case "stream-error":
        if (message.streamId === currentStreamId) {
          const errorText = `Error: ${message.error}`;
          if (currentStreamId.startsWith("output-")) {
            finalizeOutput(errorText);
          } else if (currentStreamId.startsWith("coach-")) {
            coachResult.innerHTML = renderMarkdown(errorText);
            btnCoachRun.disabled = false;
          } else {
            finalizeStreamingBubble(errorText);
          }
          isStreaming = false;
          btnSend.disabled = false;
          currentStreamId = null;
        }
        break;

      case "page-changed":
        currentPageContext = null;
        currentSelection = "";
        if (currentStreamId) {
          chrome.runtime.sendMessage({ type: "abort-stream", streamId: currentStreamId }).catch(() => {});
          isStreaming = false;
          btnSend.disabled = false;
          currentStreamId = null;
        }
        if (!activeServerChatId) {
          conversationHistory = [];
          lastOutputText = "";
          chatMessages.innerHTML = "";
          chatInput.placeholder = "Message...";
          outputArea.classList.add("hidden");
          promptCoachArea.classList.add("hidden");
          chatArea.classList.remove("hidden");
        }
        break;

      case "auth-expired":
        stopChatRefresh();
        uiReady = false;
        serverChats = [];
        activeServerChatId = null;
        activeServerChat = null;
        if (chatSelector) chatSelector.classList.add("hidden");
        showLoginOverlay();
        break;

      case "sso-login-success":
        loginStatus.textContent = "Login successful!";
        loginStatus.className = "login-status";
        btnSSOLogin.disabled = false;
        showMainUI(message.user).then(() => {
          if (pendingAction) {
            const action = pendingAction;
            pendingAction = null;
            chrome.storage.local.remove(PENDING_ACTION_KEY);
            handleAction(action);
          } else {
            consumePendingAction();
          }
        });
        break;

      case "sso-login-failed":
        loginStatus.textContent = message.error || "Login failed. Please try again.";
        loginStatus.className = "login-status error";
        btnSSOLogin.disabled = false;
        break;
    }

    if (sendResponse) sendResponse({ received: true });
    return true;
  });

  // ─── START ────────────────────────────────────────────────────────────────

  init();
})();
