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

## What it is

The Kira AML Bot is a production compliance tool that connects directly to your SumSub KYT account, analyzes every transaction in the selected review period, and delivers a ranked set of flags with risk scores, detection rationales, clickable transaction IDs, and formal RFI letters — all without any manual data export or database.

The entire system lives in two files: a Node.js backend that handles SumSub authentication and the detection engine, and an HTML frontend served directly from the same Render deployment. Open your Render URL in a browser and the dashboard loads immediately.

---

## Interface

The dashboard has two views.

**Dashboard** shows KPI cards (applicants, transactions, total flags, SAR-risk count, Tier 4–5 entities), a flags-by-category bar chart, a risk tier distribution grid, and a table of the top five highest-risk entities ranked by composite score. A month picker lets you select any combination of months and year, or use Prior Month and Prior Quarter shortcuts. After a run, one-click exports produce a summary `.txt` report and a full flags `.csv`.

**Flag Review** lists every flag across all entities. Each card shows the flag ID, severity, category, rule name, and SAR indicator. Expanding a card reveals the full detection rationale, the SumSub and internal transaction IDs involved (with direct links to the SumSub cockpit), counterparties, and — for Tier 4+ entities — a consolidated RFI letter downloadable as `.txt`.

---

## Architecture

```
  Browser
      │
      │  POST /analyze
      ▼
  Render (Node.js + Express)
      │
      ├── Authenticates every request to SumSub with HMAC-SHA256
      ├── Fetches all transactions in the review window (paginated)
      ├── Groups transactions by applicant ID
      ├── Classifies each entity (Established / New / Dormant-returning)
      ├── Builds per-entity statistical baseline (μ, σ) from prior periods
      ├── Runs detection rules across three categories
      ├── Deduplicates correlated flags into clusters
      ├── Scores each entity 0–100 with tier gates
      └── Generates consolidated RFI for Tier 4+ entities
      │
      ▼
  JSON response → Dashboard renders results
```

The system is fully stateless. No database, no file storage, no cached baselines. Every run is a fresh fetch from SumSub.

**Stack:** Node.js 20, Express 4.18, SumSub KYT API, React 18 (CDN, no bundler), deployed on Render.

---

## Entity classification

Every entity is classified before any rule runs. This gate prevents statistical rules from firing on entities with insufficient history.

| Class | Criteria | Treatment |
|-------|---------|-----------|
| Established | Passes the minimum sample gate (8+ baseline txns across 2+ months) | Full detection ruleset |
| New | Fails the sample gate | Behavioral rules skipped — routes to enhanced due diligence track |
| Dormant-returning | Established history followed by fewer than 3 tx/period for 2+ periods | Eligible for Dormancy Transition rule |

The baseline window is the trailing 6 months for monthly runs and trailing 4 quarters for quarterly runs. Multi-month requests run as sequential monthly evaluations, each with its own independent rolling baseline, then merge results per entity.

---

## Detection rules

### Behavioral deviation

Applies to Established entities only. All behavioral rules default to Medium severity. They promote to High when the deviation reaches 3× baseline or when a co-occurring Structuring or Network flag is present.

| Rule | Trigger |
|------|---------|
| Volume Spike | Count > μ + 2σ, ≥ 2× baseline mean, absolute count ≥ 10 |
| Amount Spike | Volume > μ + 2σ, ≥ 2× baseline mean, ≥ $25K above baseline mean |
| Velocity Escalation | Weekly cadence ≥ 2× baseline, baseline ≥ 5 tx/week, sustained ≥ 2 consecutive weeks |
| Size Threshold Jump | Avg tx > 150% of prior avg, prior period ≥ 8 tx, avg increase ≥ $5K |
| Concentration Risk | >70% outbound to single beneficiary, ≥ 10 outbound tx, co-occurring flag required |
| Round-Dollar Clustering | >60% of tx at exact round amounts, ≥ 10 tx, co-occurring flag required |
| Dormancy Transition | Established prior activity, dormant ≥ 2 periods, then ≥ 5 tx and ≥ $25K |
| Temporal Concentration | >60% of quarterly volume in one month, ≥ $100K quarterly volume, ≥ 15 tx *(quarterly only)* |

### Structuring & layering

Applies to all entities. All flags cite 31 U.S.C. § 5324. Every rule requires sub-threshold component amounts — structuring is specifically about evading the $10K reporting threshold.

