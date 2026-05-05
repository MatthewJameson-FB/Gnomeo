# Gnomeo Real Data Testing Checklist

Use this when validating Gnomeo with 3–5 real Google Ads / Meta Ads exports.

## 1) CSVs to collect

Collect 3–5 exports that cover different shapes of real account data:
- 1 Google Ads export with campaigns and spend/conversion data
- 1 Google Ads export with ad groups or asset groups if available
- 1 Meta Ads export with campaigns/ad sets/ads
- 1 export with mixed formatting or currency symbols
- 1 export with sparse or messy rows if the account has them

Prefer:
- recent date ranges
- one export per platform format
- files that represent real marketer workflows, not cleaned samples

## 2) Expected Google Ads columns

Common useful columns:
- Campaign
- Campaign type
- Ad group
- Impressions
- Clicks
- Conversions
- Cost
- Cost / conv.
- Conv. value
- Conversion rate
- CTR
- CPC
- ROAS

Optional but useful:
- Campaign status
- Account
- Network
- Date
- Currency

## 3) Expected Meta Ads columns

Common useful columns:
- Campaign name
- Ad set name
- Ad name
- Impressions
- Link clicks
- Clicks
- Amount spent
- Results
- Cost per result
- Purchase conversion value
- ROAS
- CTR
- CPC

Optional but useful:
- Delivery
- Objective
- Attribution setting
- Date
- Currency

## 4) Run inspect_ingestion.py

For each CSV:

```bash
python3 agent_mvp/inspect_ingestion.py path/to/export.csv
```

Look for:
- detected platform
- analysis mode
- segment count
- normalized campaign names
- warnings
- blocking errors
- stable contract fields

## 5) Verify normalized rows

Check that normalized output makes sense:
- campaign names are grouped consistently
- platform is detected correctly
- cost/spend values are numeric
- ROAS or CPA mode matches the export type
- duplicate rows are not double-counted
- missing fields are handled without crashing
- bad rows are either normalized or clearly flagged

A good sign:
- the same campaign always maps to the same normalized label
- the summary totals look plausible against the source CSV

## 6) Run agent_test.py with audit

For each export:

```bash
python3 agent_mvp/agent_test.py --graph path/to/export.csv --audit
```

Check:
- the CLI completes successfully
- report files are written
- audit output is readable
- unsafe recommendations are blocked or downgraded
- warnings are about real trust issues, not filler noise

## 7) Pass / fail criteria

### Pass
- ingestion completes
- normalized rows look sane
- audit output is readable
- safe recommendations are not blocked
- obvious bad recommendations are blocked or downgraded
- report generation succeeds

### Fail
- ingestion crashes
- platform detection is wrong
- normalized totals are clearly wrong
- audit misses a clearly unsafe recommendation
- audit blocks everything for no good reason
- report generation fails

## 8) Feedback to ask marketers

Ask marketers:
- Does the campaign grouping match how they think about the account?
- Are the top recommendations directionally sensible?
- Are any warnings confusing or noisy?
- Do they trust the suggested metric basis (CPA vs ROAS)?
- Would they act on the report as written?
- What is missing before they would use it in a real review?

## 9) Bugs to log

Log bugs when you see:
- wrong platform detection
- broken campaign grouping
- wrong currency handling
- missing or duplicated normalized rows
- audit warnings that are too noisy or too vague
- recommendations that are unsafe but not blocked
- recommendations that are blocked when they should be allowed
- report output that is confusing or incomplete

## 10) Suggested test order

1. Run a Google Ads export through inspect_ingestion.py
2. Run a Meta Ads export through inspect_ingestion.py
3. Compare normalized rows against the raw CSVs
4. Run agent_test.py with --audit
5. Review the generated report text and HTML
6. Record bugs and marketer feedback

## Notes

Keep the first round simple:
- start with 3 exports
- do one Google Ads and one Meta Ads test before adding edge cases
- only expand to messier exports after the basic flow is stable
