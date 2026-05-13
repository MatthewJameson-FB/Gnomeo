# Gnomeo Chrome Extension MVP

A local-loadable prototype for a calm ad-spend review layer.

## What it does

- Adds a small **Review with Gnomeo** button on supported ad-platform pages.
- Opens a lightweight right-side review panel.
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
5. Click **Add visible table** on a campaign page
6. Optionally open another fixture page and click **Add visible table** again
7. Click **Analyse now** or **Analyse captured tables**

If you need to verify injection, open DevTools on the test page and look for local-only `[Gnomeo]` debug messages in the console.

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
- The extension reads **visible rows only** after you click **Add visible table**.
- Captured tables live only in panel/session memory.
- Campaign-level pages are the MVP default because they usually contain the clearest spend/result signals.
- Extraction may be imperfect because ad-platform UIs change frequently.
- Nothing is sent or stored yet.

## Privacy

- Raw page data is not transmitted.
- Raw extracted rows are not persisted.
- No admin endpoints are exposed.
- No billing, auth, or automation flows are included.
- The bundle resets if the panel reloads.
- The design stays intentionally small and calm.

## Future direction

The extension is meant to grow into a quiet review layer that sits beside ad platforms and surfaces only what deserves attention.
