# Gnomeo Chrome Extension MVP

A local-loadable prototype for a calm ad-spend review layer.

## What it does

- Adds a small **Review with Gnomeo** button on supported ad-platform pages.
- Opens a lightweight right-side review panel.
- Lets you paste or upload a CSV export.
- Shows a concise review summary:
  - Top finding
  - Key signals
  - What deserves attention
  - What changed since last review
  - Privacy note

## Supported pages

- Google Ads
- Meta Business / Ads Manager
- LinkedIn Campaign Manager

## How to load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder in this repo
5. Open a supported ad platform and click **Review with Gnomeo**

## Current status

- This is a **local prototype**.
- Ad-platform APIs are **not connected yet**.
- The first version uses **mocked review data** until you paste or upload a CSV export.
- Review comparisons are stored only as **compact local summaries** in the browser.

## Privacy

- Raw CSV rows are not stored.
- No admin endpoints are exposed.
- No billing, auth, or automation flows are included.
- The design stays intentionally small and calm.

## Future direction

The extension is meant to grow into a quiet review layer that sits beside ad platforms and surfaces only what deserves attention.
