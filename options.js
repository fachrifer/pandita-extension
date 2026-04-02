// options.js — Pandita settings page logic (SSO-only auth)

(() => {
  // ─── DOM REFERENCES ──────────────────────────────────────────────────────

  const baseUrlEl = document.getElementById("base-url");
  const connectionBadge = document.getElementById("connection-badge");
  const btnTestConnection = document.getElementById("btn-test-connection");
  const authLoggedIn = document.getElementById("auth-logged-in");
  const authLoggedOut = document.getElementById("auth-logged-out");
  const authUserName = document.getElementById("auth-user-name");
  const authUserEmail = document.getElementById("auth-user-email");
  const btnSSOLogin = document.getElementById("btn-sso-login");
  const btnSignOut = document.getElementById("btn-sign-out");
  const authStatus = document.getElementById("auth-status");
  const defaultModelSelect = document.getElementById("default-model");
  const modelCountBadge = document.getElementById("model-count-badge");
  const inPlaceEnabled = document.getElementById("in-place-enabled");
  const btnSave = document.getElementById("btn-save");
  const saveStatus = document.getElementById("save-status");

  // ─── INITIALIZATION ──────────────────────────────────────────────────────

  async function init() {
    baseUrlEl.textContent = CONFIG.BASE_URL;

    const settings = await chrome.storage.sync.get([
      "defaultModel",
      "inPlaceEnabled",
    ]);

    if (settings.inPlaceEnabled !== undefined) {
      inPlaceEnabled.checked = settings.inPlaceEnabled;
    }

    await checkAuthStatus();
    await testConnection();
  }

  // ─── CONNECTION TEST ──────────────────────────────────────────────────────

  async function testConnection() {
    connectionBadge.className = "connection-indicator";
    connectionBadge.innerHTML =
      '<span class="material-symbols-outlined">pending</span>';

    try {
      const response = await fetch(`${CONFIG.BASE_URL}/api/config`, {
        method: "GET",
        credentials: "include",
      });

      if (response.ok) {
        connectionBadge.className = "connection-indicator connected";
        connectionBadge.innerHTML =
          '<span class="material-symbols-outlined">check_circle</span>';
      } else {
        connectionBadge.className = "connection-indicator disconnected";
        connectionBadge.innerHTML =
          '<span class="material-symbols-outlined">error</span>';
      }
    } catch (err) {
      connectionBadge.className = "connection-indicator disconnected";
      connectionBadge.innerHTML =
        '<span class="material-symbols-outlined">error</span>';
    }
  }

  btnTestConnection.addEventListener("click", testConnection);

  // ─── AUTH STATUS ──────────────────────────────────────────────────────────

  async function checkAuthStatus() {
    try {
      const session = await Auth.checkSession();
      if (session.authenticated) {
        showLoggedIn(session.user);
      } else {
        showLoggedOut();
      }
    } catch (err) {
      showLoggedOut();
    }
  }

  function showLoggedIn(user) {
    authLoggedIn.classList.remove("hidden");
    authLoggedOut.classList.add("hidden");

    const name = user?.name || "Unknown";
    const email = user?.email || "";
    authUserName.textContent = name;
    if (authUserEmail) {
      authUserEmail.textContent = email;
    }

    loadModels();
  }

  function showLoggedOut() {
    authLoggedIn.classList.add("hidden");
    authLoggedOut.classList.remove("hidden");
    if (authStatus) authStatus.textContent = "";

    defaultModelSelect.innerHTML =
      '<option value="">Sign in to load models</option>';
    if (modelCountBadge) modelCountBadge.textContent = "";
  }

  // ─── SSO LOGIN ────────────────────────────────────────────────────────────

  btnSSOLogin.addEventListener("click", async () => {
    btnSSOLogin.disabled = true;
    authStatus.innerHTML =
      '<span class="spinner"></span> Waiting for SSO login...';
    authStatus.className = "status-text";

    chrome.runtime.sendMessage({ type: "start-sso-login" });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "sso-login-success") {
      authStatus.textContent = "Login successful!";
      authStatus.className = "status-text success";
      btnSSOLogin.disabled = false;
      showLoggedIn(message.user);
    }

    if (message.type === "sso-login-failed") {
      authStatus.textContent = message.error || "Login failed. Please try again.";
      authStatus.className = "status-text error";
      btnSSOLogin.disabled = false;
    }
  });

  // ─── SIGN OUT ─────────────────────────────────────────────────────────────

  btnSignOut.addEventListener("click", async () => {
    await Auth.logout();
    showLoggedOut();
    connectionBadge.className = "connection-indicator";
    connectionBadge.innerHTML =
      '<span class="material-symbols-outlined">pending</span>';
    await testConnection();
  });

  // ─── MODEL LOADING ────────────────────────────────────────────────────────

  async function loadModels() {
    try {
      defaultModelSelect.innerHTML =
        '<option value="">Loading models...</option>';

      const models = await API.fetchModels();
      const settings = await chrome.storage.sync.get("defaultModel");
      const savedModel = settings.defaultModel || "";

      defaultModelSelect.innerHTML = "";

      if (models.length === 0) {
        defaultModelSelect.innerHTML =
          '<option value="">No models available</option>';
        if (modelCountBadge) modelCountBadge.textContent = "0 Models";
        return;
      }

      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name || model.id;
        if (model.id === savedModel) {
          option.selected = true;
        }
        defaultModelSelect.appendChild(option);
      }

      if (modelCountBadge) {
        modelCountBadge.textContent = `${models.length} Available`;
      }
    } catch (err) {
      console.error("Pandita: failed to load models:", err);
      defaultModelSelect.innerHTML =
        '<option value="">Failed to load models</option>';
    }
  }

  // ─── SAVE SETTINGS ────────────────────────────────────────────────────────

  btnSave.addEventListener("click", async () => {
    try {
      await chrome.storage.sync.set({
        defaultModel: defaultModelSelect.value,
        inPlaceEnabled: inPlaceEnabled.checked,
      });

      saveStatus.textContent = "Settings saved!";
      saveStatus.className = "status-text success";

      setTimeout(() => {
        saveStatus.textContent = "";
        saveStatus.className = "status-text";
      }, 3000);
    } catch (err) {
      saveStatus.textContent = "Failed to save settings.";
      saveStatus.className = "status-text error";
    }
  });

  // ─── START ────────────────────────────────────────────────────────────────

  init();
})();