| Rule | Trigger |
|------|---------|
| Structuring Index | ≥ 30% of tx in $8K–$9,999 band, ≥ 4 tx in band, entity median tx < $15K |
| 72-Hour Clustering | ≥ 3 tx each $3K–$9,999, same direction, within 72h, aggregate > $10K |
| Frequency & Uniformity | ≥ 5 tx with <5% amount variance, each < $10K, not matching a recurring payroll/rent cadence |
| Split Payments | ≥ 2 payments to same beneficiary within 72h, each $3K–$9,999, aggregate > $10K |

### Network & flow patterns

Applies to all entities. Detects multi-party typologies through directed flow analysis.

| Rule | Trigger | Severity |
|------|---------|---------|
| Reciprocal Payment | Bidirectional flows within 20%, each leg ≥ $10K | Medium |
| Reciprocal — Escalated | Same, within 7 days | High |
| Pass-Through / Transit | Inbound forwarded within 48h, ≤ 10% retention, ≥ $10K, ≥ 2× in period | High |
| Pass-Through (single) | Same, only 1 occurrence | Medium |
| Net Flow Near-Zero | In/out within 10% on > $50K, ≥ 10 tx each direction | High |

---

## Risk scoring

### Deduplication

Flags sharing more than 50% of their underlying transaction IDs are clustered together before scoring. Each cluster scores once at its highest severity, preventing correlated flags on the same transactions from stacking.

### Score formula

```
 First cluster:        High → 25 pts    Medium → 10 pts
 Each additional:      High → +12 pts   Medium → +5 pts
 Cross-category bonus: +10 if clusters span 2+ categories
 Structuring bonus:    +5 per structuring cluster
                       ──────────────────────────────
                       capped at 100
```

### Tiers

| Score | Tier | Label | Gate |
|-------|------|-------|------|
| 0–25 | 1 | No Action | — |
| 26–50 | 2 | Enhanced Monitoring | — |
| 51–74 | 3 | Investigator Escalation | ≥ 2 independent clusters |
| 75–89 | 4 | SAR Consideration | ≥ 2 categories represented |
| 90–100 | 5 | Mandatory SAR | Structuring or Network cluster required |

Behavioral deviation alone cannot mandate a SAR filing.

---

## Transaction IDs

Every flag surfaces both transaction ID types from the SumSub API.

| ID | API field | Use |
|----|----------|-----|
| SumSub ID | `txn.id` | Links directly to the SumSub cockpit |
| Internal ID | `txn.data.txnId` | Your own reference ID |

Both appear in the flag detail panel, in the `.csv` export, and in the RFI letter.

---

## RFI letters

RFIs are consolidated per entity — one letter covering all flag clusters — generated only for Tier 4 and above.

Part 1 states which patterns were detected, which thresholds were crossed, and the regulatory basis. Part 2 lists numbered questions tailored to the categories flagged: Structuring flags add questions on sub-threshold amount choices and underlying commercial obligations; Network flags add questions on the entity's economic role as an intermediate party; all entities receive questions on source of funds, third-party direction, and business activity changes.

---

## Regulatory references

| Framework | Coverage |
|-----------|---------|
| FATF Recommendations | Structuring typologies, risk-based approach, TBML |
| FinCEN / BSA | 31 U.S.C. § 5324 (structuring), § 5318(g) (SAR obligations) |
| ACAMS | Periodic review, lookback data points |
| FFIEC AML Manual | Threshold calibration, independent validation |
| NY DFS Part 504 | Scenario relevance, threshold documentation |

---

## Deploy

### Repository structure

```
server.js        ← backend + detection engine
package.json
.gitignore
public/
  index.html     ← frontend dashboard
```

### Render setup

1. Create a new **Web Service** on Render, connected to this GitHub repo
2. Set build command to `npm install` and start command to `node server.js`
3. Add `SUMSUB_TOKEN` and `SUMSUB_SECRET` under the **Environment** tab
4. Deploy — the dashboard is available at your Render URL immediately

### Verify

```
GET /health  →  { "ok": true, "credentials": "configured" }
```

---

## Outputs

| File | Contents |
|------|---------|
| Summary `.txt` | Executive summary, flags by category, tier distribution, top 5 entities, full High-severity rationales |
| Flags `.csv` | Every flag with Flag ID, Applicant, Rule, Severity, Score, Tier, SAR Risk, SumSub Txn IDs, Internal Txn IDs, Rationale |
| RFI `.txt` | Consolidated entity letter, Tier 4+ only |

---

<div align="center">
  <br/>
  <sub>Kira Financial AI · AML Compliance · Detection Rules v2 · July 2026</sub>
  <br/>
  <sub><i>This system surfaces indicators for compliance review. All SAR filing decisions require human officer review.</i></sub>
  <br/><br/>
</div>
