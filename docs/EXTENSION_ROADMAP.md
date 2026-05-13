# Extension Roadmap

## MVP direction
Build a local-loadable Chrome extension prototype first.

Principles:
- MV3
- floating "Review with Gnomeo" button
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
6. Nothing is transmitted until a safe backend endpoint is explicitly designed later.

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
- later add safe backend review storage
- later add platform APIs only if the product direction changes
