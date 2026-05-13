# Gnomeo Chrome Extension MVP

A local-loadable prototype for a calm ad-spend review layer.

## What it does

- Uses the Chrome side panel as the only review UI.
- Optionally shows a small **Review with Gnomeo** opener button on supported ad-platform pages.
- Lets you add one or more **visible tables** to a session-only review bundle.
- Analyses one table or multiple captured tables together.
- Shows a concise review summary:
  - Top finding
  - Key signals
  - Captured tables
  - Safe preview
  - What deserves attention
  - Review confidence
  - Privacy note

## Supported pages

- Google Ads
- Meta Business / Ads Manager
- LinkedIn Campaign Manager

## Local test pages

Use these fake pages to test the local multi-capture flow without live accounts:

- `chrome-extension/test-pages/google-ads-campaigns.html`
- `chrome-extension/test-pages/meta-ads-campaigns.html`
- `chrome-extension/test-pages/linkedin-ads-campaigns.html`
- `chrome-extension/test-pages/no-table.html`

Optional index:

- `chrome-extension/test-pages/index.html`

Recommended test method:

1. `cd /Users/matthewjameson/Gnomeo`
2. `python3 -m http.server 8080`
3. Open `http://localhost:8080/chrome-extension/test-pages/`
4. Load the unpacked extension in Chrome and click **Review with Gnomeo**
5. Open the Google fixture and click **Add table**
6. Click the **×** button and confirm the side panel closes while the floating button remains
7. Reopen Gnomeo from the floating button and confirm the bundle is still there
8. Open the **Debug (local fixtures)** section and confirm the session bundle count is `1`
9. Open the Meta fixture in another tab/page
10. Confirm the debug bundle count is still `1` before adding anything
11. Click **Add table** on Meta and confirm the count becomes `2`
12. Open the LinkedIn fixture and repeat
13. Confirm the count becomes `3`
14. Click **Analyse** and confirm all captured platforms are included
15. Click **Clear** and confirm the bundle count resets to `0`

If you need to verify injection, open DevTools on the test page and look for local-only `[Gnomeo]` debug messages in the console.

The debug section is collapsed by default and is intended for local fixture testing only.

## How to load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder in this repo

## Current status

- This is a **local prototype**.
- Ad-platform APIs are **not connected yet**.
- No screenshots are used.
- No background activity is used.
- The extension reads **visible rows only** after you click **Add table**.
- Captured tables live only in panel/session memory.
- `chrome.storage.session` is used for the session bundle, so captured tables should survive tab/page changes but clear when the browser session ends.
- The Chrome side panel is the only review UI and stays open across supported tabs in the same browser window.
- The content script is opener + extraction helper only.
- Campaign-level pages are the MVP default because they usually contain the clearest spend/result signals.
- Extraction may be imperfect because ad-platform UIs change frequently.
- Nothing is sent or stored yet.

## Privacy

- Raw page data is not transmitted.
- Raw extracted rows are not persisted.
- No admin endpoints are exposed.
- No billing, auth, or automation flows are included.
- The bundle stays in `chrome.storage.session` so it survives tab/page changes during the browser session.
- The design stays intentionally small and calm.

## Future direction

The extension is meant to grow into a quiet review layer that sits beside ad platforms and surfaces only what deserves attention.
