<div align="center">
  <br/>
  <img src="https://img.shields.io/badge/Kira_Financial_AI-AML_Bot-1A56DB?style=for-the-badge&labelColor=0D1117" alt="Kira AML Bot"/>
  <br/><br/>

  [![Node](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
  [![Render](https://img.shields.io/badge/Render-deployed-46E3B7?style=flat-square&logo=render&logoColor=white)](https://render.com)
  [![SumSub](https://img.shields.io/badge/SumSub-KYT_API-0052CC?style=flat-square)](https://sumsub.com)
  [![Rules](https://img.shields.io/badge/Detection_Rules-v2-6366F1?style=flat-square)]()
  [![Frameworks](https://img.shields.io/badge/FATF_%7C_FinCEN_%7C_ACAMS_%7C_FFIEC-compliance-blue?style=flat-square)]()

  <br/>

  > *An automated, on-demand compliance system that surfaces money-laundering patterns across all your SumSub transactions — with risk scores, transaction IDs, and consolidated RFIs ready for your compliance team.*

  <br/>
</div>

---

## Overview

The Kira AML Bot connects directly to your SumSub KYT account, pulls every transaction in the selected period, and runs a statistical and pattern-based detection engine across all entities. The results are delivered as an interactive dashboard — flags organized by risk tier, each one expandable to show the full rationale, the exact SumSub and internal transaction IDs involved, and a downloadable RFI letter for Tier 4+ entities.

The system is fully stateless. There is no database, no file storage, and no manual data export. Every run starts from a live SumSub fetch.

---

## Interface

**Dashboard** — KPI cards, flags by category, risk tier distribution, and the top five highest-risk entities ranked by composite score.

![Dashboard](https://raw.githubusercontent.com/raghavashok24/Aegis/main/docs/dashboard.png)

**Flag Review** — every flag across all entities, filterable by severity, category, and SAR risk. Each card expands to show the detection rationale, both SumSub and internal transaction IDs with direct cockpit links, and the RFI panel.

![Flags](https://raw.githubusercontent.com/raghavashok24/Aegis/main/docs/flags.png)

**Month Picker** — choose any combination of months and year, or use Prior Month / Prior Quarter shortcuts. Multi-month selections run sequential evaluations with independent baselines per period.

![Month Picker](https://raw.githubusercontent.com/raghavashok24/Aegis/main/docs/picker.png)

---

## How it works

```
  Browser (your Render URL)
        │
        │  POST /analyze
        ▼
  Render Backend  ──── HMAC-SHA256 ────►  SumSub KYT API
        │                                  (all transactions)
        │
        ├─ Groups transactions by applicant
        ├─ Classifies entities (Established / New / Dormant-returning)
        ├─ Builds per-entity statistical baselines (6 months or 4 quarters)
        ├─ Runs detection rules across all categories
        ├─ Deduplicates correlated flags into clusters
        ├─ Scores each entity 0–100 with tier gates
        └─ Generates consolidated RFI for Tier 4+ entities
        │
        ▼
  Dashboard  (flags · transaction IDs · risk tiers · RFI downloads)
```

---

## Entity classification

Before any rule evaluates, every entity is classified based on its transaction history. This gate eliminates the majority of false positives from thin-baseline edge cases.

| Class | Definition | Treatment |
|-------|-----------|-----------|
| Established | Tenure in data AND 8+ baseline txns across 2+ baseline months | Full statistical ruleset |
| New | Fails the baseline gate | Behavioral rules do not apply — routes to enhanced due diligence |
| Dormant-returning | Established history, then fewer than 3 tx/period for 2+ consecutive periods | Dormancy rule eligible |

The baseline window is trailing 6 months for monthly runs and trailing 4 quarters for quarterly runs, computed per entity.

Multi-month requests (e.g. Feb–Jun) run as five sequential monthly evaluations each with their own independent rolling baseline. Results are then merged per entity.

---

## Detection rules

### Behavioral deviation

Applies to Established entities only. All behavioral rules default to Medium severity and promote to High only when the deviation reaches 3× baseline or when a co-occurring Structuring or Network flag is present.

| Rule | Trigger |
|------|---------|
| Volume Spike | Count > μ + 2σ, and ≥ 2× baseline mean, and absolute count ≥ 10 |
| Amount Spike | Volume > μ + 2σ, and ≥ 2× baseline mean, and ≥ $25K above baseline mean |
| Velocity Escalation | Weekly cadence ≥ 2× baseline, baseline ≥ 5 tx/week, sustained ≥ 2 consecutive weeks |
| Size Threshold Jump | Avg tx > 150% of prior avg, prior period had ≥ 8 tx, avg increase ≥ $5K |
| Concentration Risk | >70% outbound to single beneficiary, ≥ 10 outbound tx, co-occurring flag required |
| Round-Dollar Clustering | >60% of tx at exact round amounts, ≥ 10 tx, co-occurring flag required |
| Dormancy Transition | Established prior activity, dormant ≥ 2 periods, then ≥ 5 tx and ≥ $25K |
| Temporal Concentration | >60% of quarterly volume in one month, quarterly volume ≥ $100K, ≥ 15 tx *(quarterly only)* |

### Structuring & layering

Applies to all entities. All flags cite 31 U.S.C. § 5324. Every rule requires sub-threshold component amounts — structuring is specifically about evading the $10K reporting threshold.

| Rule | Trigger |
|------|---------|
| Structuring Index | ≥ 30% of tx in $8K–$9,999 band, ≥ 4 tx in band, entity median tx < $15K |
| 72-Hour Clustering | ≥ 3 tx each $3K–$9,999, same direction, within 72h, aggregate > $10K |
| Frequency & Uniformity | ≥ 5 tx with <5% amount variance, each < $10K, not matching a recurring payroll/rent/subscription cadence |
| Split Payments | ≥ 2 payments to same beneficiary within 72h, each $3K–$9,999, aggregate > $10K |

### Network & flow patterns

Applies to all entities. These rules detect multi-party money movement typologies through directed flow analysis.

| Rule | Trigger | Severity |
|------|---------|---------|
| Reciprocal Payment | Bidirectional flows within 20%, each leg ≥ $10K | Medium |
| Reciprocal — Escalated | Same, within 7 days | High |
| Pass-Through / Transit | Inbound forwarded to different party within 48h, ≤ 10% retention, amount ≥ $10K, pattern ≥ 2× in period | High |
| Pass-Through (single occurrence) | Same conditions but only one instance | Medium |
| Net Flow Near-Zero | In/out within 10% on > $50K, ≥ 10 tx each direction | High |

---

## Risk scoring

### Flag deduplication

Before scoring, flags sharing more than 50% of their underlying transaction IDs are clustered together. Each cluster contributes to the score exactly once, at its highest-severity member. This prevents correlated flags on the same transactions from stacking into artificially inflated scores.

### Composite score

```
 First cluster:        High → 25 pts    Medium → 10 pts
 Each additional:      High → +12 pts   Medium → +5 pts
 Cross-category bonus: +10 if clusters span 2 or more categories
 Structuring bonus:    +5 per structuring cluster
                       ──────────────────────────────
                       capped at 100
```

### Tier gates

| Score | Tier | Label | Action | Gate |
|-------|------|-------|--------|------|
| 0–25 | 1 | No Action | Monitor & close | — |
| 26–50 | 2 | Enhanced Monitoring | Increase review cadence | — |
| 51–74 | 3 | Investigator Escalation | Assign investigator | Requires ≥ 2 independent clusters |
| 75–89 | 4 | SAR Consideration | 30-day investigation window | Requires ≥ 2 categories represented |
| 90–100 | 5 | Mandatory SAR | File SAR + relationship review | Requires a Structuring or Network cluster |

Behavioral deviation alone cannot mandate a SAR filing. The Tier 5 gate explicitly requires at least one Structuring or Network cluster.

---

## Transaction IDs

Every flag surfaces both the SumSub-side transaction ID and your internal transaction ID, extracted directly from the SumSub API response.

| Field | API Source | Use |
|-------|-----------|-----|
| SumSub ID | `txn.id` (root level) | Clickable link to SumSub cockpit |
| Internal ID | `txn.data.txnId` | Your own reference ID |

In the flag panel each transaction is shown as a labeled row with a direct cockpit link. Both ID types appear in the `.csv` export columns and in every RFI letter.

---

## RFI generation

RFIs are consolidated per entity — one letter covering all flag clusters — and are generated only for Tier 4 and above. The letter is structured in two parts:

**Part 1 — Why the RFI was issued** covers the flags detected, which thresholds were crossed, the regulatory basis for the request, and a SAR risk notice (31 U.S.C. § 5318(g)) where applicable.

**Part 2 — What the client must provide** lists numbered questions tailored to the categories flagged. Structuring flags add questions on sub-threshold amount choices and underlying commercial obligations. Network flags add questions on the entity's economic role as an intermediate party. All entities receive standard questions on source of funds, third-party direction, and business activity.

---

## Deploy

### 1. Repository structure

Your GitHub repo root must contain:

```
server.js          ← backend API + AML detection engine
package.json       ← Node 20, Express 4.18
.gitignore
public/
  index.html       ← frontend dashboard (served by Express)
```

### 2. Create a Render Web Service

| Setting | Value |
|---------|-------|
| Build command | `npm install` |
| Start command | `node server.js` |
| Instance type | Free |

### 3. Add environment variables

In Render → your service → **Environment** tab:

| Variable | Where to find it |
|----------|-----------------|
| `SUMSUB_TOKEN` | SumSub → avatar → Developer → App tokens → Token |
| `SUMSUB_SECRET` | SumSub → avatar → Developer → App tokens → Secret Key |

### 4. Verify

```
GET https://your-service.onrender.com/health
→ { "ok": true, "credentials": "configured" }
```

Open your Render URL — the dashboard loads directly from `/`. No separate HTML file needed.

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the dashboard |
| `/health` | GET | Health check and credentials status |
| `/analyze` | POST | Runs the full detection pipeline |
| `/export/rfi` | POST | Downloads consolidated entity RFI as `.txt` |
| `/debug` | GET | Shows filesystem layout on Render (troubleshooting) |

**`POST /analyze` body:**

```json
{ "mode": "monthly" }
{ "mode": "quarterly" }
{ "mode": "custom", "customStart": "2026-03", "customEnd": "2026-05" }
```

---

## Outputs

| File | Format | Contents |
|------|--------|---------|
| Summary report | `.txt` | Executive summary, flags by category, tier distribution, top 5 entities, High-severity rationales with both transaction ID types |
| Flags export | `.csv` | Flag ID, Applicant ID, Rule, Category, Severity, Score, Tier, SAR Risk, Action, SumSub Txn IDs, Internal Txn IDs, Counterparties, Rationale |
| RFI letter | `.txt` per entity | Consolidated letter covering all flag clusters, Tier 4+ only |

---

## Security

API keys are stored exclusively in Render's environment variables and never appear in code, GitHub, or any API response. Every request to SumSub is signed with HMAC-SHA256 using the pattern `timestamp + METHOD + path + body`. The system is fully stateless — no data is persisted between runs.

---

## Regulatory references

| Framework | Coverage |
|-----------|---------|
| FATF Recommendations | Structuring typologies, risk-based approach, trade-based money laundering |
| FinCEN / BSA | 31 U.S.C. § 5324 (structuring), § 5318(g) (SAR filing obligations) |
| ACAMS | Periodic review dashboards, lookback data points |
| FFIEC AML Manual | Threshold calibration, independent validation |
| NY DFS Part 504 | Ongoing scenario relevance, threshold documentation |

---

<div align="center">
  <br/>
  <sub>Kira Financial AI · AML Compliance · Detection Rules v2 · July 2026</sub>
  <br/>
  <sub><i>This system surfaces indicators for compliance review. All SAR filing decisions require human officer review.</i></sub>
  <br/><br/>
</div>
