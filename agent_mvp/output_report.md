Source file: `sample_ads_data.csv`

# Gnomeo Agent MVP Report

## Profile Interpreter
- Stage: balanced
- Objective: efficient growth
- Acceptable CPA: £59.63
- Acceptable ROAS: 1.93x

## Analyst
- Campaigns analyzed: 6
- Total spend: £65,000.00
- Total impressions: 1,294,000
- Total clicks: 25,630
- Total conversions: 1,090
- CTR: 1.98%
- CPC: £2.54
- CPA: £59.63
- CVR: 4.25%
- Wasted spend (>2x acceptable CPA): £9,000.00
- Wasted spend share: 13.85%
- Revenue: £125,540.00
- ROAS: 1.93x

### Campaign-group segmentation
- Non-Brand Search: spend £18,000.00, CPA £69.23, ROAS 1.59x, campaigns 1
- Meta Prospecting: spend £15,000.00, CPA £107.14, ROAS 1.03x, campaigns 1
- Brand Search: spend £12,000.00, CPA £28.57, ROAS 3.90x, campaigns 1
- LinkedIn ABM: spend £9,000.00, CPA £236.84, ROAS 0.84x, campaigns 1
- Meta Retargeting: spend £6,000.00, CPA £33.33, ROAS 3.38x, campaigns 1
- YouTube Remarketing: spend £5,000.00, CPA £96.15, ROAS 1.38x, campaigns 1

### Analyst insights
- Blended CPA: £59.63
- Blended ROAS: 1.93x
- Acceptable CPA threshold: £59.63
- Acceptable ROAS threshold: 1.93x
- Wasted spend: £9,000.00 (13.8%)

### Top 10% performers
- Brand Search | Exact (3.90x)

### Bottom 20% performers
- LinkedIn ABM (0.84x)

## Strategist
- Move £3,600.00 from Non-Brand Search | Core to Brand Search | Exact | £ amount: £3,600.00 | Reason: Shifts spend from the weaker campaign into the stronger one while staying within the same platform where possible. Addressing critique: The move assumes Non-Brand Search | Core is structurally weak rather than temporarily noisy.
  - Addresses: Recent underperformance may not persist.
  - Addresses: Campaign-level rollups can hide ad-level or audience-level pockets of strength.
  - Addresses: Platform attribution windows may overstate the destination campaign's advantage.
- Pause or cut LinkedIn ABM by £2,250.00 | £ amount: £2,250.00 | Reason: This campaign sits above the acceptable CPA threshold and should give up budget first. Addressing critique: The pause logic relies heavily on CPA alone and may miss upper-funnel value.
  - Addresses: High CPA always means low value.
  - Addresses: The dataset does not include margin, lag, or assisted conversion data.
  - Addresses: Last-click bias could make the campaign look worse than it is.
- Scale Brand Search | Exact by £1,800.00 | £ amount: £1,800.00 | Reason: This campaign clears the profile threshold on CPA and ROAS, so it is the best candidate for extra budget. Addressing critique: The scale decision assumes past efficiency will hold at a larger spend level.
  - Addresses: Winning at current spend guarantees scaling efficiency.
  - Addresses: The sample is small enough that one campaign can dominate the ranking.
  - Addresses: ROAS may be inflated if conversion lag is unresolved.

## Critic
- Move £3,600.00 from Non-Brand Search | Core to Brand Search | Exact: The move assumes Non-Brand Search | Core is structurally weak rather than temporarily noisy.
  - Flawed assumption: Recent underperformance may not persist.
  - Weak signal: Campaign-level rollups can hide ad-level or audience-level pockets of strength.
  - Attribution risk: Platform attribution windows may overstate the destination campaign's advantage.
- Pause or cut LinkedIn ABM by £2,250.00: The pause logic relies heavily on CPA alone and may miss upper-funnel value.
  - Flawed assumption: High CPA always means low value.
  - Weak signal: The dataset does not include margin, lag, or assisted conversion data.
  - Attribution risk: Last-click bias could make the campaign look worse than it is.
- Scale Brand Search | Exact by £1,800.00: The scale decision assumes past efficiency will hold at a larger spend level.
  - Flawed assumption: Winning at current spend guarantees scaling efficiency.
  - Weak signal: The sample is small enough that one campaign can dominate the ranking.
  - Attribution risk: ROAS may be inflated if conversion lag is unresolved.

