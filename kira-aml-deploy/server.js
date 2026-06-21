/**
 * Kira Financial AI — AML Periodic Aggregate Analysis Bot
 * Backend Server — Railway Deployment (Node.js + Express)
 * 
 * Spec Reference: AML Bot Specification v0.1 | Master Rule Compendium (30 Rules)
 * Auth: HMAC-SHA256 signed SumSub API requests
 * Security: API keys in Railway env vars only — never in code
 */

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── SUMSUB API CLIENT ───────────────────────────────────────────────────────
const SUMSUB_BASE = 'api.sumsub.com';

function sumsubRequest(method, path, body = null) {
  const token = process.env.SUMSUB_TOKEN;
  const secret = process.env.SUMSUB_SECRET;
  if (!token || !secret) throw new Error('SUMSUB_TOKEN or SUMSUB_SECRET not configured in environment variables.');

  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sigData = ts + method.toUpperCase() + path + bodyStr;
  const sig = crypto.createHmac('sha256', secret).update(sigData).digest('hex');

  const headers = {
    'X-App-Token': token,
    'X-App-Access-Sig': sig,
    'X-App-Access-Ts': ts,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  return new Promise((resolve, reject) => {
    const options = { hostname: SUMSUB_BASE, port: 443, path, method: method.toUpperCase(), headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`SumSub API error ${res.statusCode}: ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(new Error(`SumSub parse error: ${e.message} — raw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

// Rate-limit-aware paginated applicant fetcher
async function fetchAllApplicants() {
  const applicants = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const path = `/resources/applicants?limit=${limit}&offset=${offset}`;
    const resp = await sumsubRequest('GET', path);
    const items = resp.items || resp.list || [];
    applicants.push(...items);
    if (items.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
      await sleep(200); // respectful pacing
    }
  }
  return applicants;
}

// Fetch transactions for one applicant within a date window
async function fetchApplicantTransactions(applicantId, fromDate, toDate) {
  try {
    const from = Math.floor(fromDate.getTime() / 1000);
    const to = Math.floor(toDate.getTime() / 1000);
    const path = `/resources/kyt/txns?applicantId=${applicantId}&createdAtGt=${from}&createdAtLt=${to}&limit=500`;
    const resp = await sumsubRequest('GET', path);
    return resp.items || resp.list || [];
  } catch (e) {
    // If no transactions or applicant has no KYT access, return empty
    return [];
  }
}

// Fetch applicant profile
async function fetchApplicantProfile(applicantId) {
  try {
    return await sumsubRequest('GET', `/resources/applicants/${applicantId}/one`);
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Batch processor: 10 concurrent
async function processBatch(items, fn, batchSize = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
    if (i + batchSize < items.length) await sleep(300);
  }
  return results;
}

// ─── DATE UTILITIES ──────────────────────────────────────────────────────────
function getPreviousMonthWindow() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  return { start, end, label: `${start.toISOString().slice(0, 7)}` };
}

function getPreviousQuarterWindow() {
  const now = new Date();
  const q = Math.floor((now.getUTCMonth()) / 3); // current quarter index
  const prevQ = q === 0 ? 3 : q - 1;
  const year = q === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const startMonth = prevQ * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));
  const qLabel = `Q${prevQ + 1} ${year}`;
  return { start, end, label: qLabel };
}

function getBaselineWindow(endDate, periodsBack, periodType) {
  // periodType: 'month' or 'quarter'
  const windows = [];
  for (let i = periodsBack; i >= 1; i--) {
    let start, end;
    if (periodType === 'month') {
      const y = endDate.getUTCFullYear();
      const m = endDate.getUTCMonth() - i;
      start = new Date(Date.UTC(y, m, 1));
      end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
    } else {
      const q = Math.floor(endDate.getUTCMonth() / 3);
      const targetQ = q - i;
      const adjYear = Math.floor(targetQ / 4) + endDate.getUTCFullYear();
      const adjQ = ((targetQ % 4) + 4) % 4;
      const sm = adjQ * 3;
      start = new Date(Date.UTC(adjYear, sm, 1));
      end = new Date(Date.UTC(adjYear, sm + 3, 0, 23, 59, 59, 999));
    }
    windows.push({ start, end });
  }
  return windows;
}

// ─── STATISTICAL BASELINE ────────────────────────────────────────────────────
function computeBaseline(periodicData) {
  // periodicData: array of {txnCount, totalVolume, avgTxnSize}
  if (periodicData.length < 2) return null; // need at least 2 periods

  function stats(arr) {
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
    const stddev = Math.sqrt(variance);
    return { mean, stddev };
  }

  const counts = periodicData.map((p) => p.txnCount);
  const volumes = periodicData.map((p) => p.totalVolume);
  const sizes = periodicData.map((p) => p.avgTxnSize || 0);

  return {
    count: stats(counts),
    volume: stats(volumes),
    size: stats(sizes),
    periods: periodicData.length,
  };
}

function periodSummary(txns) {
  if (!txns || txns.length === 0) return { txnCount: 0, totalVolume: 0, avgTxnSize: 0 };
  const txnCount = txns.length;
  const totalVolume = txns.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
  const avgTxnSize = totalVolume / txnCount;
  return { txnCount, totalVolume, avgTxnSize };
}

// ─── FLAG ID GENERATOR ───────────────────────────────────────────────────────
let flagCounter = 1;
function newFlagId(period) {
  const tag = period.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
  return `AML-${new Date().getUTCFullYear()}-${tag}-${String(flagCounter++).padStart(4, '0')}`;
}

// ─── DETECTION ENGINE ────────────────────────────────────────────────────────
/**
 * All rules return Flag objects:
 * { id, rule, ruleRef, category, severity, rationale, txnIds, counterparties,
 *   sarRisk, scoreDelta, metaData }
 */

function detectVolumeSpike(applicantId, current, baseline, txns, periodLabel) {
  const flags = [];
  const { txnCount } = current;
  const threshold2sig = baseline ? baseline.count.mean + 2 * baseline.count.stddev : 10;
  const absoluteThreshold = 10;

  if ((!baseline && txnCount > absoluteThreshold) || (baseline && txnCount > threshold2sig)) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Volume Spike — Transaction Count',
      ruleRef: 'Spec §4.1 | Compendium Rule 2',
      category: 'Behavioral Deviation',
      severity: 'High',
      rationale: baseline
        ? `Transaction count of ${txnCount} exceeds 2σ threshold of ${threshold2sig.toFixed(1)} (μ=${baseline.count.mean.toFixed(1)}, σ=${baseline.count.stddev.toFixed(1)}) computed from ${baseline.periods} prior periods. This statistical outlier indicates activity materially inconsistent with established behavioral norms.`
        : `New entity (insufficient history): transaction count of ${txnCount} exceeds absolute threshold of ${absoluteThreshold}. Baseline profiling requires ≥2 prior periods; absolute threshold applied per Spec §4.1.`,
      txnIds: txns.map((t) => t.id || t.txnId).slice(0, 20),
      counterparties: [],
      sarRisk: false,
      scoreDelta: 20,
      metaData: { observed: txnCount, threshold: threshold2sig },
    });
  }
  return flags;
}

