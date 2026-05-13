# Extension Roadmap

## MVP direction
Build a local-loadable Chrome extension prototype first.

Principles:
- MV3
- Chrome side panel as the only review UI
- optional floating "Review with Gnomeo" opener button
- toolbar icon can open the same panel
- persistent side panel review flow
- visible DOM/table extraction only
- local-only initially
- user-triggered only
- no screenshots
- no OCR
- no backend calls for extracted page data yet
- no storage of extracted rows
- no Google/Meta/LinkedIn API connections

## Review flow
1. User opens a supported ad platform page.
2. User clicks "Review visible table".
3. Extension detects platform and extracts visible table text.
4. Extension previews up to 5 rows.
5. Extension shows concise analyst summary in a persistent side panel.
6. User may optionally save the derived review to the private workspace via a token-scoped endpoint.

## Extraction principles
- use DOM/table extraction, not screenshots
- extract visible text only
- show platform detected
- show rows/columns detected
- show likely metric columns
- keep raw table display out of the UI

## Local fixture targets
Test on localhost with fake platform pages:
- Google Ads campaigns table
- Meta Ads campaigns table
- LinkedIn campaigns table
- no-table failure page

### Google Ads default table
Columns like:
- Campaign
- Cost
- Impr.
- Clicks
- CTR
- Avg. CPC
- Conversions
- Cost / conv.
- Conv. value
- Conv. value / cost

### Meta Ads default table
Columns like:
- Campaign name
- Delivery
- Budget
- Amount spent
- Results
- Cost per result
- Reach
- Impressions
- Link clicks
- CTR
- CPC
- Purchase conversion value
- ROAS

### LinkedIn Ads default table
Columns like:
- Campaign name
- Status
- Total spent
- Impressions
- Clicks
- Average CTR
- Average CPC
- Conversions
- Cost per conversion

## Later additions
- improve reliability across semantic table, ARIA grid, and div-based rows
- refine extension panel UX
- later expand safe backend review storage only if the token-scoped save flow needs more fields
- later add platform APIs only if the product direction changes

## Current architecture
- Chrome side panel is the only review UI.
- The content script is opener + extraction helper only.
- A minimal service worker opens the side panel from opener clicks.
- Session state lives in `chrome.storage.session`.
- Optional workspace connection lives in `chrome.storage.local`.
- Only the user-triggered save action sends a compact derived review to the private workspace.
- No background capture.
- No screenshots.
- No raw rows, raw HTML, or screenshots in saved workspace data.
