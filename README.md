# Pandita Extension

Pandita is a Chrome Extension that connects to an Open WebUI instance and helps users rewrite, summarize, and improve text directly from webpages, Google Workspace apps, and email composers.

## Features

- Side panel chat with streaming AI responses
- Right-click actions for selected text (summarize, rewrite, grammar, expand, shorten)
- In-place text replacement in editable fields
- Integrations for Google Docs, Sheets, Slides, Gmail, and Outlook
- SSO-based authentication flow with Open WebUI
- Output actions: copy plain text, copy formatted text, and text-to-speech

## Requirements

- Google Chrome 116 or newer
- Access to an Open WebUI server
- Valid SSO account for the Open WebUI environment

## Quick Start (Development)

1. Open `pandita/config.js` and set `BASE_URL` to your Open WebUI URL.
2. Update `host_permissions` in `pandita/manifest.json` if you use a different domain.
3. Open `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `pandita/` folder.
6. Pin the extension and open the side panel from the toolbar icon.

## Project Structure

- `manifest.json`: extension configuration and permissions
- `background.js`: service worker, context menus, and orchestration
- `sidepanel.html` / `sidepanel.js`: chat UI and interaction logic
- `options.html` / `options.js`: settings page
- `content*.js`: webpage, Google Workspace, and email integrations
- `api.js` / `auth.js` / `config.js`: API calls, auth helpers, and base config
- `rules.json`: configurable rules used by extension behavior

## Configuration Notes

- Default server domain in this project is `https://ai.kemenkeu.go.id`.
- The extension relies on `credentials: "include"` and token handling for authenticated API requests.

## Full Documentation

For complete setup, publishing, and troubleshooting instructions, see:

- `GUIDE.md`

## License

Internal project unless your organization defines a separate license.