function detectAmountSpike(applicantId, current, baseline, txns, periodLabel) {
  const flags = [];
  const { totalVolume } = current;
  const absoluteThreshold = 50000;
  const threshold2sig = baseline ? baseline.volume.mean + 2 * baseline.volume.stddev : absoluteThreshold;

  if ((!baseline && totalVolume > absoluteThreshold) || (baseline && totalVolume > threshold2sig)) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Amount Spike — Total Volume',
      ruleRef: 'Spec §4.1 | Compendium Rule 2',
      category: 'Behavioral Deviation',
      severity: 'High',
      rationale: baseline
        ? `Total volume of $${totalVolume.toLocaleString()} exceeds 2σ threshold of $${threshold2sig.toLocaleString('en', { maximumFractionDigits: 0 })} (μ=$${baseline.volume.mean.toLocaleString('en', { maximumFractionDigits: 0 })}, σ=$${baseline.volume.stddev.toLocaleString('en', { maximumFractionDigits: 0 })}). Sustained or sudden high-value activity warrants investigation into business justification.`
        : `New entity: total volume $${totalVolume.toLocaleString()} exceeds absolute new-entity threshold of $${absoluteThreshold.toLocaleString()}.`,
      txnIds: txns.map((t) => t.id || t.txnId).slice(0, 20),
      counterparties: [],
      sarRisk: false,
      scoreDelta: 20,
      metaData: { observed: totalVolume, threshold: threshold2sig },
    });
  }
  return flags;
}

function detectVelocityEscalation(applicantId, txns, periodLabel) {
  const flags = [];
  if (txns.length < 4) return flags;

  // Group by week
  const weekMap = {};
  for (const t of txns) {
    const ts = new Date(t.createdAt || t.created_at || t.createdAtMs || Date.now());
    const weekNum = Math.floor(ts.getTime() / (7 * 24 * 3600 * 1000));
    weekMap[weekNum] = (weekMap[weekNum] || 0) + 1;
  }
  const weeks = Object.values(weekMap).sort((a, b) => a - b);

  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i] >= weeks[i - 1] * 2 && weeks[i - 1] > 0) {
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Velocity Escalation',
        ruleRef: 'Spec §4.1 | Compendium Rule 2',
        category: 'Behavioral Deviation',
        severity: 'Medium',
        rationale: `Weekly transaction cadence doubled within the review period (from ${weeks[i - 1]} to ${weeks[i]} transactions in consecutive weeks). Sudden velocity acceleration is a hallmark of layering initiation or payment campaign structuring.`,
        txnIds: txns.map((t) => t.id || t.txnId).slice(0, 10),
        counterparties: [],
        sarRisk: false,
        scoreDelta: 8,
        metaData: { weekCounts: weeks },
      });
      break;
    }
  }
  return flags;
}

function detectSizeThresholdJump(applicantId, current, baseline, txns, periodLabel) {
  const flags = [];
  if (!baseline || baseline.size.mean === 0) return flags;
  const threshold = baseline.size.mean * 1.5;
  if (current.avgTxnSize > threshold) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Transaction Size Threshold Jump',
      ruleRef: 'Spec §4.1 | Compendium Rule 6',
      category: 'Behavioral Deviation',
      severity: 'Medium',
      rationale: `Average transaction size of $${current.avgTxnSize.toLocaleString('en', { maximumFractionDigits: 0 })} is ${((current.avgTxnSize / baseline.size.mean - 1) * 100).toFixed(0)}% above the prior-period average of $${baseline.size.mean.toLocaleString('en', { maximumFractionDigits: 0 })} — exceeding the 150% threshold. A material upward shift in transaction size tier absent a documented business expansion is a behavioral anomaly.`,
      txnIds: txns.map((t) => t.id || t.txnId).slice(0, 10),
      counterparties: [],
      sarRisk: false,
      scoreDelta: 8,
      metaData: { observed: current.avgTxnSize, baseline: baseline.size.mean, threshold },
    });
  }
  return flags;
}

