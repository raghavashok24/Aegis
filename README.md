<div align="center">
  <br/>
  <img src="https://img.shields.io/badge/Kira_Financial_AI-AML_Bot-1A56DB?style=for-the-badge&labelColor=0D1117" alt="Kira AML Bot"/>
  <br/><br/>

  [![Node](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
  [![Render](https://img.shields.io/badge/Render-deployed-46E3B7?style=flat-square&logo=render&logoColor=white)](https://render.com)
  [![SumSub](https://img.shields.io/badge/SumSub-KYT_API-0052CC?style=flat-square)](https://sumsub.com)
  [![Rules](https://img.shields.io/badge/Rules-v2_(Feb--Jun_2026_backtest)-6366F1?style=flat-square)]()
  [![Frameworks](https://img.shields.io/badge/FATF_%7C_FinCEN_%7C_ACAMS_%7C_FFIEC-compliance-blue?style=flat-square)]()

  <br/>

  > *An automated, on-demand compliance system that surfaces money-laundering patterns across all your SumSub transactions — with RFIs and risk scores ready for your compliance team.*

  <br/>
</div>

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
        ├─ Builds per-entity statistical baselines (μ, σ) — 6mo / 4q
        ├─ Runs detection rules — v2 ruleset
        ├─ Deduplicates correlated flags into clusters
        ├─ Scores each entity 0–100 with tier gates
        └─ Generates consolidated RFI (Tier 4+ only)
        │
        ▼
  Dashboard  (flags · risk tiers · transaction IDs · RFI downloads)
```

No database. No CSV uploads. Fully stateless — every run fetches live from SumSub.

---

## Entity classification (v2 §0)

Before any rule runs, every entity is classified. This eliminates the majority of false positives from v1.

| Class | Definition | Treatment |
|-------|-----------|-----------|
| **Established** | ≥ 3 months tenure AND ≥ 8 baseline txns across ≥ 2 baseline months | Full statistical ruleset |
| **New** | < 3 months tenure OR fails baseline gate | New Entity Track — behavioral rules do not apply |
| **Dormant-returning** | Established history, then < 3 tx/period for ≥ 2 periods | Dormancy rule eligible |

**Baseline window:** trailing 6 months (monthly runs) or 4 quarters (quarterly runs) per entity.

**Multi-month requests:** a request like "Feb–Jun" runs 5 sequential monthly evaluations each with its own rolling baseline, then merges results per entity.

> v1 bug fixed: entities with *no* history were classified as "dormant," causing onboarding ramp-up to fire Dormancy Transition (156 false flags). No history = New, not Dormant.

---

## Detection rules (v2)

### 🔴 Behavioral deviation
Established entities only. All default to **Medium** severity. Promote to High only when ≥ 3× baseline or co-occurring with a Structuring or Network flag.

| Rule | v2 Trigger |
|------|-----------|
| Volume Spike | Count > μ + 2σ **AND ≥ 2× baseline mean AND absolute count ≥ 10** |
| Amount Spike | Volume > μ + 2σ **AND ≥ 2× baseline mean AND ≥ $25K above baseline mean** |
| Velocity Escalation | Weekly cadence ≥ 2× baseline **AND baseline ≥ 5 tx/week AND sustained ≥ 2 consecutive weeks** |
| Size Threshold Jump | Avg tx > 150% of prior avg **AND prior period had ≥ 8 tx AND avg increase ≥ $5K** |
| Concentration Risk | > 70% outbound to single beneficiary **AND ≥ 10 outbound tx AND ≥ 1 co-occurring flag from another category** |
| Round-Dollar Clustering | > 60% of tx at exact round amounts **AND ≥ 10 tx AND ≥ 1 co-occurring flag** |
| Dormancy Transition | Established prior activity, dormant ≥ 2 periods, then ≥ 5 tx AND ≥ $25K |
| Temporal Concentration | > 60% of quarterly volume in one month **AND quarterly volume ≥ $100K AND ≥ 15 tx** *(quarterly only)* |

### 🟣 Structuring & layering
All flags cite **31 U.S.C. § 5324**. Every rule requires sub-threshold component amounts — structuring is about evading the $10K reporting threshold.

| Rule | v2 Trigger |
|------|-----------|
| Structuring Index | ≥ 30% of tx in $8K–$9,999 band **AND ≥ 4 tx in band AND entity median tx < $15K** |
| 72-Hour Clustering | ≥ 3 tx each $3K–$9,999, same direction, within 72h **AND aggregate > $10K** |
| Frequency & Uniformity | ≥ 5 tx with < 5% variance **AND each < $10K AND not matching recurring cadence (payroll/rent/subscription)** |
| Split Payments | ≥ 2 payments to same beneficiary within 72h **each $3K–$9,999 AND aggregate > $10K** |

### 🔵 Network & flow patterns
These performed best in the v1 backtest. Minor floors added.

| Rule | v2 Trigger | Severity |
|------|-----------|---------|
| Reciprocal Payment | Bidirectional flows within 20% **AND each leg ≥ $10K** | Medium |
| Reciprocal — Escalated | Same, within 7 days | High |
| Pass-Through / Transit | Inbound → different party within 48h ≤ 10% retention **AND amount ≥ $10K AND pattern ≥ 2× in period** | High |
| Pass-Through (single) | Same as above but only 1 occurrence | Medium |
| Net Flow Near-Zero | In/out within 10% on > $50K **AND ≥ 10 tx each direction** | High |

---

## Risk scoring (v2)

### Flag deduplication
Before scoring, flags sharing > 50% of underlying transaction IDs are clustered together. Each cluster contributes **once** at its highest-severity member. This fixes v1's correlated-flag stacking (e.g. Volume + Amount + Dormancy + Velocity firing on the same transactions = instant score cap).

### Composite score

```
 First cluster:       High → 25 pts    Medium → 10 pts
 Each additional:     High → +12 pts   Medium → +5 pts
 Cross-category bonus: +10 if clusters span ≥ 2 of {Behavioral, Structuring, Network}
 Structuring bonus:   +5 per structuring cluster
                      ─────────────────────────────
                      capped at 100
```

### Tier gates

```
 Score    Tier   Label                      Action                  Gate
 ──────   ────   ─────────────────────────  ──────────────────────  ─────────────────────────────────
  0–25     1     No Action                  Monitor & close         —
 26–50     2     Enhanced Monitoring        Increase review cadence —
 51–74     3     Investigator Escalation    Assign investigator     Requires ≥ 2 independent clusters
 75–89     4     SAR Consideration          30-day window           Requires ≥ 2 categories represented
 90–100    5     Mandatory SAR              File SAR + review       Requires a Structuring or Network cluster
```

> Behavioral deviation alone can **never** mandate a SAR.

---

## Transaction IDs

Every flag surfaces both SumSub's internal ID and your own internal transaction ID, extracted directly from the SumSub API response.

| Field | Source | Use |
|-------|--------|-----|
| `SumSub ID` | `txn.id` (root level) | Clickable link to SumSub cockpit |
| `Internal ID` | `txn.data.txnId` | Your own reference ID |

In the dashboard each flagged transaction is shown as a clickable row:
```
SumSub   67fe5cbd3d428fcef242df51  →  opens cockpit.sumsub.com/...
Internal finance0001
```

Both IDs are included in every `.csv` export and every `.txt` RFI letter.

---

## RFI generation (v2)

RFIs are now **consolidated per entity** (not per flag) and triggered only for **Tier ≥ 4** entities.

One letter covers all flag clusters detected for that entity, with questions tailored to whichever categories are present:

- **Structuring flags present** → questions on sub-threshold amount choices and underlying commercial obligations
- **Network flags present** → questions on economic role as intermediate party and documentation of goods/services
- **All entities** → source of funds, third-party direction, business activity explanation

SAR risk notice citing 31 U.S.C. § 5318(g) included automatically when any flag is SAR-risk.

---

## Month picker

The analysis period can be configured three ways in the dashboard:

| Mode | Behaviour |
|------|----------|
| **Select Months** | Choose year + any combination of months from a grid picker |
| **Prior Month** | Automatically uses the previous calendar month |
| **Prior Quarter** | Automatically uses the previous calendar quarter |

Multi-month selections run sequential monthly evaluations each with their own rolling baseline, then merge results per entity per v2 §0.1.

---

## Deploy

### 1. Push to GitHub

Your repo root must contain exactly:

```
server.js          ← backend API + AML engine
package.json       ← Node 20, Express 4.18
.gitignore
public/
  index.html       ← frontend dashboard
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

Open your Render URL — the dashboard loads directly. Click **▶ Run Analysis**.

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the dashboard (from `public/index.html`) |
| `/health` | GET | Health check — credentials status |
| `/analyze` | POST | Runs the full analysis pipeline |
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
| Flags export | `.csv` | All flags with Flag ID, Applicant ID, Rule, Category, Severity, Score, Tier, SAR Risk, Action, SumSub Txn IDs, Internal Txn IDs, Counterparties, Rationale |
| RFI letter | `.txt` per entity | Consolidated letter covering all clusters, Tier ≥ 4 only |

---

## Security

- API keys live **only** in Render's environment variables — never in code or GitHub
- Every SumSub request signed with **HMAC-SHA256** (`timestamp + METHOD + path + body`)
- **Stateless** — no database, no file storage, nothing persisted between runs
- Credentials never logged or returned in any API response

---

## What changed from v1 → v2

| Metric | v1 | v2 (projected) |
|--------|-----|----------------|
| Total flags (Feb–Jun backtest) | 996 | ~60–90 |
| Tier 5 entities | 49 | < 5 |
| Flags from missing-baseline fallback | 354 | 0 (New Entity Track) |
| Split Payment false flags | 142 | ~0 (rule redefined) |
| Surviving signal | — | Pass-through (27), 72h clustering (7), net-flow near-zero (5), valid structuring-index hits |

---

## Regulatory references

| Framework | Coverage |
|-----------|---------|
| FATF Recommendations | Structuring typologies, risk-based approach, TBML |
| FinCEN / BSA | 31 U.S.C. § 5324 (structuring), § 5318(g) (SAR obligations) |
| ACAMS | Periodic review dashboards, lookback data points |
| FFIEC AML Manual | Threshold calibration, independent validation |
| NY DFS Part 504 | Ongoing scenario relevance, threshold documentation |

---

<div align="center">
  <br/>
  <sub>Kira Financial AI · AML Compliance · Detection Rules v2 (Feb–Jun 2026 backtest revision) · July 2026</sub>
  <br/>
  <sub><i>This system surfaces indicators for compliance review. All SAR filing decisions require human officer review.</i></sub>
  <br/><br/>
</div>
