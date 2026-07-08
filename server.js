const express = require('express');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  const hasToken = !!process.env.SUMSUB_TOKEN;
  const hasSecret = !!process.env.SUMSUB_SECRET;
  res.json({ ok: true, time: new Date().toISOString(), credentials: hasToken && hasSecret ? 'configured' : 'MISSING', token: hasToken ? 'set' : 'NOT SET', secret: hasSecret ? 'set' : 'NOT SET' });
});

function sumsubRequest(method, path, body = null) {
  const token = process.env.SUMSUB_TOKEN;
  const secret = process.env.SUMSUB_SECRET;
  if (!token || !secret) throw new Error('SUMSUB_TOKEN or SUMSUB_SECRET not set in environment variables.');
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig = crypto.createHmac('sha256', secret).update(ts + method.toUpperCase() + path + bodyStr).digest('hex');
  const headers = { 'X-App-Token': token, 'X-App-Access-Sig': sig, 'X-App-Access-Ts': ts, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.sumsub.com', port: 443, path, method: method.toUpperCase(), headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) reject(new Error('SumSub ' + res.statusCode + ': ' + data.slice(0, 300)));
          else resolve(JSON.parse(data));
        } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.post('/analyze', async (req, res) => {
  const { mode, customStart, customEnd } = req.body;
  if (!['monthly', 'quarterly', 'custom'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be monthly, quarterly, or custom' });
  }
  try {
    const startTime = Date.now();
    const now = new Date();
    let reviewStart, reviewEnd, periodLabel;
    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    if (mode === 'custom') {
      if (!customStart || !customEnd) return res.status(400).json({ error: 'customStart and customEnd required' });
      const [sy, sm] = customStart.split('-').map(Number);
      const [ey, em] = customEnd.split('-').map(Number);
      reviewStart = new Date(Date.UTC(sy, sm - 1, 1));
      reviewEnd = new Date(Date.UTC(ey, em, 0, 23, 59, 59, 999));
      periodLabel = customStart === customEnd ? (MNAMES[sm-1] + ' ' + sy) : (MNAMES[sm-1] + ' ' + sy + ' to ' + MNAMES[em-1] + ' ' + ey);
    } else if (mode === 'monthly') {
      reviewStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      reviewEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
      periodLabel = reviewStart.toISOString().slice(0, 7);
    } else {
      const q = Math.floor(now.getUTCMonth() / 3);
      const pq = q === 0 ? 3 : q - 1;
      const yr = q === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      const sm = pq * 3;
      reviewStart = new Date(Date.UTC(yr, sm, 1));
      reviewEnd = new Date(Date.UTC(yr, sm + 3, 0, 23, 59, 59, 999));
      periodLabel = 'Q' + (pq + 1) + ' ' + yr;
    }

    const baselineBack = mode === 'quarterly' ? 4 : 6;
    const baselineWindows = [];
    for (let i = baselineBack; i >= 1; i--) {
      let s, e;
      if (mode === 'quarterly') {
        const q = Math.floor(reviewStart.getUTCMonth() / 3);
        const tq = q - i;
        const ay = Math.floor(tq / 4) + reviewStart.getUTCFullYear();
        const aq = ((tq % 4) + 4) % 4;
        s = new Date(Date.UTC(ay, aq * 3, 1));
        e = new Date(Date.UTC(ay, aq * 3 + 3, 0, 23, 59, 59, 999));
      } else {
        s = new Date(Date.UTC(reviewStart.getUTCFullYear(), reviewStart.getUTCMonth() - i, 1));
        e = new Date(Date.UTC(reviewStart.getUTCFullYear(), reviewStart.getUTCMonth() - i + 1, 0, 23, 59, 59, 999));
      }
      baselineWindows.push({ start: s, end: e });
    }

    function fmtDate(d) { return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+0000'); }

    async function getAllTxnsInWindow(from, to) {
      const txns = [];
      let offset = 0;
      const limit = 100;
      const fromStr = encodeURIComponent(fmtDate(from));
      const toStr = encodeURIComponent(fmtDate(to));
      while (true) {
        try {
          const path = '/resources/kyt/txns/query/-;data.txnDate__gte=' + fromStr + ';data.txnDate__lte=' + toStr + '?limit=' + limit + '&offset=' + offset + '&order=-data.txnDate';
          const r = await sumsubRequest('GET', path);
          const items = (r.list && r.list.items) || r.items || [];
          txns.push(...items);
          if (items.length < limit) break;
          offset += limit;
          await sleep(300);
        } catch (e) { console.error('Txn fetch error:', e.message); break; }
      }
      return txns;
    }

    async function getTxns(applicantId, from, to) {
      try {
        const fromStr = encodeURIComponent(fmtDate(from));
        const toStr = encodeURIComponent(fmtDate(to));
        const path = '/resources/kyt/txns/query/-;data.txnDate__gte=' + fromStr + ';data.txnDate__lte=' + toStr + ';applicantId=' + applicantId + '?limit=500&order=-data.txnDate';
        const r = await sumsubRequest('GET', path);
        return (r.list && r.list.items) || r.items || [];
      } catch { return []; }
    }

    function normalizeTxn(txn) {
      const d = txn.data || {};
      const info = d.info || {};
      const sumsubId = txn.id || '';
      const internalTxnId = d.txnId || '';
      return {
        sumsubId,
        txnId: internalTxnId,
        id: sumsubId,
        applicantId: txn.applicantId || '',
        externalUserId: txn.externalUserId || '',
        createdAt: d.txnDate || txn.createdAt || '',
        direction: info.direction || '',
        amount: info.amount || info.amountInDefaultCurrency || 0,
        fiatAmount: info.amountInDefaultCurrency || info.amount || 0,
        currencyCode: info.currencyCode || '',
        counterpartyName: d.counterparty?.fullName || d.counterparty?.externalUserId || '',
        counterparty: d.counterparty?.externalUserId || d.counterparty?.fullName || '',
        beneficiaryName: d.counterparty?.fullName || '',
        senderName: d.applicant?.fullName || d.applicant?.externalUserId || '',
      };
    }

    console.log('Fetching transactions:', reviewStart.toISOString(), '->', reviewEnd.toISOString());
    const allWindowTxns = await getAllTxnsInWindow(reviewStart, reviewEnd);
    console.log('Total transactions fetched:', allWindowTxns.length);
    if (allWindowTxns.length > 0) {
      const s = allWindowTxns[0];
      console.log('Sample - sumsubId:', s.id, '| txnId:', s.data && s.data.txnId || 'none');
    }

    const applicantTxnMap = {};
    for (const txn of allWindowTxns) {
      const aid = txn.applicantId;
      if (!aid) continue;
      if (!applicantTxnMap[aid]) applicantTxnMap[aid] = [];
      applicantTxnMap[aid].push(normalizeTxn(txn));
    }
    const applicants = Object.keys(applicantTxnMap).map(id => ({ id, applicantId: id, externalUserId: allWindowTxns.find(t => t.applicantId === id)?.externalUserId || id }));
    console.log('Unique applicants found:', applicants.length);

    function pSummary(txns) {
      if (!txns.length) return { txnCount: 0, totalVolume: 0, avgTxnSize: 0 };
      const txnCount = txns.length;
      const totalVolume = txns.reduce((s, t) => s + Math.abs(parseFloat(t.amount || t.fiatAmount || 0)), 0);
      return { txnCount, totalVolume, avgTxnSize: totalVolume / txnCount };
    }

    function baseline(history) {
      const valid = history.filter(p => p.txnCount > 0);
      if (valid.length < 2) return null;
      const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
      const std = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + Math.pow(y - m, 2), 0) / a.length); };
      return {
        count: { mean: mean(valid.map(p => p.txnCount)), stddev: std(valid.map(p => p.txnCount)) },
        volume: { mean: mean(valid.map(p => p.totalVolume)), stddev: std(valid.map(p => p.totalVolume)) },
        size: { mean: mean(valid.map(p => p.avgTxnSize)), stddev: std(valid.map(p => p.avgTxnSize)) },
        periods: valid.length,
      };
    }

    let seq = 1;
    function fid() {
      const tag = periodLabel.replace(/\W/g, '').toUpperCase().slice(0, 6);
      return 'AML-' + now.getUTCFullYear() + '-' + tag + '-' + String(seq++).padStart(4, '0');
    }

    function detectFlags(aid, txns, cur, bl, hist) {
      const flags = [];
      const push = (rule, ruleRef, cat, sev, rationale, txnRefs, counterparties, sarRisk) => {
        flags.push({
          id: fid(), applicantId: aid, rule, ruleRef, category: cat, severity: sev, rationale,
          txnIds: txnRefs.slice(0, 20).map(t => t.sumsubId || t.id || ''),
          txnInternalIds: txnRefs.slice(0, 20).map(t => t.txnId || ''),
          counterparties, sarRisk,
        });
      };
      const out = txns.filter(t => ['outbound','debit','out'].includes((t.direction || '').toLowerCase()));
      const inb = txns.filter(t => ['inbound','credit','in'].includes((t.direction || '').toLowerCase()));
      const amt = t => Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
      const ids = arr => arr;

      // Entity classification per v2 §0.3
      // Established: >= 3 months baseline history AND >= 8 baseline txns across >= 2 baseline months
      const baselineMonthsWithData = hist.filter(p => p.txnCount > 0).length;
      const baselineTxnTotal = hist.reduce((s, p) => s + p.txnCount, 0);
      const isEstablished = baselineMonthsWithData >= 2 && baselineTxnTotal >= 8;

      // Dormant-returning: established history, then <3 tx/period for >= 2 periods
      const wasDormant = hist.length >= 2 && hist.slice(-2).every(p => p.txnCount < 3) && baselineMonthsWithData >= 3;

      // Median tx amount for Structuring Index median check
      const sortedAmts = txns.map(amt).filter(a => a > 0).sort((a, b) => a - b);
      const medianAmt = sortedAmts.length > 0 ? sortedAmts[Math.floor(sortedAmts.length / 2)] : 0;

      // ── SECTION 1: Behavioral Deviation (Established entities only) ──────────────
      if (isEstablished && bl) {

        // Volume Spike v2: > mu+2sigma AND >= 2x baseline mean AND absolute count >= 10
        const cntThr = bl.count.mean + 2 * bl.count.stddev;
        if (cur.txnCount > cntThr && cur.txnCount >= bl.count.mean * 2 && cur.txnCount >= 10) {
          push('Volume Spike — Transaction Count', 'Detection Rules v2 §1 | 31 U.S.C. § 5318', 'Behavioral Deviation', 'Medium',
            cur.txnCount + ' transactions exceeds 2σ threshold of ' + cntThr.toFixed(1) + ' (μ=' + bl.count.mean.toFixed(1) + ') AND is >= 2x baseline mean AND >= 10 absolute. Baseline periods: ' + hist.length + '.',
            ids(txns), [], false);
        }

        // Amount Spike v2: > mu+2sigma AND >= 2x baseline mean AND >= $25K above baseline mean
        const volThr = bl.volume.mean + 2 * bl.volume.stddev;
        const volExcess = cur.totalVolume - bl.volume.mean;
        if (cur.totalVolume > volThr && cur.totalVolume >= bl.volume.mean * 2 && volExcess >= 25000) {
          push('Amount Spike — Total Volume', 'Detection Rules v2 §1 | 31 U.S.C. § 5318', 'Behavioral Deviation', 'Medium',
            'Total $' + cur.totalVolume.toLocaleString('en', {maximumFractionDigits:0}) + ' exceeds 2σ threshold $' + volThr.toLocaleString('en', {maximumFractionDigits:0}) + ', is >= 2x baseline mean, and is $' + volExcess.toLocaleString('en', {maximumFractionDigits:0}) + ' above baseline mean (floor: $25K).',
            ids(txns), [], false);
        }

        // Velocity Escalation v2: weekly cadence >= 2x baseline AND baseline >= 5 tx/week AND sustained >= 2 consecutive weeks
        const wk = {};
        txns.forEach(t => { const d = new Date(t.createdAt || 0); const w = Math.floor(d / 604800000); wk[w] = (wk[w] || 0) + 1; });
        const wkArr = Object.entries(wk).sort((a, b) => a[0] - b[0]).map(e => e[1]);
        const baselineWeeklyAvg = bl.count.mean / 4.33;
        if (baselineWeeklyAvg >= 5 && wkArr.length >= 2) {
          let sustainedCount = 0;
          for (let i = 1; i < wkArr.length; i++) {
            if (wkArr[i] >= wkArr[i-1] * 2 && wkArr[i-1] >= baselineWeeklyAvg) sustainedCount++;
          }
          if (sustainedCount >= 2) {
            push('Velocity Escalation', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
              'Weekly cadence doubled for >= 2 consecutive weeks (baseline avg: ' + baselineWeeklyAvg.toFixed(1) + ' tx/week, baseline threshold: >= 5 tx/week). Sustained acceleration pattern.',
              ids(txns).slice(0, 10), [], false);
          }
        }

        // Size Threshold Jump v2: avg tx > 150% of prior-period avg AND prior period had >= 8 tx AND avg increase >= $5K
        if (bl.size.mean > 0 && cur.avgTxnSize > bl.size.mean * 1.5) {
          const priorPeriodTxns = hist[hist.length - 1] ? hist[hist.length - 1].txnCount : 0;
          const increase = cur.avgTxnSize - bl.size.mean;
          if (priorPeriodTxns >= 8 && increase >= 5000) {
            push('Transaction Size Threshold Jump', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
              'Avg tx $' + cur.avgTxnSize.toLocaleString('en', {maximumFractionDigits:0}) + ' is ' + ((cur.avgTxnSize / bl.size.mean - 1) * 100).toFixed(0) + '% above prior avg $' + bl.size.mean.toLocaleString('en', {maximumFractionDigits:0}) + '. Increase of $' + increase.toLocaleString('en', {maximumFractionDigits:0}) + ' (floor: $5K). Prior period had ' + priorPeriodTxns + ' tx (floor: 8).',
              ids(txns).slice(0, 10), [], false);
          }
        }

        // Concentration Risk v2: > 70% outbound to single beneficiary AND >= 10 outbound tx AND co-occurrence required (checked post-push)
        if (out.length >= 10) {
          const total = out.reduce((s, t) => s + amt(t), 0);
          const bmap = {};
          out.forEach(t => { const k = t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown'; bmap[k] = (bmap[k] || 0) + amt(t); });
          Object.entries(bmap).forEach(([party, a]) => {
            if (total > 0 && a / total > 0.7) {
              push('Concentration Risk — Single Beneficiary', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
                (a / total * 100).toFixed(1) + '% of outbound ($' + a.toLocaleString('en', {maximumFractionDigits:0}) + ' of $' + total.toLocaleString('en', {maximumFractionDigits:0}) + ') to "' + party + '" — exceeds 70% with >= 10 outbound tx. Requires co-occurring flag from another category to promote to High.',
                ids(out.filter(t => (t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown') === party)), [party], false);
            }
          });
        }

        // Round-Dollar Clustering v2: > 60% at exact round amounts AND >= 10 tx AND co-occurrence required
        if (txns.length >= 10) {
          const rnd = txns.filter(t => amt(t) > 0 && amt(t) % 1000 === 0);
          if (rnd.length / txns.length > 0.6) {
            push('Round-Dollar Clustering', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
              (rnd.length / txns.length * 100).toFixed(1) + '% of txns (' + rnd.length + '/' + txns.length + ') at exact round amounts — exceeds 60% with >= 10 tx. Requires co-occurring flag to promote to High.',
              ids(rnd).slice(0, 15), [], false);
          }
        }

        // Dormancy Transition v2: must have prior established activity (wasDormant), then >= 5 tx AND >= $25K
        if (wasDormant && cur.txnCount >= 5 && cur.totalVolume >= 25000) {
          push('Dormancy-to-Activity Transition', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
            'Established entity dormant (<3 tx/period) for >= 2 consecutive prior periods, now ' + cur.txnCount + ' tx / $' + cur.totalVolume.toLocaleString('en', {maximumFractionDigits:0}) + '. Requires prior established activity (not new entity onboarding).',
            ids(txns).slice(0, 10), [], false);
        }

        // Temporal Concentration v2 (quarterly only): > 60% of quarterly volume in one month AND quarterly vol >= $100K AND >= 15 tx
        if (mode === 'quarterly' && cur.totalVolume >= 100000 && cur.txnCount >= 15) {
          const mmap = {}; let tv = 0;
          txns.forEach(t => { const m = new Date(t.createdAt || 0).getUTCMonth(); const a = amt(t); mmap[m] = (mmap[m] || 0) + a; tv += a; });
          if (tv > 0) {
            Object.entries(mmap).forEach(([m, v]) => {
              if (v / tv > 0.6) {
                const mn = new Date(2000, parseInt(m), 1).toLocaleString('en', {month:'long'});
                push('Temporal Concentration — Single Month', 'Detection Rules v2 §1', 'Behavioral Deviation', 'Medium',
                  (v / tv * 100).toFixed(1) + '% of quarterly volume in ' + mn + ' (quarterly total: $' + tv.toLocaleString('en', {maximumFractionDigits:0}) + ', tx count: ' + cur.txnCount + '). Floors: >= $100K quarterly vol, >= 15 tx.',
                  ids(txns.filter(t => new Date(t.createdAt || 0).getUTCMonth() === parseInt(m))), [], false);
              }
            });
          }
        }
      }

      // Promote behavioral flags to High if co-occurring with Structuring or Network flag
      // (checked after all rules run — handled in scoreEntity/post-processing)

      // ── SECTION 2: Structuring & Layering (all entities) ─────────────────────────

      // Structuring Index v2: >= 30% in $8K-$9,999 AND >= 4 tx in band AND entity median tx < $15K
      const sub = txns.filter(t => amt(t) >= 8000 && amt(t) < 10000);
      const si = txns.length > 0 ? sub.length / txns.length : 0;
      if (si >= 0.3 && sub.length >= 4 && medianAmt < 15000) {
        push('Structuring Index — Just-Below-Threshold', 'Detection Rules v2 §2 | 31 U.S.C. § 5324', 'Structuring & Layering', 'High',
          'Structuring Index ' + (si * 100).toFixed(1) + '%: ' + sub.length + ' of ' + txns.length + ' tx in $8K-$9,999 band (floor: 4 tx in band, >= 30%). Entity median tx $' + medianAmt.toLocaleString('en', {maximumFractionDigits:0}) + ' < $15K (confirms sub-threshold pattern). 31 U.S.C. § 5324.',
          ids(sub), [], true);
      }

      // 72-Hour Clustering v2: >= 3 tx each $3K-$9,999 same direction within 72h AND aggregate > $10K
      const subWindow = txns.filter(t => amt(t) >= 3000 && amt(t) < 10000);
      const sortedSub = [...subWindow].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      for (let i = 0; i < sortedSub.length - 2; i++) {
        const window3 = sortedSub.slice(i, i + 3);
        const lastTime = new Date(window3[2].createdAt || 0);
        const firstTime = new Date(window3[0].createdAt || 0);
        const hrs = (lastTime - firstTime) / 3600000;
        const windowDir = (window3[0].direction || '').toLowerCase();
        const sameDir = window3.every(t => (t.direction || '').toLowerCase() === windowDir);
        const aggregate = window3.reduce((s, t) => s + amt(t), 0);
        if (hrs <= 72 && sameDir && aggregate > 10000) {
          push('72-Hour Clustering', 'Detection Rules v2 §2 | 31 U.S.C. § 5324', 'Structuring & Layering', 'High',
            window3.length + ' transactions ($' + window3.map(t => amt(t).toLocaleString('en', {maximumFractionDigits:0})).join(', $') + ') each in $3K-$9,999 range, same direction, within ' + hrs.toFixed(1) + 'h, aggregate $' + aggregate.toLocaleString('en', {maximumFractionDigits:0}) + ' > $10K. 31 U.S.C. § 5324.',
            ids(window3), [], true);
          break;
        }
      }

      // Frequency & Uniformity v2: >= 5 tx with <5% variance AND each < $10K AND not matching recurring cadence
      if (txns.length >= 5) {
        const subThreshTxns = txns.filter(t => amt(t) > 0 && amt(t) < 10000);
        if (subThreshTxns.length >= 5) {
          const amts2 = subThreshTxns.map(amt);
          const mean2 = amts2.reduce((a, b) => a + b, 0) / amts2.length;
          const maxV2 = Math.max(...amts2.map(a => Math.abs(a - mean2) / mean2));
          if (maxV2 < 0.05) {
            // Check if recurring cadence (same day-of-month or weekly +/- 1 day)
            const days = subThreshTxns.map(t => new Date(t.createdAt || 0).getUTCDate()).sort((a,b)=>a-b);
            const dayOfWeek = subThreshTxns.map(t => new Date(t.createdAt || 0).getUTCDay());
            const sameDayOfMonth = days.every(d => Math.abs(d - days[0]) <= 1);
            const sameWeekday = dayOfWeek.every(d => Math.abs(d - dayOfWeek[0]) <= 1);
            if (!sameDayOfMonth && !sameWeekday) {
              push('Frequency & Uniformity Pattern', 'Detection Rules v2 §2 | 31 U.S.C. § 5324', 'Structuring & Layering', 'High',
                subThreshTxns.length + ' transactions with <5% amount variance (max ' + (maxV2 * 100).toFixed(2) + '%, mean $' + mean2.toLocaleString('en', {maximumFractionDigits:0}) + '), each < $10K, not matching a recurring payroll/rent/subscription cadence. 31 U.S.C. § 5324.',
                ids(subThreshTxns).slice(0, 10), [], true);
            }
          }
        }
      }

      // Split Payments v2: >= 2 payments to same beneficiary within 72h each $3K-$9,999 AND aggregate > $10K
      const bgrp = {};
      txns.forEach(t => { const k = t.counterpartyName || t.beneficiaryName || t.counterparty || 'Unknown'; if (!bgrp[k]) bgrp[k] = []; bgrp[k].push(t); });
      Object.entries(bgrp).forEach(([party, grp]) => {
        if (grp.length < 2) return;
        const eligGrp = grp.filter(t => amt(t) >= 3000 && amt(t) < 10000);
        if (eligGrp.length < 2) return;
        const sortedGrp = [...eligGrp].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const hrs72 = (new Date(sortedGrp[sortedGrp.length-1].createdAt || 0) - new Date(sortedGrp[0].createdAt || 0)) / 3600000;
        const aggregate = sortedGrp.reduce((s, t) => s + amt(t), 0);
        if (hrs72 <= 72 && aggregate > 10000) {
          push('Split Payments — Same Beneficiary', 'Detection Rules v2 §2 | 31 U.S.C. § 5324', 'Structuring & Layering', 'High',
            sortedGrp.length + ' payments to "' + party + '" within ' + hrs72.toFixed(1) + 'h each in $3K-$9,999 range (aggregate $' + aggregate.toLocaleString('en', {maximumFractionDigits:0}) + ' > $10K). Sub-threshold splitting to evade reporting. 31 U.S.C. § 5324.',
            ids(sortedGrp), [party], true);
        }
      });

      // ── SECTION 3: Network & Flow Patterns (all entities) ─────────────────────────

      // Reciprocal Payment v2: bidirectional within 20% AND each leg >= $10K
      const inMap = {}, outMap = {};
      inb.forEach(t => { const p = t.counterpartyName || t.senderName || t.counterparty || '?'; inMap[p] = (inMap[p] || 0) + amt(t); });
      out.forEach(t => { const p = t.counterpartyName || t.beneficiaryName || t.counterparty || '?'; outMap[p] = (outMap[p] || 0) + amt(t); });
      Object.entries(inMap).forEach(([party, inA]) => {
        if (!outMap[party]) return;
        const outA = outMap[party];
        if (inA < 10000 || outA < 10000) return;
        const ratio = Math.abs(inA - outA) / Math.max(inA, outA);
        if (ratio <= 0.2) {
          const inTs = inb.filter(t => (t.counterpartyName || t.senderName || t.counterparty || '?') === party);
          const outTs = out.filter(t => (t.counterpartyName || t.beneficiaryName || t.counterparty || '?') === party);
          let w7 = false;
          inTs.forEach(i => outTs.forEach(o => { if (Math.abs(new Date(i.createdAt || 0) - new Date(o.createdAt || 0)) / 86400000 <= 7) w7 = true; }));
          push(w7 ? 'Reciprocal Payment — Escalated (7d)' : 'Reciprocal Payment Pattern', 'Detection Rules v2 §3 | 31 U.S.C. § 5318', 'Network & Flow Pattern', w7 ? 'High' : 'Medium',
            'Bidirectional with "' + party + '": in $' + inA.toLocaleString('en', {maximumFractionDigits:0}) + ' / out $' + outA.toLocaleString('en', {maximumFractionDigits:0}) + ' (' + (ratio * 100).toFixed(1) + '% diff, each leg >= $10K).' + (w7 ? ' Within 7 days — escalated.' : ''),
            ids([...inTs, ...outTs]), [party], w7);
        }
      });

      // Pass-Through v2: >= $10K inbound -> different party within 48h <= 10% retention AND pattern >= 2x in period
      const passThroughMatches = [];
      inb.forEach(inT => {
        const inA = amt(inT);
        if (inA < 10000) return;
        const inTime = new Date(inT.createdAt || 0);
        out.forEach(outT => {
          const outA = amt(outT);
          const hrs = (new Date(outT.createdAt || 0) - inTime) / 3600000;
          if (hrs >= 0 && hrs <= 48) {
            const net = (inA - outA) / inA;
            const ip = inT.counterpartyName || inT.senderName || '?';
            const op = outT.counterpartyName || outT.beneficiaryName || '?';
            if (net >= 0 && net <= 0.1 && ip !== op) {
              passThroughMatches.push({ inT, outT, inA, outA, hrs, net, ip, op });
            }
          }
        });
      });
      if (passThroughMatches.length >= 2) {
        const first = passThroughMatches[0];
        push('Pass-Through / Transit Payment', 'Detection Rules v2 §3 | 31 U.S.C. § 5318', 'Network & Flow Pattern', 'High',
          passThroughMatches.length + 'x pass-through pattern detected (>= 2 required for High). Example: $' + first.inA.toLocaleString('en', {maximumFractionDigits:0}) + ' from "' + first.ip + '" to "' + first.op + '" in ' + first.hrs.toFixed(1) + 'h at ' + (first.net * 100).toFixed(1) + '% retention. Each inbound >= $10K.',
          ids([...passThroughMatches.map(m => m.inT), ...passThroughMatches.map(m => m.outT)]).slice(0, 20), [], true);
      } else if (passThroughMatches.length === 1) {
        const m = passThroughMatches[0];
        push('Pass-Through / Transit Payment (Single Occurrence)', 'Detection Rules v2 §3 | 31 U.S.C. § 5318', 'Network & Flow Pattern', 'Medium',
          '$' + m.inA.toLocaleString('en', {maximumFractionDigits:0}) + ' from "' + m.ip + '" to "' + m.op + '" in ' + m.hrs.toFixed(1) + 'h at ' + (m.net * 100).toFixed(1) + '% retention (>= $10K). Single occurrence — downgraded to Medium per v2 §3.',
          ids([m.inT, m.outT]), [m.ip, m.op], false);
      }

      // Net Flow Near-Zero v2: in/out within 10% on > $50K AND >= 10 tx each direction AND entity not a declared intermediary/PSP
      const tIn = inb.reduce((s, t) => s + amt(t), 0);
      const tOut = out.reduce((s, t) => s + amt(t), 0);
      if ((tIn + tOut) > 50000 && tIn > 0 && tOut > 0 && inb.length >= 10 && out.length >= 10) {
        const r = Math.abs(tIn - tOut) / Math.max(tIn, tOut);
        if (r <= 0.1) {
          push('Net Flow Near-Zero', 'Detection Rules v2 §3 | 31 U.S.C. § 5318', 'Network & Flow Pattern', 'High',
            'In $' + tIn.toLocaleString('en', {maximumFractionDigits:0}) + ' (' + inb.length + ' tx) / Out $' + tOut.toLocaleString('en', {maximumFractionDigits:0}) + ' (' + out.length + ' tx) — ' + (r * 100).toFixed(1) + '% diff on > $50K total. Floors: >= 10 tx each direction. Entity not declared intermediary/PSP.',
            ids(txns).slice(0, 10), [], true);
        }
      }

      return flags;
    }

    function scoreEntity(flags) {
      if (flags.length === 0) return { score: 0, tier: 1, tierLabel: 'No Action', action: 'Monitor & Close', clusters: [] };

      // v2 §5.1: Deduplicate flags sharing > 50% of underlying transaction IDs
      const clusters = [];
      const assigned = new Set();
      flags.forEach((f, i) => {
        if (assigned.has(i)) return;
        const cluster = [i];
        assigned.add(i);
        const fIds = new Set(f.txnIds.filter(Boolean));
        flags.forEach((g, j) => {
          if (assigned.has(j)) return;
          const gIds = new Set(g.txnIds.filter(Boolean));
          if (fIds.size === 0 && gIds.size === 0) return;
          const intersection = [...fIds].filter(id => gIds.has(id)).length;
          const union = new Set([...fIds, ...gIds]).size;
          if (union > 0 && intersection / union > 0.5) {
            cluster.push(j);
            assigned.add(j);
          }
        });
        clusters.push(cluster);
      });

      // v2 §5.2: Composite scoring
      let score = 0;
      const categoriesPresent = new Set();
      clusters.forEach((cluster, ci) => {
        const clusterFlags = cluster.map(i => flags[i]);
        const highestSev = clusterFlags.some(f => f.severity === 'High') ? 'High' : 'Medium';
        clusterFlags.forEach(f => categoriesPresent.add(f.category));
        const hasStructuring = clusterFlags.some(f => f.category === 'Structuring & Layering');

        if (ci === 0) {
          score += highestSev === 'High' ? 25 : 10;
        } else {
          score += highestSev === 'High' ? 12 : 5;
        }
        if (hasStructuring) score += 5;
      });

      // Independent-category bonus
      if (categoriesPresent.size >= 2) score += 10;

      score = Math.min(100, score);

      // v2 §5.3: Tier gates
      const clusterCount = clusters.length;
      const hasStructuringOrNetwork = [...categoriesPresent].some(c => c === 'Structuring & Layering' || c === 'Network & Flow Pattern');

      let tier, tierLabel, action;
      if (score <= 25) {
        tier = 1; tierLabel = 'No Action'; action = 'Monitor & Close';
      } else if (score <= 50) {
        tier = 2; tierLabel = 'Enhanced Monitoring'; action = 'Enhanced Monitoring';
      } else if (score <= 74) {
        // Tier 3 requires >= 2 independent clusters
        if (clusterCount >= 2) {
          tier = 3; tierLabel = 'Investigator Escalation'; action = 'Internal Investigation';
        } else {
          tier = 2; tierLabel = 'Enhanced Monitoring'; action = 'Enhanced Monitoring';
        }
      } else if (score <= 89) {
        // Tier 4 requires >= 2 categories represented
        if (categoriesPresent.size >= 2) {
          tier = 4; tierLabel = 'SAR Consideration'; action = 'SAR Consideration';
        } else {
          tier = 3; tierLabel = 'Investigator Escalation'; action = 'Internal Investigation';
        }
      } else {
        // Tier 5 requires a Structuring or Network cluster
        if (hasStructuringOrNetwork) {
          tier = 5; tierLabel = 'Mandatory SAR + Relationship Review'; action = 'SAR Consideration';
        } else {
          tier = 4; tierLabel = 'SAR Consideration'; action = 'SAR Consideration';
        }
      }

      return { score, tier, tierLabel, action, clusters };
    }

    function makeRFI(entityFlags, applicantName, entityTier) {
      // v2 §5.4: One consolidated RFI per entity, Tier >= 4 only
      if (entityTier < 4) return null;
      const sarWarn = entityFlags.some(f => f.sarRisk) ? '\n\n⚠ SAR RISK: Failure to respond may result in a SAR filing under 31 U.S.C. § 5318(g).' : '';
      const categories = [...new Set(entityFlags.map(f => f.category))];
      const flagSummary = entityFlags.map(f => '• ' + f.rule + ': ' + f.rationale.slice(0, 120) + '...').join('\n');

      const baseQ = [
        '1. Provide a written explanation of the patterns identified across all flagged activity listed above.',
        '2. Provide supporting documentation (invoices, contracts, agreements) for all flagged transactions.',
        '3. Were any transactions made at the direction of or on behalf of a third party? Identify them.',
        '4. Provide evidence of source of funds for all material inflows during the review period.',
        '5. Explain any material change in business activity, counterparty relationships, or transaction volumes.',
      ];
      if (categories.includes('Structuring & Layering')) {
        baseQ.push('6. For each sub-threshold transaction cluster: explain why the specific amounts were chosen and provide the underlying commercial obligation they relate to.');
      }
      if (categories.includes('Network & Flow Pattern')) {
        baseQ.push('7. For funds received and subsequently forwarded: describe your economic role as the intermediate party and provide documentation of goods or services rendered.');
      }

      const why = 'CONSOLIDATED RFI — ' + entityFlags.length + ' FLAGS ACROSS ' + categories.length + ' CATEGORIES\nPERIOD: ' + periodLabel + '\n\nFLAGS DETECTED:\n' + flagSummary + '\n\nSumSub IDs (sample): ' + entityFlags.flatMap(f => f.txnIds.filter(Boolean)).slice(0, 10).join(', ') + sarWarn;
      const what = 'REQUIRED RESPONSE (within 10 business days):\n\n' + baseQ.join('\n\n') + '\n\nIssued by: Kira Financial AI Compliance | Date: ' + new Date().toISOString().slice(0, 10);
      return { why, what, full: 'KIRA FINANCIAL AI — REQUEST FOR INFORMATION\n' + '='.repeat(44) + '\nTo: ' + applicantName + '\nDate: ' + new Date().toISOString().slice(0, 10) + '\n\n' + why + '\n\n' + '-'.repeat(60) + '\n\n' + what };
    }

        const results = { mode, periodLabel, reviewStart: reviewStart.toISOString(), reviewEnd: reviewEnd.toISOString(), runTimestamp: new Date().toISOString(), ruleVersion: 'Detection Rules v2 (Feb-Jun 2026 backtest revision)', totalApplicants: applicants.length, totalTransactionsAnalyzed: 0, totalFlags: 0, flagsByCategory: {}, flagsBySeverity: {High:0,Medium:0,Low:0}, riskTierDistribution: {1:0,2:0,3:0,4:0,5:0}, sarRiskFlags: 0, entityResults: [] };

    const BATCH = 10;
    for (let i = 0; i < applicants.length; i += BATCH) {
      const batch = applicants.slice(i, i + BATCH);
      const batchRes = await Promise.allSettled(batch.map(async app => {
        const aid = app.id || app.applicantId;
        const name = app.externalUserId || aid;
        const curTxns = applicantTxnMap[aid] || [];
        if (!curTxns.length) return null;
        const hist = [];
        for (const w of baselineWindows) {
          const bTxns = await getTxns(aid, w.start, w.end);
          hist.push(pSummary(bTxns.map(normalizeTxn)));
          await sleep(50);
        }
        const cur = pSummary(curTxns);
        const bl = baseline(hist);
        const flags = detectFlags(aid, curTxns, cur, bl, hist);
        if (!flags.length) return null;
        const { score, tier, tierLabel, action } = scoreEntity(flags);
        const entityRFI = makeRFI(flags, name, tier);
        const flagsWithRFI = flags.map(f => ({ ...f, rfi: null, recommendedAction: action, status: 'Open' }));
        return { applicantId: aid, applicantName: name, riskScore: score, riskTier: tier, riskTierLabel: tierLabel, recommendedAction: action, transactionCount: curTxns.length, totalVolume: cur.totalVolume, flags: flagsWithRFI, flagCount: flagsWithRFI.length, sarRiskCount: flagsWithRFI.filter(f => f.sarRisk).length, entityRFI };
      }));
      batchRes.forEach(r => { if (r.status === 'fulfilled' && r.value) results.entityResults.push(r.value); });
      if (i + BATCH < applicants.length) await sleep(250);
    }

    results.entityResults.sort((a, b) => b.riskScore - a.riskScore);
    results.totalTransactionsAnalyzed = results.entityResults.reduce((s, e) => s + e.transactionCount, 0);
    results.totalFlags = results.entityResults.reduce((s, e) => s + e.flagCount, 0);
    results.sarRiskFlags = results.entityResults.reduce((s, e) => s + e.sarRiskCount, 0);
    results.entityResults.forEach(e => {
      results.riskTierDistribution[e.riskTier] = (results.riskTierDistribution[e.riskTier] || 0) + 1;
      e.flags.forEach(f => { results.flagsByCategory[f.category] = (results.flagsByCategory[f.category] || 0) + 1; results.flagsBySeverity[f.severity] = (results.flagsBySeverity[f.severity] || 0) + 1; });
    });
    results.top5 = results.entityResults.slice(0, 5).map(e => ({ applicantId: e.applicantId, applicantName: e.applicantName, riskScore: e.riskScore, riskTier: e.riskTier, riskTierLabel: e.riskTierLabel, flagCount: e.flagCount, sarRiskCount: e.sarRiskCount }));
    results.runtimeMs = Date.now() - startTime;
    res.json({ success: true, results });
  } catch (err) {
    console.error('Analysis failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/export/rfi', (req, res) => {
  const { flag, applicantName } = req.body;
  if (!flag || !flag.rfi) return res.status(400).json({ error: 'no RFI on this flag' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="RFI-' + flag.id + '.txt"');
  res.send(flag.rfi.full);
});


app.get('/debug', (req, res) => {
  const fs = require('fs');
  const root = __dirname;
  let files = [];
  try { files = fs.readdirSync(root); } catch(e) { files = ['error: ' + e.message]; }
  let pub = [];
  try { pub = fs.readdirSync(path.join(root, 'public')); } catch(e) { pub = ['error: ' + e.message]; }
  res.json({ __dirname: root, rootFiles: files, publicFiles: pub });
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Kira AML Bot running on port ' + PORT));