function detectConcentrationRisk(applicantId, txns, periodLabel) {
  const flags = [];
  const outbound = txns.filter((t) => {
    const dir = (t.direction || t.type || '').toLowerCase();
    return dir === 'outbound' || dir === 'debit' || dir === 'out';
  });
  if (outbound.length < 3) return flags;

  const totalOut = outbound.reduce((s, t) => s + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
  const beneficiaryMap = {};
  for (const t of outbound) {
    const key = t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown';
    beneficiaryMap[key] = (beneficiaryMap[key] || 0) + Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
  }

  for (const [party, amount] of Object.entries(beneficiaryMap)) {
    const share = amount / totalOut;
    if (share > 0.7) {
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Concentration Risk — Single Beneficiary',
        ruleRef: 'Spec §4.1 | Compendium Rule 5',
        category: 'Behavioral Deviation',
        severity: 'High',
        rationale: `${(share * 100).toFixed(1)}% of total outbound volume ($${amount.toLocaleString('en', { maximumFractionDigits: 0 })} of $${totalOut.toLocaleString('en', { maximumFractionDigits: 0 })}) is directed to a single beneficiary: "${party}". Counterparty concentration above 70% is a core concentration risk indicator under Quantexa, NICE Actimize, and Flagright frameworks.`,
        txnIds: outbound.filter((t) => (t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown') === party).map((t) => t.id || t.txnId),
        counterparties: [party],
        sarRisk: false,
        scoreDelta: 20,
        metaData: { beneficiary: party, share, amount, totalOut },
      });
    }
  }
  return flags;
}

function detectRoundDollarClustering(applicantId, txns, periodLabel) {
  const flags = [];
  if (txns.length < 5) return flags;
  const roundTxns = txns.filter((t) => {
    const amt = Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
    return amt > 0 && amt % 1000 === 0;
  });
  const ratio = roundTxns.length / txns.length;
  if (ratio > 0.4) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Round-Dollar Clustering',
      ruleRef: 'Spec §4.1 | Compendium Rule 19',
      category: 'Behavioral Deviation',
      severity: 'Medium',
      rationale: `${(ratio * 100).toFixed(1)}% of transactions (${roundTxns.length}/${txns.length}) are at exact round-dollar amounts — exceeding the 40% threshold. Legitimate commercial activity rarely produces such uniformity; this pattern is consistent with pre-determined payment instructions and FATF Trade-Based ML guidance on round-number invoice clustering.`,
      txnIds: roundTxns.map((t) => t.id || t.txnId).slice(0, 15),
      counterparties: [],
      sarRisk: false,
      scoreDelta: 8,
      metaData: { roundCount: roundTxns.length, total: txns.length, ratio },
    });
  }
  return flags;
}

function detectDormancyTransition(applicantId, current, baselineHistory, txns, periodLabel) {
  const flags = [];
  // dormancy = <3 txns per period in prior periods
  if (!baselineHistory || baselineHistory.length < 2) return flags;
  const wasDormant = baselineHistory.slice(-2).every((p) => p.txnCount < 3);
  if (wasDormant && current.txnCount >= 5 && current.totalVolume >= 25000) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Dormancy-to-Activity Transition',
      ruleRef: 'Spec §4.1 | Compendium Rule 9',
      category: 'Behavioral Deviation',
      severity: 'High',
      rationale: `Account was dormant (<3 transactions per period) for the prior 2 periods, then transacted ${current.txnCount} times with $${current.totalVolume.toLocaleString('en', { maximumFractionDigits: 0 })} total volume in the current period — exceeding both the 5-transaction and $25,000 activity thresholds. Dormancy reactivation is a critical red flag under Oracle Mantas, NICE Actimize, and FinCEN periodic review guidance.`,
      txnIds: txns.map((t) => t.id || t.txnId).slice(0, 10),
      counterparties: [],
      sarRisk: false,
      scoreDelta: 20,
      metaData: { priorActivity: baselineHistory.slice(-2), current },
    });
  }
  return flags;
}

function detectTemporalConcentration(applicantId, txns, periodLabel) {
  const flags = [];
  // Quarterly only: >60% of volume in one month
  const monthMap = {};
  let totalVol = 0;
  for (const t of txns) {
    const ts = new Date(t.createdAt || t.created_at || Date.now());
    const month = ts.getUTCMonth();
    const amt = Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
    monthMap[month] = (monthMap[month] || 0) + amt;
    totalVol += amt;
  }
  if (totalVol === 0) return flags;
  for (const [month, vol] of Object.entries(monthMap)) {
    if (vol / totalVol > 0.6) {
      const monthName = new Date(2000, parseInt(month), 1).toLocaleString('en', { month: 'long' });
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Temporal Concentration — Single Month Dominance',
        ruleRef: 'Spec §4.1 | Compendium Rule 14',
        category: 'Behavioral Deviation',
        severity: 'Medium',
        rationale: `${(vol / totalVol * 100).toFixed(1)}% of quarterly volume ($${vol.toLocaleString('en', { maximumFractionDigits: 0 })}) concentrated in ${monthName} — exceeding the 60% single-month dominance threshold. Intra-quarter temporal concentration suggests deliberate timing of activity, possibly to straddle reporting periods per ACAMS periodic review guidance.`,
        txnIds: txns.filter((t) => new Date(t.createdAt || t.created_at || Date.now()).getUTCMonth() === parseInt(month)).map((t) => t.id || t.txnId),
        counterparties: [],
        sarRisk: false,
        scoreDelta: 8,
        metaData: { month: monthName, monthVol: vol, totalVol },
      });
      break;
    }
  }
  return flags;
}

