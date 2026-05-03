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
- `output_report.md` — generated report from the latest run

## What the script accepts

You can run it against:
- the bundled sample file, or
- any CSV path you pass in

It reads available columns such as:
- `campaign`
- `ad_set`
- `ad`
- `spend`
- `impressions`
- `clicks`
- `conversions`
- `revenue`

It also supports a few common aliases like `monthly_spend_gbp` and `revenue_gbp`.

## How the test works

The script reads the CSV, then:
- **Profile Interpreter**: converts the business profile into CPA/ROAS thresholds
- **Analyst**: outputs data-only insights, benchmarks, and campaign-group segmentation
- **Strategist**: proposes actions and budget moves only
- **Critic**: challenges the strategist with data/risk concerns only
- **Strategist (refinement)**: updates recommendations once after critique and explicitly addresses concerns
- **Synthesizer**: resolves the disagreement and writes exactly 3 final decisions
- **Evaluation**: scores the output quality and confidence

Flow is fixed:
Profile Interpreter → Analyst → Strategist → Critic → Strategist (refinement) → Synthesizer → Evaluation

Limits:
- one critique round
- one refinement pass
- no recursive loops or open discussion

## Graph Mode vs Simple Mode

### Simple Mode

Default behavior. It runs the existing pipeline exactly as-is and keeps the current output shape unchanged.

### Graph Mode

Enabled with `--graph`. It uses a small explicit state/orchestration layer in `decision_graph.py` so each step writes to state in order.

Why use it:
- better traceability
- clearer control over each step
- easier to inspect confidence / warning handling

Use graph mode when you want the same analysis with more structure. Use simple mode when you want the original behavior unchanged.

## Run it

### Default sample file

```bash
python3 agent_mvp/agent_test.py
```

### Custom CSV path

```bash
python3 agent_mvp/agent_test.py /path/to/your-file.csv
```

## API keys

No API keys are required for this local mock.

If you later wire this into live model calls, use environment variables such as:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Keep secrets out of the repo.

## Output

The run writes:
- `agent_mvp/output_report.md`

## Notes

- This is separate from the landing page.
- Nothing here deploys to the site.
- It is only a proof-of-concept for the workflow.