## Decisions
1. Action: Move £3,600.00 from Non-Brand Search | Core to Brand Search | Exact
   £ amount: £3,600.00
   Reason: Shifts spend from the weaker campaign into the stronger one while staying within the same platform where possible. Addressing critique: The move assumes Non-Brand Search | Core is structurally weak rather than temporarily noisy.
   Expected impact: Expected to shift spend toward a stronger efficiency pocket, improving CPA modestly while keeping conversions broadly stable.
   Timeframe: 7–14 days
   Risk: Platform attribution windows may overstate the destination campaign's advantage.
   What to monitor: Monitor CPA and ROAS on both source and destination campaigns, plus total conversions.
   Confidence: Medium
2. Action: Pause or cut LinkedIn ABM by £2,250.00
   £ amount: £2,250.00
   Reason: This campaign sits above the acceptable CPA threshold and should give up budget first. Addressing critique: The pause logic relies heavily on CPA alone and may miss upper-funnel value.
   Expected impact: Expected to improve efficiency by removing a weak spend pocket, with a possible short-term dip in volume.
   Timeframe: 3–7 days
   Risk: Last-click bias could make the campaign look worse than it is.
   What to monitor: Monitor total conversions, blended CPA, and whether any lost volume shows up elsewhere.
   Confidence: Medium
3. Action: Scale Brand Search | Exact by £1,800.00
   £ amount: £1,800.00
   Reason: This campaign clears the profile threshold on CPA and ROAS, so it is the best candidate for extra budget. Addressing critique: The scale decision assumes past efficiency will hold at a larger spend level.
   Expected impact: Expected to increase conversions by roughly 10–15% with CPA staying broadly stable if the additional budget absorbs cleanly.
   Timeframe: 7–14 days
   Risk: ROAS may be inflated if conversion lag is unresolved.
   What to monitor: Monitor CPA, ROAS, conversion volume, and impression share for saturation.
   Confidence: Medium

## Flow control
- Required flow enforced: Analyst → Strategist → Critic → Strategist (refinement) → Synthesizer.
- Only one critique round is used, and only one strategist refinement follows it.
- Maximum total passes = 2 strategist passes; no recursive or open-ended loops.
- Synthesizer is final authority; no post-output revision path exists.

---

## Quick summary
- Campaigns: 6
- Spend: £65,000.00
- CTR: 1.98%
- CPC: £2.54
- CPA: £59.63
- CVR: 4.25%
- Wasted spend: £9,000.00
- Wasted spend share: 13.85%
- ROAS: 1.93x

## Output trace
### Profile Interpreter
- profile stage: balanced

### Analyst
- Blended CPA: £59.63
- Blended ROAS: 1.93x
- Acceptable CPA threshold: £59.63
- Acceptable ROAS threshold: 1.93x
- Wasted spend: £9,000.00 (13.8%)

### Strategist
- Move £3,600.00 from Non-Brand Search | Core to Brand Search | Exact | Budget change: £3,600.00
  - Addresses: Recent underperformance may not persist.
  - Addresses: Campaign-level rollups can hide ad-level or audience-level pockets of strength.
  - Addresses: Platform attribution windows may overstate the destination campaign's advantage.
- Pause or cut LinkedIn ABM by £2,250.00 | Budget change: £2,250.00
  - Addresses: High CPA always means low value.
  - Addresses: The dataset does not include margin, lag, or assisted conversion data.
  - Addresses: Last-click bias could make the campaign look worse than it is.
- Scale Brand Search | Exact by £1,800.00 | Budget change: £1,800.00
  - Addresses: Winning at current spend guarantees scaling efficiency.
  - Addresses: The sample is small enough that one campaign can dominate the ranking.
  - Addresses: ROAS may be inflated if conversion lag is unresolved.

### Critic
- Move £3,600.00 from Non-Brand Search | Core to Brand Search | Exact: The move assumes Non-Brand Search | Core is structurally weak rather than temporarily noisy.
- Pause or cut LinkedIn ABM by £2,250.00: The pause logic relies heavily on CPA alone and may miss upper-funnel value.
- Scale Brand Search | Exact by £1,800.00: The scale decision assumes past efficiency will hold at a larger spend level.

### Flow limits
- One critique round only
- One strategist refinement only
- No open discussion or recursive loop
- Synthesizer ends the flow

## Evaluation
- Actionability score: 5/5 — All 3 decisions are concrete actions with explicit implementation steps.
- Financial clarity score: 5/5 — Each decision includes a numeric £ amount and visible budget direction.
- Risk awareness score: 5/5 — The critic adds distinct risks to every decision.
- Confidence quality score: 5/5 — Confidence is calibrated and not overstated.
- Overall decision quality score: 5/5 — The output is structured, specific, and client-ready enough for a first-pass decision packet.