// ── Structuring & Layering ────────────────────────────────────────────────────
function detectStructuring(applicantId, txns, periodLabel) {
  const flags = [];
  const subThreshold = txns.filter((t) => {
    const amt = Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
    return amt >= 8000 && amt < 10000;
  });

  // Structuring Index (Rule 4 Compendium)
  const structuringIndex = subThreshold.length / (txns.length || 1);
  if (structuringIndex > 0.2) {
    flags.push({
      id: newFlagId(periodLabel),
      applicantId,
      rule: 'Just-Below-Threshold Clustering — Structuring Index',
      ruleRef: 'Spec §4.2 | Compendium Rule 4 | 31 U.S.C. § 5324',
      category: 'Structuring & Layering',
      severity: 'High',
      rationale: `Structuring Index of ${(structuringIndex * 100).toFixed(1)}% (${subThreshold.length} transactions in the $8,000–$9,999 band out of ${txns.length} total) exceeds the 20% threshold. This pattern is consistent with deliberate structuring to evade reporting thresholds — a federal offense under 31 U.S.C. § 5324 (Bank Secrecy Act). FinCEN structuring typologies and the FFIEC manual both identify clustering just below $10,000 as a primary structuring indicator.`,
      txnIds: subThreshold.map((t) => t.id || t.txnId),
      counterparties: [],
      sarRisk: true,
      scoreDelta: 25, // High + Structuring bonus
      metaData: { subThresholdCount: subThreshold.length, total: txns.length, structuringIndex },
    });
  }

  // Within-72-hour clustering
  const sorted = [...subThreshold].sort((a, b) => new Date(a.createdAt || a.created_at || 0) - new Date(b.createdAt || b.created_at || 0));
  for (let i = 0; i < sorted.length - 1; i++) {
    const t1 = new Date(sorted[i].createdAt || sorted[i].created_at || 0);
    const t2 = new Date(sorted[i + 1].createdAt || sorted[i + 1].created_at || 0);
    const hourDiff = (t2 - t1) / 3600000;
    if (hourDiff <= 72) {
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Just-Below-Threshold Clustering — 72-Hour Window',
        ruleRef: 'Spec §4.2.1 | 31 U.S.C. § 5324',
        category: 'Structuring & Layering',
        severity: 'High',
        rationale: `Multiple sub-threshold transactions (${sorted.slice(i, i + 2).map((t) => '$' + parseFloat(t.amount || t.fiatAmount || 0).toLocaleString()).join(', ')}) occurring within 72 hours. This temporal clustering in the $8,000–$9,999 band is the defining indicator of structuring under FinCEN guidance and FATF Recommendation 20.`,
        txnIds: sorted.slice(i, Math.min(i + 5, sorted.length)).map((t) => t.id || t.txnId),
        counterparties: [],
        sarRisk: true,
        scoreDelta: 25,
        metaData: { hoursBetween: hourDiff },
      });
      break; // one flag per cluster
    }
  }

  // Frequency & Uniformity Pattern
  if (txns.length >= 4) {
    const amounts = txns.map((t) => Math.abs(parseFloat(t.amount || t.fiatAmount || 0))).filter((a) => a > 0);
    if (amounts.length >= 4) {
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const maxVariance = Math.max(...amounts.map((a) => Math.abs(a - mean) / mean));
      if (maxVariance < 0.05 && txns.length >= 4) {
        flags.push({
          id: newFlagId(periodLabel),
          applicantId,
          rule: 'Frequency & Uniformity Pattern',
          ruleRef: 'Spec §4.2.1 | Compendium Rule 4',
          category: 'Structuring & Layering',
          severity: 'Medium',
          rationale: `Series of ${txns.length} transactions with <5% amount variance (max deviation ${(maxVariance * 100).toFixed(2)}% from mean of $${mean.toLocaleString('en', { maximumFractionDigits: 0 })}). Near-identical recurring amounts at regular intervals are inconsistent with organic commercial activity and indicate deliberate splitting consistent with layering.`,
          txnIds: txns.map((t) => t.id || t.txnId).slice(0, 10),
          counterparties: [],
          sarRisk: true,
          scoreDelta: 13, // Medium + Structuring bonus
          metaData: { mean, maxVariance },
        });
      }
    }
  }

  // Split payments to same beneficiary
  const beneficiaryGroups = {};
  for (const t of txns) {
    const key = t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown';
    if (!beneficiaryGroups[key]) beneficiaryGroups[key] = [];
    beneficiaryGroups[key].push(t);
  }
  for (const [party, group] of Object.entries(beneficiaryGroups)) {
    if (group.length < 2) continue;
    const total = group.reduce((s, t) => s + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
    const multiple = Math.round(total / 10000) * 10000;
    if (Math.abs(total - multiple) <= 500 && multiple > 0) {
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Split Payments to Same Beneficiary',
        ruleRef: 'Spec §4.2.1 | 31 U.S.C. § 5324',
        category: 'Structuring & Layering',
        severity: 'High',
        rationale: `${group.length} separate outbound payments to "${party}" total $${total.toLocaleString('en', { maximumFractionDigits: 0 })} — within $500 of a round multiple of $10,000 ($${multiple.toLocaleString()}). This split-payment pattern across transactions to the same beneficiary is a textbook structuring indicator under 31 U.S.C. § 5324.`,
        txnIds: group.map((t) => t.id || t.txnId),
        counterparties: [party],
        sarRisk: true,
        scoreDelta: 25,
        metaData: { party, total, multiple, transactionCount: group.length },
      });
    }
  }

  return flags;
}

