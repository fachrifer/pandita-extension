# Pandita — Chrome Extension Setup, Usage & Publishing Guide

Pandita is an AI-powered text assistant Chrome Extension that connects to a company-deployed Open WebUI instance with SSO authentication. It provides context menu actions, in-place text editing, and a persistent side panel chat.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Install as Unpacked Extension (Development)](#install-as-unpacked-extension-development)
3. [Connect to Open WebUI](#connect-to-open-webui)
4. [Using the Extension](#using-the-extension)
5. [Open WebUI Server Configuration](#open-webui-server-configuration)
6. [Customizing the Extension](#customizing-the-extension)
7. [Publishing to Chrome Web Store](#publishing-to-chrome-web-store)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Google Chrome (version 116 or later, for Side Panel API support)
- Access to an Open WebUI instance with SSO authentication enabled
- The Open WebUI instance must be reachable from your browser

---

## Install as Unpacked Extension (Development)

This is the fastest way to test and use Pandita during development.

### Step 1: Open Chrome Extensions Page

1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Enable **Developer mode** by toggling the switch in the top-right corner

### Step 2: Load the Extension

1. Click **"Load unpacked"** in the top-left
2. Browse to and select the `pandita/` directory (the folder containing `manifest.json`)
3. Click "Select Folder" / "Open"

### Step 3: Verify Installation

- You should see "Pandita" appear in the extensions list
- A blue "P" icon should appear in your Chrome toolbar
- If the icon is hidden, click the puzzle piece icon in the toolbar and pin Pandita

### Step 4: Reload After Changes

If you edit any files:
1. Go to `chrome://extensions/`
2. Click the refresh icon on the Pandita card
3. Reload any open tabs for content script changes to take effect

---

## Connect to Open WebUI

### Step 1: Configure the Base URL

The Open WebUI URL is hardcoded in `config.js`. Before loading the extension, update it to match your deployment:

```js
// config.js
const CONFIG = {
  BASE_URL: "https://ai.kemenkeu.go.id",  // <-- Change this to your Open WebUI URL
  ...
};
```

After changing the URL, reload the extension in `chrome://extensions/`.

### Step 2: Sign In with SSO

1. Click the Pandita icon in the Chrome toolbar to open the side panel
2. Click **"Sign in with SSO"**
3. A new tab opens with your Open WebUI login page
4. Complete the SSO authentication flow in that tab
5. The extension automatically detects your session (polls every 2 seconds)
6. Once authenticated, the side panel shows the main interface with your user name and available models

### Step 3: Verify Connection

1. Right-click the Pandita icon > "Options" (or go to the Settings page)
2. The **Connection** section shows your URL and a green "Connected" badge
3. The **Authentication** section shows your signed-in user name
4. The **Default Model** dropdown should list available models from your Open WebUI instance

---

## Using the Extension

### Side Panel Chat

1. Click the Pandita toolbar icon to open the side panel
2. Select a model from the dropdown in the header
3. Type a message in the input area and press Enter or click Send
4. Responses stream in real-time with live markdown rendering

### Context Menu Actions (Right-Click)

#### When text is selected:
1. Select text on any webpage
2. Right-click and hover over **"Pandita"** in the context menu
3. Choose an action:

| Action | Behavior |
|--------|----------|
| **Summarize** | Opens side panel with a bullet-point summary |
| **Rewrite** | Replaces selected text with improved version (in-place) |
| **Check Grammar** | Opens side panel with detailed grammar analysis |
| **Fix Grammar** | Replaces selected text with corrected version (in-place) |
| **Expand** | Replaces selected text with ~25% longer version (in-place) |
| **Shorten** | Replaces selected text with ~75% shorter version (in-place) |
| **Chat** | Opens side panel with text as context; you type the question |

#### When no text is selected:
- Right-click > **Pandita** > **Explain This Page** — Analyzes and summarizes the entire page content

### In-Place Editing

In-place actions (Rewrite, Fix Grammar, Expand, Shorten) work on:
- Standard text inputs and textareas
- Contenteditable elements (email composers, CMS editors, etc.)
- Google Docs, Sheets, and Slides (via clipboard trick)

If in-place replacement fails (e.g., on a read-only page), the result is shown in the side panel instead.

To disable in-place editing, go to **Settings** and turn off the **"In-place Editing"** toggle.

### Google Workspace Integration

On Google Docs, Sheets, and Slides, Pandita injects menu items into the native right-click context menu:
- The items appear at the bottom of Google's menu under a separator
- They function identically to the Chrome context menu actions

### Gmail & Outlook Integration

When composing emails in Gmail or Outlook:
- Select text in the compose window
- A floating Pandita toolbar appears near your selection
- Click any action to process the selected text

### Output Actions

After any AI output appears in the side panel:
- **Copy** — Copies the raw text to clipboard
- **Copy Formatted** — Copies as rich HTML (preserves formatting when pasting into Word, Google Docs, etc.)
- **Listen** — Reads the output aloud using text-to-speech

---

## Open WebUI Server Configuration

For the extension to work with your Open WebUI instance, ensure the following server-side settings:

### 1. CORS (Cross-Origin Resource Sharing)

Your Open WebUI server must allow requests from the Chrome extension origin. Add the extension's origin to your CORS configuration.

For Chrome extensions, the origin is: `chrome-extension://<EXTENSION_ID>`

You can find your extension ID at `chrome://extensions/` after loading the extension.

**If using Open WebUI's built-in server**, CORS is typically handled automatically for authenticated requests. If you encounter CORS errors, check your reverse proxy configuration (Nginx, Caddy, etc.):

```nginx
# Example Nginx CORS config for Open WebUI
location / {
    # Allow Chrome extension origin
    add_header Access-Control-Allow-Origin "chrome-extension://YOUR_EXTENSION_ID" always;
    add_header Access-Control-Allow-Credentials "true" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;

    if ($request_method = OPTIONS) {
        return 204;
    }

    proxy_pass http://localhost:8080;
}
```

### 2. SSO Configuration

Open WebUI must have SSO (SAML, OIDC, OAuth) configured and local/email login disabled. The extension relies on cookie-based SSO sessions:

- When the user signs in via the Open WebUI web interface, the session cookie is set for the Open WebUI domain
- The extension's `credentials: "include"` fetch option sends these cookies with API requests
- The extension also stores and uses JWT tokens from the API response as a fallback

### 3. API Endpoints Used

The extension calls these Open WebUI API endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/auths/` | GET | Check authentication status |
| `/api/v1/auths/signout` | GET | Sign out |
| `/api/models` | GET | List available models |
| `/api/chat/completions` | POST | Stream chat completions (SSE) |
| `/api/config` | GET | Test server connectivity |

All requests include `Authorization: Bearer <token>` header and `credentials: "include"`.

---

## Customizing the Extension

### Change the Open WebUI URL

Edit `pandita/config.js`:
```js
BASE_URL: "https://your-openwebui-instance.com"
```

Then update `manifest.json` host_permissions to include your domain:
```json
"host_permissions": [
  "https://your-openwebui-instance.com/*",
  ...
]
```

### Replace Icons

Replace the placeholder icons in `pandita/icons/` with your own:
- `icon16.png` — 16x16 pixels (toolbar)
- `icon48.png` — 48x48 pixels (extensions page)
- `icon128.png` — 128x128 pixels (Chrome Web Store)

Use PNG format with transparency if desired.

### Modify Action Prompts

Edit the `ACTION_PROMPTS` object in `pandita/background.js` to change the AI behavior for each action. The same prompts are mirrored in `sidepanel.js` for the side panel streaming path.

### Add or Remove Context Menu Actions

Edit the context menu creation in `background.js` (inside `chrome.runtime.onInstalled`) and the corresponding entries in `ACTION_PROMPTS`.

---

## Publishing to Chrome Web Store

### Step 1: Prepare for Submission

1. **Replace placeholder icons** with professional 16x16, 48x48, and 128x128 PNG icons
2. **Create promotional images**:
   - Small promo tile: 440x280 pixels
   - Marquee promo tile: 1400x560 pixels (optional)
   - Screenshots: 1280x800 or 640x400 pixels (at least 1, up to 5)
3. **Write a description** for the Chrome Web Store listing
4. **Test thoroughly** on multiple websites, Google Workspace, and email clients

### Step 2: Create a Developer Account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Sign in with a Google account
3. Pay the one-time $5 USD developer registration fee
4. Verify your developer account

### Step 3: Package the Extension

Create a ZIP file of the `pandita/` directory:

```bash
cd /path/to/project
zip -r pandita.zip pandita/ -x "pandita/GUIDE.md"
```

Or from inside the pandita directory:

```bash
cd pandita
zip -r ../pandita.zip . -x "GUIDE.md"
```

### Step 4: Upload to Chrome Web Store

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click **"New Item"**
3. Upload `pandita.zip`
4. Fill in the listing details:
   - **Name**: Pandita
   - **Summary**: AI-powered text assistant connected to Kemenkeu AI Platform
   - **Description**: Full description of features
   - **Category**: Productivity
   - **Language**: Indonesian / English
5. Upload screenshots and promotional images
6. Set **Visibility**:
   - **Public**: Anyone can find and install it
   - **Unlisted**: Only people with the direct link can install it (good for internal company use)
   - **Private**: Restricted to specific Google Workspace domain users (best for company-internal)

### Step 5: Set Distribution

For a company-internal extension:
- Choose **"Private"** visibility
- Under "Trusted testers" or domain restriction, enter your company's Google Workspace domain
- This ensures only employees with `@kemenkeu.go.id` accounts can install it

For broader distribution:
- Choose **"Unlisted"** or **"Public"**

### Step 6: Submit for Review

1. Click **"Submit for review"**
2. Google reviews the extension (typically 1-3 business days)
3. Once approved, the extension becomes available according to your visibility settings

### Step 7: Distribute via Google Workspace Admin (Optional)

For company-wide deployment without requiring individual installs:

1. Go to [Google Admin Console](https://admin.google.com)
2. Navigate to **Devices > Chrome > Apps & extensions**
3. Click the "+" icon and select **"Add Chrome app or extension by ID"**
4. Enter the extension ID from the Chrome Web Store
5. Set the installation policy:
   - **Force install**: Automatically installed on all managed Chrome browsers
   - **Force install + pin**: Auto-installed and pinned to toolbar
   - **Allow install**: Users can choose to install from the Web Store
6. Click **Save**

### Alternative: Self-Hosting for Enterprise

If you prefer not to use the Chrome Web Store:

1. Host the extension CRX file on your company's internal server
2. Use Group Policy (Windows) or managed preferences (macOS) to:
   - Whitelist the extension ID
   - Set the update URL to your internal server
3. See [Chrome Enterprise documentation](https://support.google.com/chrome/a/answer/9296680) for details

---

## Troubleshooting

### "Not connected" badge in Settings
- Verify the URL in `config.js` is correct and accessible
- Check if your network/VPN allows access to the Open WebUI server
- Look for CORS errors in the browser console (`F12` > Console tab)

### SSO login not detected
- Make sure you complete the SSO login fully in the new tab
- The extension polls every 2 seconds for up to 2 minutes
- Check that cookies are not blocked for the Open WebUI domain
- Try clearing cookies for the Open WebUI domain and signing in again

### Context menu items don't appear
- Reload the extension in `chrome://extensions/`
- Reload the webpage
- Ensure you have text selected (for selection actions) or right-click on the page background (for page actions)

### In-place replacement doesn't work
- The page must have an editable element (textarea, input, or contenteditable)
- Google Docs/Sheets/Slides require clipboard permissions — check that the extension has `clipboardRead` and `clipboardWrite` permissions
- Some websites block programmatic text changes — results will fall back to the side panel

### Side panel doesn't open
- Chrome 116+ is required for the Side Panel API
- Check `chrome://extensions/` for any error badges on the Pandita card
- Click the Pandita icon directly (not via context menu) as a test

### Models don't load
- Verify you are signed in (check Settings > Authentication)
- Your Open WebUI user account must have access to at least one model
- Check the browser console for API errors

### CORS errors
- The extension origin `chrome-extension://<ID>` must be allowed by the server
- Check your reverse proxy configuration
- Open WebUI may need `WEBUI_CORS_ALLOW_ORIGINS` environment variable set

### Extension not working after Chrome update
- Manifest V3 APIs may change between Chrome versions
- Reload the extension in `chrome://extensions/`
- Check the Chrome DevTools console for deprecation warnings
