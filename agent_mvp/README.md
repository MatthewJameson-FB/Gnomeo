# Gnomeo Agent MVP

This folder is a **local test harness** for the Gnomeo ad-performance workflow.

## Why this pattern

For this MVP, the easiest reusable reference is the **GTM / launch intelligence style**:
- `product_launch_intelligence_agent` is already organized around turning noisy inputs into concise action plans.
- `multi_agent_trust_layer` adds the review gate / policy mindset we want for a human-reviewed workflow.

That maps cleanly to:
1. Analyst
2. Strategist
3. Critic
4. Synthesizer

## What’s inside

- `sample_ads_data.csv` — realistic mock campaign data
- `agent_test.py` — local Python script that runs the four-step mock workflow
- `README.md` — this guide

## How the test works

The script reads the CSV, then:
- **Analyst**: calculates ROAS, CPA, CTR, CVR, winners, losers
- **Strategist**: turns the analysis into priority actions
- **Critic**: flags risks, attribution caveats, and missing data
- **Synthesizer**: merges it into a final recommendation summary

## Run it

```bash
python3 agent_mvp/agent_test.py
```

## API keys

No API keys are required for this local mock.

If you later wire this into live model calls, use environment variables such as:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Keep secrets out of the repo.

## Notes

- This is separate from the landing page.
- Nothing here deploys to the site.
- It is only a proof-of-concept for the workflow.
