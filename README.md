<div align="center">
  <br/>
  <img src="https://img.shields.io/badge/Kira_Financial_AI-AML_Bot-1A56DB?style=for-the-badge&labelColor=0D1117" alt="Kira AML Bot"/>
  <br/><br/>

  [![Node](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
  [![Render](https://img.shields.io/badge/Render-deployed-46E3B7?style=flat-square&logo=render&logoColor=white)](https://render.com)
  [![SumSub](https://img.shields.io/badge/SumSub-KYT_API-0052CC?style=flat-square)](https://sumsub.com)
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
        ├─ Builds per-entity statistical baselines (μ, σ)
        ├─ Runs 15 detection rules
        ├─ Scores each entity 0–100
        └─ Generates RFI letters
        │
        ▼
  Dashboard  (flags · risk tiers · RFI downloads)
```

No database. No CSV uploads. Fully stateless — every run fetches live from SumSub.

---

## Detection rules

### 🔴 Behavioral deviation
Rules that flag statistically anomalous changes in an entity's own history.

| Rule | Trigger |
|------|---------|
| Volume Spike | Transaction count > μ + 2σ from baseline |
| Amount Spike | Total volume > μ + 2σ, or >$50K (new entities) |
| Velocity Escalation | Weekly cadence doubles within the period |
| Size Threshold Jump | Avg transaction > 150% of prior-period average |
| Concentration Risk | >70% of outbound to a single beneficiary |
| Round-Dollar Clustering | >40% of transactions at exact round-dollar amounts |
| Dormancy Transition | Dormant for 2+ periods, then ≥5 tx and ≥$25K |
| Temporal Concentration | >60% of quarterly volume in one month *(quarterly only)* |

### 🟣 Structuring & layering
All structuring flags cite **31 U.S.C. § 5324** (Bank Secrecy Act).

| Rule | Trigger |
|------|---------|
| Structuring Index | >20% of transactions in the $8K–$9,999 band |
| 72-Hour Clustering | Multiple sub-threshold transactions within 72 hours |
| Frequency & Uniformity | Series of transactions with <5% amount variance |
| Split Payments | Payments to same beneficiary total within $500 of a $10K multiple |

### 🔵 Network & flow patterns

| Rule | Trigger |
|------|---------|
| Reciprocal Payment | Bidirectional flows within 20% of each other |
| Reciprocal — Escalated | Same, but within 7 days (pre-coordination indicator) |
| Pass-Through / Transit | Inbound forwarded to different party within 48h at ≤10% net retention |
| Net Flow Near-Zero | In/out within 10% on >$50K total volume |

---

## Risk scoring

Every flagged entity gets a **composite score (0–100)** and a mandatory action tier.

```
 Score    Tier   Label                           Action
 ──────   ────   ──────────────────────────────  ──────────────────────────
  0–25     1     No Action                       Monitor & close
 26–50     2     Enhanced Monitoring             Increase review cadence
 51–74     3     Investigator Escalation         Assign to AML investigator
 75–89     4     SAR Consideration               30-day investigation window
 90–100    5     Mandatory SAR                   File SAR + relationship review
```

**Scoring formula**

```
High severity flag    → +20 pts
Medium severity flag  →  +8 pts
Structuring category  →  +5 pts bonus per flag
Network category      →  +3 pts bonus per flag
                         ─────────────────────
                         capped at 100
```

---

## RFI generation

For every High or SAR-risk flag the bot auto-generates a two-part formal letter:

**Part 1 — Why the RFI was issued**
- Which rule fired and which threshold was crossed
- Regulatory framework mandating the RFI
- Specific amounts, counterparties, and dates detected
- SAR risk notice citing 31 U.S.C. § 5318(g) where applicable

**Part 2 — What the client must provide**
- 5 numbered questions tailored to the flag type
- 10 business day deadline
- Submission requirements

Each RFI downloads as a formatted `.txt` letter.

---

## Deploy in 5 minutes

### 1. Push to GitHub

Upload these 3 files to the root of a new private repo:

```
server.js       ← backend + frontend
package.json    ← dependencies
.gitignore
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
| `/` | GET | Serves the full dashboard HTML |
| `/health` | GET | Health check — credentials status |
| `/analyze` | POST | Runs the full analysis pipeline |
| `/export/rfi` | POST | Downloads a single RFI as `.txt` |

**`POST /analyze` body:**
```json
{ "mode": "monthly" }
{ "mode": "quarterly" }
```

---

## Outputs

| File | Format | What's inside |
|------|--------|--------------|
| Summary report | `.txt` | Executive summary, flags by category, tier distribution, top 5 entities, all High-severity rationales |
| Flags export | `.csv` | All flags with ID, rule, severity, score, tier, SAR risk, rationale |
| RFI letters | `.txt` per flag | Two-part compliance letter with regulatory justification and client questions |

---

## Security

- API keys live **only** in Render's environment variables — never in code or GitHub
- Every SumSub request is signed with **HMAC-SHA256** (`timestamp + METHOD + path + body`)
- **Stateless** — no database, no file storage, nothing persisted between runs
- Credentials are never logged or returned in any API response

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

## Rule compendium sources

30 core rules synthesized from 20+ platforms:

**Enterprise** — NICE Actimize · Oracle Mantas · FICO Siron · SAS AML · Featurespace · Feedzai

**Fintech / AI** — Flagright · Unit21 · Hawk AI · ComplyAdvantage · Quantexa · AMLYZE · Tookitaki · Sardine

**Crypto** — Chainalysis · Elliptic · TRM Labs

**Regulatory** — FATF · FinCEN · ACAMS · FFIEC · NY DFS Part 504 · Wolfsberg Group

---

<div align="center">
  <br/>
  <sub>Kira Financial AI · AML Compliance · Spec v0.1 · Master Rule Compendium (30 rules, 20+ sources) · June 2026</sub>
  <br/>
  <sub><i>This system surfaces indicators for compliance review. All SAR filing decisions require human officer review.</i></sub>
  <br/><br/>
</div>