// ── Network & Flow Patterns ───────────────────────────────────────────────────
function detectNetworkPatterns(applicantId, txns, allTxnsByApplicant, periodLabel) {
  const flags = [];

  // Build directed flow map for this applicant
  const inbound = txns.filter((t) => {
    const dir = (t.direction || t.type || '').toLowerCase();
    return dir === 'inbound' || dir === 'credit' || dir === 'in';
  });
  const outbound = txns.filter((t) => {
    const dir = (t.direction || t.type || '').toLowerCase();
    return dir === 'outbound' || dir === 'debit' || dir === 'out';
  });

  // 1. Reciprocal Payment Pattern
  const inboundParties = new Map();
  for (const t of inbound) {
    const party = t.counterpartyName || t.senderName || t.counterparty || 'Unknown';
    const amt = Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
    inboundParties.set(party, (inboundParties.get(party) || 0) + amt);
  }
  const outboundParties = new Map();
  for (const t of outbound) {
    const party = t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown';
    const amt = Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
    outboundParties.set(party, (outboundParties.get(party) || 0) + amt);
  }

  for (const [party, inAmt] of inboundParties.entries()) {
    if (outboundParties.has(party)) {
      const outAmt = outboundParties.get(party);
      const ratio = Math.abs(inAmt - outAmt) / Math.max(inAmt, outAmt);
      if (ratio <= 0.2) {
        // Check temporal proximity (within 7 days = escalated)
        const inTxns = inbound.filter((t) => (t.counterpartyName || t.senderName || t.counterparty || 'Unknown') === party);
        const outTxns = outbound.filter((t) => (t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown') === party);
        let withinSevenDays = false;
        for (const i of inTxns) {
          for (const o of outTxns) {
            const dayDiff = Math.abs(new Date(i.createdAt || i.created_at || 0) - new Date(o.createdAt || o.created_at || 0)) / 86400000;
            if (dayDiff <= 7) withinSevenDays = true;
          }
        }
        flags.push({
          id: newFlagId(periodLabel),
          applicantId,
          rule: withinSevenDays ? 'Reciprocal Payment Pattern (Escalated — Within 7 Days)' : 'Reciprocal Payment Pattern',
          ruleRef: 'Spec §4.3.1 | Compendium Rule 11',
          category: 'Network & Flow Pattern',
          severity: withinSevenDays ? 'High' : 'Medium',
          rationale: `Bidirectional flows with "${party}": inbound $${inAmt.toLocaleString('en', { maximumFractionDigits: 0 })} and outbound $${outAmt.toLocaleString('en', { maximumFractionDigits: 0 })} — within 20% of each other (${(ratio * 100).toFixed(1)}% difference).${withinSevenDays ? ' Flows occurred within 7 days, indicating possible pre-coordination.' : ''} Unexplained reciprocal flows lacking documentary support are a circular flow indicator under Quantexa contextual monitoring and FATF typologies.`,
          txnIds: [...inTxns, ...outTxns].map((t) => t.id || t.txnId),
          counterparties: [party],
          sarRisk: withinSevenDays,
          scoreDelta: withinSevenDays ? 23 : 11,
          metaData: { party, inAmt, outAmt, ratio, withinSevenDays },
        });
      }
    }
  }

  // 2. Pass-Through / Transit Payment
  for (const inT of inbound) {
    const inAmt = Math.abs(parseFloat(inT.amount || inT.fiatAmount || 0));
    const inTime = new Date(inT.createdAt || inT.created_at || 0);
    for (const outT of outbound) {
      const outAmt = Math.abs(parseFloat(outT.amount || outT.fiatAmount || 0));
      const outTime = new Date(outT.createdAt || outT.created_at || 0);
      const hoursBetween = (outTime - inTime) / 3600000;
      if (hoursBetween >= 0 && hoursBetween <= 48) {
        const netRetention = (inAmt - outAmt) / inAmt;
        if (netRetention >= 0 && netRetention <= 0.1) {
          const inParty = inT.counterpartyName || inT.senderName || 'Unknown';
          const outParty = outT.counterpartyName || outT.beneficiaryName || 'Unknown';
          if (inParty !== outParty) {
            flags.push({
              id: newFlagId(periodLabel),
              applicantId,
              rule: 'Pass-Through / Transit Payment',
              ruleRef: 'Spec §4.3.2 | Compendium Rule 3',
              category: 'Network & Flow Pattern',
              severity: 'High',
              rationale: `Inbound $${inAmt.toLocaleString('en', { maximumFractionDigits: 0 })} from "${inParty}" followed by outbound $${outAmt.toLocaleString('en', { maximumFractionDigits: 0 })} to "${outParty}" within ${hoursBetween.toFixed(1)} hours (≤48-hour window) at ${(netRetention * 100).toFixed(1)}% net retention (≤10% threshold). Entity appears to function as a conduit with no apparent economic purpose — a core layering typology per ACAMS, Quantexa, and Oracle Mantas pass-through detection.`,
              txnIds: [inT.id || inT.txnId, outT.id || outT.txnId],
              counterparties: [inParty, outParty],
              sarRisk: true,
              scoreDelta: 23, // High + Network bonus
              metaData: { inAmt, outAmt, hoursBetween, netRetention, inParty, outParty },
            });
            break; // one flag per inbound
          }
        }
      }
    }
  }

  // 3. Net Flow Near-Zero (Quarterly)
  const totalIn = inbound.reduce((s, t) => s + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
  const totalOut = outbound.reduce((s, t) => s + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
  const totalVol = totalIn + totalOut;
  if (totalVol > 50000 && totalIn > 0 && totalOut > 0) {
    const ratio = Math.abs(totalIn - totalOut) / Math.max(totalIn, totalOut);
    if (ratio <= 0.1) {
      flags.push({
        id: newFlagId(periodLabel),
        applicantId,
        rule: 'Quarterly Net Flow Near-Zero (Pass-Through)',
        ruleRef: 'Spec §4.3 | Compendium Rule 3',
        category: 'Network & Flow Pattern',
        severity: 'High',
        rationale: `Total inflows ($${totalIn.toLocaleString('en', { maximumFractionDigits: 0 })}) and outflows ($${totalOut.toLocaleString('en', { maximumFractionDigits: 0 })}) are within ${(ratio * 100).toFixed(1)}% of each other on >$50K total volume. A near-zero net flow position at this volume indicates the entity functions as a pass-through conduit rather than an economic actor — the primary quarterly indicator per ACAMS and Quantexa net flow analysis.`,
        txnIds: txns.map((t) => t.id || t.txnId).slice(0, 10),
        counterparties: [],
        sarRisk: true,
        scoreDelta: 23,
        metaData: { totalIn, totalOut, ratio, totalVol },
      });
    }
  }

  return flags;
}

// ─── RISK SCORING (Rule 22 Compendium) ──────────────────────────────────────
function computeRiskScore(flags) {
  let score = 0;
  for (const f of flags) {
    if (f.severity === 'High') score += 20;
    else if (f.severity === 'Medium') score += 8;
    if (f.category === 'Structuring & Layering') score += 5;
    if (f.category === 'Network & Flow Pattern') score += 3;
  }
  return Math.min(100, score);
}

function getRiskTier(score) {
  if (score <= 25) return { tier: 1, label: 'No Action', action: 'Monitor & Close' };
  if (score <= 50) return { tier: 2, label: 'Enhanced Monitoring', action: 'Enhanced Monitoring' };
  if (score <= 74) return { tier: 3, label: 'Investigator Escalation', action: 'Internal Investigation' };
  if (score <= 89) return { tier: 4, label: 'SAR Consideration', action: 'SAR Consideration' };
  return { tier: 5, label: 'Mandatory SAR + Relationship Review', action: 'SAR Consideration' };
}

// ─── RFI GENERATION ──────────────────────────────────────────────────────────
function generateRFI(flag, applicantName, periodLabel) {
  const sarWarning = flag.sarRisk
    ? `\n\nSAR RISK NOTICE: Failure to provide a satisfactory documented explanation for this activity may result in a Suspicious Activity Report (SAR) filing with FinCEN pursuant to 31 U.S.C. § 5318(g). You are reminded that disclosure of a SAR filing or its contents is prohibited under 31 U.S.C. § 5318(g)(2).`
    : '';

  const whyIssued = `
RFI JUSTIFICATION — WHY THIS REQUEST HAS BEEN ISSUED
=====================================================
Rule Triggered: ${flag.rule}
Regulatory Reference: ${flag.ruleRef}
Review Period: ${periodLabel}
Flag ID: ${flag.id}
Risk Category: ${flag.category}
Severity: ${flag.severity}

This Request for Information has been issued because the transaction data for your account during the review period of ${periodLabel} has triggered one or more automated detection rules in Kira Financial AI's Anti-Money Laundering (AML) monitoring system.

Specifically, the following pattern was detected:
${flag.rationale}

This detection is mandated by our AML compliance obligations under applicable regulatory frameworks including the Bank Secrecy Act (BSA), FATF Recommendations, and FinCEN guidance. The pattern identified above cannot be closed without a documented explanation from you, as the absence of a plausible business rationale for this activity would require escalation to the appropriate regulatory authorities.

Transaction IDs involved: ${flag.txnIds.slice(0, 10).join(', ')}${flag.txnIds.length > 10 ? ` ... and ${flag.txnIds.length - 10} more` : ''}
${flag.counterparties.length > 0 ? `Counterparties involved: ${flag.counterparties.join(', ')}` : ''}${sarWarning}
`.trim();

  // Generate rule-specific questions
  let questions = [];

  if (flag.category === 'Structuring & Layering') {
    questions = [
      `1. Please provide a full written explanation of the business purpose for each transaction in the $8,000–$9,999 range identified during ${periodLabel}. For each transaction, specify: the goods or services provided, the commercial relationship with the counterparty, and why the specific amount was chosen.`,
      `2. Please provide all supporting documentation for these transactions, including invoices, contracts, purchase orders, or other commercial agreements with the counterparty.`,
      `3. Were these transactions made in installments of a larger single obligation? If so, please provide the underlying agreement and explain why installment payments were made rather than a single transfer.`,
      `4. Please confirm whether any of these payments were made at the direction of a third party, and if so, identify that party and the nature of the relationship.`,
      `5. Please provide your transaction records or bank statements confirming the source of funds for each payment identified.`,
    ];
  } else if (flag.category === 'Network & Flow Pattern') {
    questions = [
      `1. Please provide a written explanation of the commercial relationship with each counterparty identified in this review, specifically: ${flag.counterparties.join(', ') || 'the identified counterparties'}.`,
      `2. For any funds received and subsequently transmitted to a different party within 48 hours, please provide: the basis for receiving these funds, the basis for transmitting them onward, and documentation of goods or services you provided as the intermediate party.`,
      `3. Please provide contracts, master agreements, or other binding documentation supporting the payment flow identified in this period.`,
      `4. Confirm whether you have any ownership, directorship, or financial interest in any of the counterparties identified. If so, provide full disclosure.`,
      `5. Provide your general ledger entries or accounting records reflecting these transactions and their classification within your books.`,
    ];
  } else {
    questions = [
      `1. Please provide a written explanation of the unusual activity detected in your account during ${periodLabel}, specifically addressing the pattern described above.`,
      `2. Please provide supporting documentation (invoices, contracts, agreements) for all transactions above $5,000 in the identified review period.`,
      `3. Confirm whether any transactions were made on behalf of a third party and, if so, identify that party.`,
      `4. Please explain any change in your business activity, counterparty relationships, or transaction patterns during this period compared to prior periods.`,
      `5. Provide evidence of the source of funds for material inflows identified during the review period.`,
    ];
  }

  const whatRfiMustContain = `
REQUIRED RESPONSE — WHAT THIS RFI MUST CONTAIN
================================================
You are required to respond to this Request for Information within 10 business days of receipt. Your response must address all of the following points:

${questions.join('\n\n')}

SUBMISSION REQUIREMENTS:
- All responses must be in writing and submitted via the designated compliance channel.
- Supporting documents must be provided in their original format (not redacted).
- Incomplete responses will be treated as non-responsive and may result in escalated review.
- Response deadline: 10 business days from date of this RFI.

Issued by: Kira Financial AI Compliance Team
Date: ${new Date().toISOString().slice(0, 10)}
Flag ID: ${flag.id}
Reference Period: ${periodLabel}
`.trim();

  return {
    whyIssued,
    whatRfiMustContain,
    fullLetter: `KIRA FINANCIAL AI — REQUEST FOR INFORMATION\n${'='.repeat(44)}\n\nTo: ${applicantName}\nDate: ${new Date().toISOString().slice(0, 10)}\n\n${whyIssued}\n\n${'─'.repeat(60)}\n\n${whatRfiMustContain}`,
  };
}

// ─── MAIN ANALYSIS ENGINE ────────────────────────────────────────────────────
async function runAnalysis(mode) {
  flagCounter = 1;
  const startTime = Date.now();

  // Determine time windows
  const { start: reviewStart, end: reviewEnd, label: periodLabel } =
    mode === 'monthly' ? getPreviousMonthWindow() : getPreviousQuarterWindow();

  const baselinePeriodsBack = mode === 'monthly' ? 4 : 9;
  const periodType = mode === 'monthly' ? 'month' : 'quarter';
  const baselineWindows = getBaselineWindow(reviewStart, baselinePeriodsBack, periodType);

  // Step 1: Fetch all applicants
  const applicants = await fetchAllApplicants();

  const results = {
    mode,
    periodLabel,
    reviewStart: reviewStart.toISOString(),
    reviewEnd: reviewEnd.toISOString(),
    runTimestamp: new Date().toISOString(),
    ruleVersion: 'Spec v0.1 + Master Compendium v1 (30 Rules)',
    totalApplicants: applicants.length,
    totalTransactionsAnalyzed: 0,
    totalFlags: 0,
    flagsByCategory: {},
    flagsBySeverity: { High: 0, Medium: 0, Low: 0 },
    riskTierDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    sarRiskFlags: 0,
    entityResults: [],
  };

  // Step 2: Process applicants in batches of 10
  const processApplicant = async (applicant) => {
    const applicantId = applicant.id || applicant.applicantId;
    const applicantName = applicant.info?.companyInfo?.companyName ||
      `${applicant.info?.firstName || ''} ${applicant.info?.lastName || ''}`.trim() ||
      applicant.externalUserId || applicantId;

    // Fetch current period transactions
    const currentTxns = await fetchApplicantTransactions(applicantId, reviewStart, reviewEnd);
    if (currentTxns.length === 0) return null;

    // Fetch baseline period transactions
    const baselineHistory = [];
    for (const window of baselineWindows) {
      const periodTxns = await fetchApplicantTransactions(applicantId, window.start, window.end);
      baselineHistory.push(periodSummary(periodTxns));
      await sleep(50);
    }

    const current = periodSummary(currentTxns);
    const baseline = computeBaseline(baselineHistory.filter((p) => p.txnCount > 0));

    const entityFlags = [];

    // Run all detection rules
    entityFlags.push(...detectVolumeSpike(applicantId, current, baseline, currentTxns, periodLabel));
    entityFlags.push(...detectAmountSpike(applicantId, current, baseline, currentTxns, periodLabel));
    entityFlags.push(...detectVelocityEscalation(applicantId, currentTxns, periodLabel));
    entityFlags.push(...detectSizeThresholdJump(applicantId, current, baseline, currentTxns, periodLabel));
    entityFlags.push(...detectConcentrationRisk(applicantId, currentTxns, periodLabel));
    entityFlags.push(...detectRoundDollarClustering(applicantId, currentTxns, periodLabel));
    entityFlags.push(...detectDormancyTransition(applicantId, current, baselineHistory, currentTxns, periodLabel));
    if (mode === 'quarterly') {
      entityFlags.push(...detectTemporalConcentration(applicantId, currentTxns, periodLabel));
    }
    entityFlags.push(...detectStructuring(applicantId, currentTxns, periodLabel));
    entityFlags.push(...detectNetworkPatterns(applicantId, currentTxns, {}, periodLabel));

    if (entityFlags.length === 0) return null;

    // Score and tier
    const riskScore = computeRiskScore(entityFlags);
    const { tier, label: tierLabel, action } = getRiskTier(riskScore);

    // Generate RFIs for High severity flags
    const flagsWithRFI = entityFlags.map((flag) => ({
      ...flag,
      rfi: (flag.severity === 'High' || flag.sarRisk) ? generateRFI(flag, applicantName, periodLabel) : null,
      recommendedAction: action,
      status: 'Open',
    }));

    return {
      applicantId,
      applicantName,
      riskScore,
      riskTier: tier,
      riskTierLabel: tierLabel,
      recommendedAction: action,
      transactionCount: currentTxns.length,
      totalVolume: current.totalVolume,
      flags: flagsWithRFI,
      flagCount: flagsWithRFI.length,
      sarRiskCount: flagsWithRFI.filter((f) => f.sarRisk).length,
      periodLabel,
    };
  };

  const entityResults = await processBatch(applicants, processApplicant, 10);
  const validResults = entityResults.filter(Boolean);

  // Aggregate stats
  results.totalTransactionsAnalyzed = validResults.reduce((s, e) => s + e.transactionCount, 0);
  results.totalFlags = validResults.reduce((s, e) => s + e.flagCount, 0);
  results.sarRiskFlags = validResults.reduce((s, e) => s + e.sarRiskCount, 0);

  for (const entity of validResults) {
    results.riskTierDistribution[entity.riskTier] = (results.riskTierDistribution[entity.riskTier] || 0) + 1;
    for (const flag of entity.flags) {
      results.flagsByCategory[flag.category] = (results.flagsByCategory[flag.category] || 0) + 1;
      results.flagsBySeverity[flag.severity] = (results.flagsBySeverity[flag.severity] || 0) + 1;
    }
  }

  results.entityResults = validResults.sort((a, b) => b.riskScore - a.riskScore);
  results.top5Entities = results.entityResults.slice(0, 5).map((e) => ({
    applicantId: e.applicantId,
    applicantName: e.applicantName,
    riskScore: e.riskScore,
    riskTierLabel: e.riskTierLabel,
    flagCount: e.flagCount,
    sarRiskCount: e.sarRiskCount,
  }));

  results.runtimeMs = Date.now() - startTime;
  return results;
}

// ─── EXPORT GENERATORS ───────────────────────────────────────────────────────
function generateSummaryReport(results) {
  const lines = [
    `KIRA FINANCIAL AI — AML ${results.mode.toUpperCase()} ANALYSIS REPORT`,
    '='.repeat(60),
    `Period: ${results.periodLabel}`,
    `Run Timestamp: ${results.runTimestamp}`,
    `Rule Version: ${results.ruleVersion}`,
    '',
    'EXECUTIVE SUMMARY',
    '-'.repeat(40),
    `Total Applicants Analyzed: ${results.totalApplicants}`,
    `Total Transactions Analyzed: ${results.totalTransactionsAnalyzed}`,
    `Total Flags Generated: ${results.totalFlags}`,
    `SAR-Risk Flags: ${results.sarRiskFlags}`,
    '',
    'FLAGS BY CATEGORY',
    '-'.repeat(40),
    ...Object.entries(results.flagsByCategory).map(([cat, count]) => `  ${cat}: ${count}`),
    '',
    'FLAGS BY SEVERITY',
    '-'.repeat(40),
    `  High: ${results.flagsBySeverity.High}`,
    `  Medium: ${results.flagsBySeverity.Medium}`,
    `  Low: ${results.flagsBySeverity.Low}`,
    '',
    'RISK TIER DISTRIBUTION',
    '-'.repeat(40),
    `  Tier 1 — No Action: ${results.riskTierDistribution[1] || 0}`,
    `  Tier 2 — Enhanced Monitoring: ${results.riskTierDistribution[2] || 0}`,
    `  Tier 3 — Investigator Escalation: ${results.riskTierDistribution[3] || 0}`,
    `  Tier 4 — SAR Consideration: ${results.riskTierDistribution[4] || 0}`,
    `  Tier 5 — Mandatory SAR + Relationship Review: ${results.riskTierDistribution[5] || 0}`,
    '',
    'TOP 5 HIGHEST-RISK ENTITIES',
    '-'.repeat(40),
    ...results.top5Entities.map((e, i) =>
      `  ${i + 1}. ${e.applicantName} (ID: ${e.applicantId})\n     Score: ${e.riskScore} | Tier: ${e.riskTierLabel} | Flags: ${e.flagCount} | SAR Risk: ${e.sarRiskCount}`
    ),
    '',
    'HIGH SEVERITY FLAGS — FULL RATIONALE',
    '-'.repeat(40),
  ];

  for (const entity of results.entityResults) {
    const highFlags = entity.flags.filter((f) => f.severity === 'High');
    if (highFlags.length > 0) {
      lines.push(`\nEntity: ${entity.applicantName} (${entity.applicantId})`);
      for (const flag of highFlags) {
        lines.push(`  Flag: ${flag.id} — ${flag.rule}`);
        lines.push(`  Reference: ${flag.ruleRef}`);
        lines.push(`  Rationale: ${flag.rationale}`);
        if (flag.sarRisk) lines.push(`  ⚠️  SAR RISK — 31 U.S.C. § 5318(g) applies`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function generateCSV(results) {
  const headers = [
    'Flag ID', 'Period', 'Applicant ID', 'Applicant Name', 'Rule', 'Rule Reference',
    'Category', 'Severity', 'Risk Score', 'Risk Tier', 'Risk Tier Label',
    'SAR Risk', 'Recommended Action', 'Status', 'Transaction IDs', 'Counterparties', 'Rationale',
  ];
  const rows = [headers.join(',')];

  for (const entity of results.entityResults) {
    for (const flag of entity.flags) {
      const row = [
        flag.id,
        results.periodLabel,
        entity.applicantId,
        `"${entity.applicantName.replace(/"/g, '""')}"`,
        `"${flag.rule.replace(/"/g, '""')}"`,
        `"${flag.ruleRef.replace(/"/g, '""')}"`,
        `"${flag.category}"`,
        flag.severity,
        entity.riskScore,
        entity.riskTier,
        `"${entity.riskTierLabel}"`,
        flag.sarRisk ? 'YES' : 'NO',
        `"${flag.recommendedAction}"`,
        flag.status || 'Open',
        `"${flag.txnIds.slice(0, 5).join('; ')}"`,
        `"${(flag.counterparties || []).join('; ')}"`,
        `"${flag.rationale.replace(/"/g, '""').replace(/\n/g, ' ')}"`,
      ];
      rows.push(row.join(','));
    }
  }

  return rows.join('\n');
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { mode } = req.body;
  if (!['monthly', 'quarterly'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "monthly" or "quarterly"' });
  }
  try {
    const results = await runAnalysis(mode);
    res.json({ success: true, results });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/export/summary', async (req, res) => {
  const { results } = req.body;
  if (!results) return res.status(400).json({ error: 'results required' });
  const report = generateSummaryReport(results);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="AML-Summary-${results.periodLabel}.txt"`);
  res.send(report);
});

app.post('/export/csv', async (req, res) => {
  const { results } = req.body;
  if (!results) return res.status(400).json({ error: 'results required' });
  const csv = generateCSV(results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="AML-Flags-${results.periodLabel}.csv"`);
  res.send(csv);
});

app.post('/export/rfi', async (req, res) => {
  const { applicantName, flag, periodLabel } = req.body;
  if (!flag) return res.status(400).json({ error: 'flag required' });
  const rfi = generateRFI(flag, applicantName || 'Client', periodLabel || 'Period');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="RFI-${flag.id}.txt"`);
  res.send(rfi.fullLetter);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Kira AML Bot backend running on port ${PORT}`);
  console.log(`SumSub credentials: ${process.env.SUMSUB_TOKEN ? 'CONFIGURED ✓' : 'MISSING ✗'}`);
});
