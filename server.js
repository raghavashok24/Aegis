const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());

// CORS — allow any origin (the HTML file opens from your desktop)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check — Render uses this to confirm the service is up
app.get('/health', (req, res) => {
  const hasToken = !!process.env.SUMSUB_TOKEN;
  const hasSecret = !!process.env.SUMSUB_SECRET;
  res.json({
    ok: true,
    time: new Date().toISOString(),
    credentials: hasToken && hasSecret ? 'configured' : 'MISSING',
    token: hasToken ? 'set' : 'NOT SET',
    secret: hasSecret ? 'set' : 'NOT SET',
  });
});

// ── SumSub HMAC auth ──────────────────────────────────────────────────────────
function sumsubRequest(method, path, body = null) {
  const token = process.env.SUMSUB_TOKEN;
  const secret = process.env.SUMSUB_SECRET;
  if (!token || !secret) {
    throw new Error('SUMSUB_TOKEN or SUMSUB_SECRET environment variable is not set. Add them in Render → Environment tab.');
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig = crypto.createHmac('sha256', secret).update(ts + method.toUpperCase() + path + bodyStr).digest('hex');
  const headers = {
    'X-App-Token': token,
    'X-App-Access-Sig': sig,
    'X-App-Access-Ts': ts,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.sumsub.com', port: 443, path, method: method.toUpperCase(), headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) reject(new Error(`SumSub ${res.statusCode}: ${data.slice(0, 300)}`));
          else resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Generic SumSub proxy endpoint ─────────────────────────────────────────────
// The frontend sends { method, path, body } and this forwards it to SumSub
app.post('/sumsub', async (req, res) => {
  const { method = 'GET', path, body } = req.body;
  if (!path) return res.status(400).json({ error: 'path is required' });
  try {
    const data = await sumsubRequest(method, path, body);
    res.json(data);
  } catch (e) {
    console.error('SumSub error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Full analysis endpoint ────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  // mode: 'monthly' | 'quarterly' | 'custom'
  // For custom: customStart (YYYY-MM), customEnd (YYYY-MM) — multi-month range
  const { mode, customStart, customEnd } = req.body;
  if (!['monthly', 'quarterly', 'custom'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be monthly, quarterly, or custom' });
  }

  try {
    const startTime = Date.now();
    const now = new Date();
    let reviewStart, reviewEnd, periodLabel;

    if (mode === 'custom') {
      // customStart and customEnd are 'YYYY-MM' strings
      if (!customStart || !customEnd) {
        return res.status(400).json({ error: 'customStart and customEnd (YYYY-MM) required for custom mode' });
      }
      const [sy, sm] = customStart.split('-').map(Number);
      const [ey, em] = customEnd.split('-').map(Number);
      reviewStart = new Date(Date.UTC(sy, sm - 1, 1));
      reviewEnd = new Date(Date.UTC(ey, em, 0, 23, 59, 59, 999)); // last day of end month
      // Human-readable label
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      if (customStart === customEnd) {
        periodLabel = `${monthNames[sm-1]} ${sy}`;
      } else {
        periodLabel = `${monthNames[sm-1]} ${sy} – ${monthNames[em-1]} ${ey}`;
      }
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
      periodLabel = `Q${pq + 1} ${yr}`;
    }

    // Baseline: 4 months back for monthly/custom, 9 quarters back for quarterly
    const baselineBack = mode === 'quarterly' ? 9 : 4;
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

    // SumSub correct query endpoint: /resources/kyt/txns/query/-;filters?limit=N&offset=N
    // Dates use "YYYY-MM-DD HH:MM:SS" format in the semicolon path
    function fmtDate(d) {
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+0000');
    }

    async function getAllTxnsInWindow(from, to) {
      const txns = [];
      let offset = 0;
      const limit = 100;
      const fromStr = encodeURIComponent(fmtDate(from));
      const toStr = encodeURIComponent(fmtDate(to));
      while (true) {
        try {
          const path = `/resources/kyt/txns/query/-;data.txnDate__gte=${fromStr};data.txnDate__lte=${toStr}?limit=${limit}&offset=${offset}&order=-data.txnDate`;
          const r = await sumsubRequest('GET', path);
          const items = (r.list && r.list.items) || r.items || [];
          txns.push(...items);
          if (items.length < limit) break;
          offset += limit;
          await sleep(300);
        } catch (e) {
          console.error('Txn fetch error:', e.message);
          break;
        }
      }
      return txns;
    }

    async function getTxns(applicantId, from, to) {
      try {
        const fromStr = encodeURIComponent(fmtDate(from));
        const toStr = encodeURIComponent(fmtDate(to));
        const path = `/resources/kyt/txns/query/-;data.txnDate__gte=${fromStr};data.txnDate__lte=${toStr};applicantId=${applicantId}?limit=500&order=-data.txnDate`;
        const r = await sumsubRequest('GET', path);
        return (r.list && r.list.items) || r.items || [];
      } catch { return []; }
    }

    // Fetch all transactions in review window, group by applicantId
    console.log('Fetching all transactions in window:', reviewStart, '->', reviewEnd);
    const allWindowTxns = await getAllTxnsInWindow(reviewStart, reviewEnd);
    console.log('Total transactions fetched:', allWindowTxns.length);
    if (allWindowTxns.length > 0) {
      const sample = allWindowTxns[0];
      console.log('Sample txn IDs - sumsubId:', sample.id, '| internal txnId:', sample.data?.txnId || 'none');
    }

    // Normalize transaction structure (SumSub nests data under .data)
    function normalizeTxn(txn) {
      const d = txn.data || {};
      const info = d.info || {};
      // SumSub's own ID is at the root level: txn.id
      // Your internal transaction ID is at: txn.data.txnId
      const sumsubId = txn.id || '';
      const internalTxnId = d.txnId || '';
      return {
        sumsubId,                                                  // SumSub root-level ID (e.g. "67fe5cbd3d428fcef242df51")
        txnId: internalTxnId,                                      // Your internal ID (e.g. "finance0001")
        id: sumsubId,                                              // alias for backward compat
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
        type: d.type || '',
        paymentDetails: info.paymentDetails || '',
      };
    }

    const applicantTxnMap = {};
    for (const txn of allWindowTxns) {
      const aid = txn.applicantId;
      if (!aid) continue;
      if (!applicantTxnMap[aid]) applicantTxnMap[aid] = [];
      applicantTxnMap[aid].push(normalizeTxn(txn));
    }
    const applicants = Object.keys(applicantTxnMap).map(id => ({ id, applicantId: id, externalUserId: allWindowTxns.find(t=>t.applicantId===id)?.externalUserId || id }));
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
    function fid() { return `AML-${now.getUTCFullYear()}-${periodLabel.replace(/\W/g,'').toUpperCase().slice(0,6)}-${String(seq++).padStart(4,'0')}`; }

    function detectFlags(aid, txns, cur, bl, hist) {
      const flags = [];
      const push = (rule, ruleRef, cat, sev, rationale, txnRefs, counterparties, sarRisk) => {
        // txnRefs: array of {sumsubId, txnId} objects
        flags.push({
          id: fid(), applicantId: aid, rule, ruleRef, category: cat, severity: sev, rationale,
          txnIds: txnRefs.slice(0,20).map(t => t.sumsubId || t.id || ''),        // SumSub IDs
          txnInternalIds: txnRefs.slice(0,20).map(t => t.txnId || ''),           // Your internal IDs
          txnRefs: txnRefs.slice(0,20),                                           // Full objects
          counterparties, sarRisk
        });
      }

      const out = txns.filter(t => ['outbound','debit','out'].includes((t.direction||t.type||'').toLowerCase()));
      const inb = txns.filter(t => ['inbound','credit','in'].includes((t.direction||t.type||'').toLowerCase()));
      const amt = t => Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
      const ids = arr => arr;  // pass full txn objects so push() can extract both SumSub ID and internal txnId

      // Volume spike
      const cntThr = bl ? bl.count.mean + 2*bl.count.stddev : 10;
      if (cur.txnCount > cntThr && cur.txnCount > 0)
        push('Volume Spike — Transaction Count','Spec §4.1 | Rule 2','Behavioral Deviation','High',
          bl ? `${cur.txnCount} transactions exceeds 2σ threshold of ${cntThr.toFixed(1)} (μ=${bl.count.mean.toFixed(1)}, σ=${bl.count.stddev.toFixed(1)}) from ${bl.periods} prior periods.`
             : `New entity: ${cur.txnCount} transactions exceeds absolute threshold of 10.`,
          ids(txns), [], false);

      // Amount spike
      const volThr = bl ? bl.volume.mean + 2*bl.volume.stddev : 50000;
      if (cur.totalVolume > volThr && cur.totalVolume > 0)
        push('Amount Spike — Total Volume','Spec §4.1 | Rule 2','Behavioral Deviation','High',
          `Total $${cur.totalVolume.toLocaleString('en',{maximumFractionDigits:0})} exceeds ${bl?`2σ threshold $${volThr.toLocaleString('en',{maximumFractionDigits:0})}`:'new-entity threshold $50,000'}.`,
          ids(txns), [], false);

      // Velocity escalation
      if (txns.length >= 4) {
        const wk = {}; txns.forEach(t => { const d = new Date(t.createdAt||t.created_at||0); const w = Math.floor(d/604800000); wk[w]=(wk[w]||0)+1; });
        const wkArr = Object.values(wk).sort((a,b)=>a-b);
        for (let i=1;i<wkArr.length;i++) if (wkArr[i]>=wkArr[i-1]*2&&wkArr[i-1]>0) {
          push('Velocity Escalation','Spec §4.1 | Rule 2','Behavioral Deviation','Medium',`Weekly cadence doubled: ${wkArr[i-1]}→${wkArr[i]} tx. Layering initiation indicator.`,ids(txns).slice(0,10),[],false); break;
        }
      }

      // Size jump
      if (bl && bl.size.mean > 0 && cur.avgTxnSize > bl.size.mean*1.5)
        push('Transaction Size Threshold Jump','Spec §4.1 | Rule 6','Behavioral Deviation','Medium',
          `Avg tx $${cur.avgTxnSize.toLocaleString('en',{maximumFractionDigits:0})} is ${((cur.avgTxnSize/bl.size.mean-1)*100).toFixed(0)}% above prior avg $${bl.size.mean.toLocaleString('en',{maximumFractionDigits:0})} — exceeds 150% threshold.`,
          ids(txns).slice(0,10),[],false);

      // Concentration risk
      if (out.length >= 3) {
        const total = out.reduce((s,t)=>s+amt(t),0);
        const bmap = {}; out.forEach(t=>{const k=t.counterpartyName||t.beneficiaryName||t.counterparty||'Unknown';bmap[k]=(bmap[k]||0)+amt(t);});
        Object.entries(bmap).forEach(([party,a]) => { if(total>0&&a/total>0.7) push('Concentration Risk — Single Beneficiary','Spec §4.1 | Rule 5','Behavioral Deviation','High',`${(a/total*100).toFixed(1)}% of outbound to "${party}" — exceeds 70% threshold.`,ids(out.filter(t=>(t.counterpartyName||t.beneficiaryName||t.counterparty||'Unknown')===party)),[party],false); });
      }

      // Round dollar
      if (txns.length >= 5) {
        const rnd = txns.filter(t=>amt(t)>0&&amt(t)%1000===0);
        if (rnd.length/txns.length>0.4) push('Round-Dollar Clustering','Spec §4.1 | Rule 19','Behavioral Deviation','Medium',`${(rnd.length/txns.length*100).toFixed(1)}% of txns (${rnd.length}/${txns.length}) at exact round amounts — exceeds 40%.`,ids(rnd).slice(0,15),[],false);
      }

      // Dormancy
      if (hist.length>=2&&hist.slice(-2).every(p=>p.txnCount<3)&&cur.txnCount>=5&&cur.totalVolume>=25000)
        push('Dormancy-to-Activity Transition','Spec §4.1 | Rule 9','Behavioral Deviation','High',`Dormant (<3 tx/period) for 2 prior periods, now ${cur.txnCount} tx/$${cur.totalVolume.toLocaleString('en',{maximumFractionDigits:0})} — both thresholds exceeded.`,ids(txns).slice(0,10),[],false);

      // Temporal (quarterly)
      if (mode==='quarterly'&&txns.length>0) {
        const mmap={}; let tv=0; txns.forEach(t=>{const m=new Date(t.createdAt||t.created_at||0).getUTCMonth();const a=amt(t);mmap[m]=(mmap[m]||0)+a;tv+=a;});
        if(tv>0) Object.entries(mmap).forEach(([m,v])=>{if(v/tv>0.6){const mn=new Date(2000,parseInt(m),1).toLocaleString('en',{month:'long'});push('Temporal Concentration — Single Month','Spec §4.1 | Rule 14','Behavioral Deviation','Medium',`${(v/tv*100).toFixed(1)}% of quarterly volume in ${mn} — exceeds 60% threshold.`,ids(txns.filter(t=>new Date(t.createdAt||t.created_at||0).getUTCMonth()===parseInt(m))),[],false);}});
      }

      // Structuring index
      const sub = txns.filter(t=>amt(t)>=8000&&amt(t)<10000);
      const si = txns.length>0?sub.length/txns.length:0;
      if(si>0.2) push('Structuring — Just-Below-Threshold','Spec §4.2 | Rule 4 | 31 U.S.C. § 5324','Structuring & Layering','High',`Structuring Index ${(si*100).toFixed(1)}%: ${sub.length}/${txns.length} txns in $8K–$9,999 band. Federal offense under 31 U.S.C. § 5324.`,ids(sub),[],true);

      // 72h clustering
      const sorted=[...sub].sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0));
      for(let i=0;i<sorted.length-1;i++){const hr=(new Date(sorted[i+1].createdAt||0)-new Date(sorted[i].createdAt||0))/3600000;if(hr<=72){push('Structuring — 72h Window','Spec §4.2.1 | 31 U.S.C. § 5324','Structuring & Layering','High',`Sub-threshold txns within ${hr.toFixed(1)}h. FATF Rec. 20 structuring indicator.`,ids(sorted.slice(i,i+3)),[],true);break;}}

      // Uniformity
      if(txns.length>=4){const amts=txns.map(t=>amt(t)).filter(a=>a>0);if(amts.length>=4){const m=amts.reduce((a,b)=>a+b,0)/amts.length;const maxV=Math.max(...amts.map(a=>Math.abs(a-m)/m));if(maxV<0.05)push('Frequency & Uniformity Pattern','Spec §4.2.1 | Rule 4','Structuring & Layering','Medium',`${txns.length} txns with <5% variance (max ${(maxV*100).toFixed(2)}%). Deliberate splitting indicator.`,ids(txns).slice(0,10),[],true);}}

      // Split payments same beneficiary
      const bgrp={}; txns.forEach(t=>{const k=t.counterpartyName||t.beneficiaryName||t.counterparty||'Unknown';if(!bgrp[k])bgrp[k]=[];bgrp[k].push(t);});
      Object.entries(bgrp).forEach(([party,grp])=>{if(grp.length<2)return;const tot=grp.reduce((s,t)=>s+amt(t),0);const mul=Math.round(tot/10000)*10000;if(Math.abs(tot-mul)<=500&&mul>0)push('Split Payments — Same Beneficiary','Spec §4.2.1 | 31 U.S.C. § 5324','Structuring & Layering','High',`${grp.length} payments to "${party}" = $${tot.toLocaleString('en',{maximumFractionDigits:0})} — within $500 of $${mul.toLocaleString()} multiple.`,ids(grp),[party],true);});

      // Reciprocal
      const inMap={},outMap={};
      inb.forEach(t=>{const p=t.counterpartyName||t.senderName||t.counterparty||'?';inMap[p]=(inMap[p]||0)+amt(t);});
      out.forEach(t=>{const p=t.counterpartyName||t.beneficiaryName||t.counterparty||'?';outMap[p]=(outMap[p]||0)+amt(t);});
      Object.entries(inMap).forEach(([party,inA])=>{if(!outMap[party])return;const outA=outMap[party];const ratio=Math.abs(inA-outA)/Math.max(inA,outA);if(ratio<=0.2){const inTs=inb.filter(t=>(t.counterpartyName||t.senderName||t.counterparty||'?')===party);const outTs=out.filter(t=>(t.counterpartyName||t.beneficiaryName||t.counterparty||'?')===party);let w7=false;inTs.forEach(i=>outTs.forEach(o=>{if(Math.abs(new Date(i.createdAt||0)-new Date(o.createdAt||0))/86400000<=7)w7=true;}));push(w7?'Reciprocal Payment — Escalated (7d)':'Reciprocal Payment Pattern','Spec §4.3.1 | Rule 11','Network & Flow Pattern',w7?'High':'Medium',`Bidirectional with "${party}": in $${inA.toLocaleString('en',{maximumFractionDigits:0})} / out $${outA.toLocaleString('en',{maximumFractionDigits:0})} — ${(ratio*100).toFixed(1)}% diff.${w7?' Within 7 days — pre-coordination.':''}`,ids([...inTs,...outTs]),[party],w7);}});

      // Pass-through
      inb.forEach(inT=>{const inA=amt(inT);const inTime=new Date(inT.createdAt||inT.created_at||0);out.forEach(outT=>{const outA=amt(outT);const hrs=(new Date(outT.createdAt||outT.created_at||0)-inTime)/3600000;if(hrs>=0&&hrs<=48){const net=(inA-outA)/inA;const ip=inT.counterpartyName||inT.senderName||'?';const op=outT.counterpartyName||outT.beneficiaryName||'?';if(net>=0&&net<=0.1&&ip!==op)push('Pass-Through / Transit Payment','Spec §4.3.2 | Rule 3','Network & Flow Pattern','High',`$${inA.toLocaleString('en',{maximumFractionDigits:0})} from "${ip}" → $${outA.toLocaleString('en',{maximumFractionDigits:0})} to "${op}" in ${hrs.toFixed(1)}h at ${(net*100).toFixed(1)}% retention. Conduit entity.`,[inT,outT],[ip,op],true);}});});

      // Net flow near-zero
      const tIn=inb.reduce((s,t)=>s+amt(t),0),tOut=out.reduce((s,t)=>s+amt(t),0);
      if((tIn+tOut)>50000&&tIn>0&&tOut>0){const r=Math.abs(tIn-tOut)/Math.max(tIn,tOut);if(r<=0.1)push('Quarterly Net Flow Near-Zero','Spec §4.3 | Rule 3','Network & Flow Pattern','High',`In $${tIn.toLocaleString('en',{maximumFractionDigits:0})} / Out $${tOut.toLocaleString('en',{maximumFractionDigits:0})} — ${(r*100).toFixed(1)}% diff on >$50K. Pass-through conduit.`,ids(txns).slice(0,10),[],true);}

      return flags;
    }

    function scoreEntity(flags) {
      let score = 0;
      flags.forEach(f => { score += f.severity==='High'?20:8; score += f.category==='Structuring & Layering'?5:f.category==='Network & Flow Pattern'?3:0; });
      score = Math.min(100, score);
      const tiers = [[25,1,'No Action','Monitor & Close'],[50,2,'Enhanced Monitoring','Enhanced Monitoring'],[74,3,'Investigator Escalation','Internal Investigation'],[89,4,'SAR Consideration','SAR Consideration'],[100,5,'Mandatory SAR + Relationship Review','SAR Consideration']];
      for (const [max,tier,label,action] of tiers) if (score<=max) return { score, tier, tierLabel:label, action };
      return { score:100, tier:5, tierLabel:'Mandatory SAR + Relationship Review', action:'SAR Consideration' };
    }

    function makeRFI(flag, applicantName) {
      const sarWarn = flag.sarRisk ? `\n\n⚠ SAR RISK: Failure to respond may result in a SAR filing under 31 U.S.C. § 5318(g).` : '';
      const qMap = {
        'Structuring & Layering': ['1. Explain the business purpose for each flagged transaction, including goods/services and why the specific amount was chosen.','2. Provide invoices, contracts, or purchase orders.','3. Were these installment payments? If so, provide the underlying agreement.','4. Were any made at a third party\'s direction? Identify them.','5. Provide bank statements confirming source of funds.'],
        'Network & Flow Pattern': ['1. Describe the commercial relationship with each identified counterparty.','2. For funds received then forwarded within 48h: explain your economic role and provide documentation.','3. Provide contracts supporting the payment flow.','4. Disclose any ownership interest in identified counterparties.','5. Provide general ledger entries for these transactions.'],
        'Behavioral Deviation': ['1. Explain the reason for the significant change in transaction activity.','2. Provide supporting documentation for all transactions above $5,000.','3. Were any transactions made on behalf of a third party?','4. Explain any change in business activity or counterparty relationships.','5. Provide evidence of source of funds for material inflows.'],
      };
      const qs = (qMap[flag.category] || qMap['Behavioral Deviation']).join('\n\n');
      const why = `FLAG: ${flag.id} — ${flag.rule}\nREF: ${flag.ruleRef}\nPERIOD: ${periodLabel}\n\nDETECTION RATIONALE:\n${flag.rationale}\n\nSumSub Transaction IDs: ${flag.txnIds.slice(0,8).join(', ')}${flag.txnInternalIds?.filter(Boolean).length ? '\nInternal Transaction IDs: '+flag.txnInternalIds.filter(Boolean).slice(0,8).join(', ') : ''}${sarWarn}`;
      const what = `REQUIRED RESPONSE (within 10 business days):\n\n${qs}\n\nIssued by: Kira Financial AI Compliance | Date: ${new Date().toISOString().slice(0,10)} | Flag: ${flag.id}`;
      return { why, what, full: `KIRA FINANCIAL AI — REQUEST FOR INFORMATION\n${'='.repeat(44)}\nTo: ${applicantName}\nDate: ${new Date().toISOString().slice(0,10)}\n\n${why}\n\n${'─'.repeat(60)}\n\n${what}` };
    }

    // Process applicants in batches of 10
    const results = { mode, periodLabel, reviewStart: reviewStart.toISOString(), reviewEnd: reviewEnd.toISOString(), runTimestamp: new Date().toISOString(), ruleVersion: 'Spec v0.1 + Compendium 30 Rules', totalApplicants: applicants.length, totalTransactionsAnalyzed:0, totalFlags:0, flagsByCategory:{}, flagsBySeverity:{High:0,Medium:0,Low:0}, riskTierDistribution:{1:0,2:0,3:0,4:0,5:0}, sarRiskFlags:0, entityResults:[] };

    const BATCH = 10;
    for (let i=0; i<applicants.length; i+=BATCH) {
      const batch = applicants.slice(i, i+BATCH);
      const batchRes = await Promise.allSettled(batch.map(async app => {
        const aid = app.id || app.applicantId;
        const name = app.externalUserId || aid;
        // Use pre-fetched normalized txns for current period
        const curTxns = applicantTxnMap[aid] || [];
        if (!curTxns.length) return null;
        // Fetch baseline periods
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
        const flagsWithRFI = flags.map(f => ({ ...f, rfi: (f.severity==='High'||f.sarRisk)?makeRFI(f,name):null, recommendedAction:action, status:'Open' }));
        return { applicantId:aid, applicantName:name, riskScore:score, riskTier:tier, riskTierLabel:tierLabel, recommendedAction:action, transactionCount:curTxns.length, totalVolume:cur.totalVolume, flags:flagsWithRFI, flagCount:flagsWithRFI.length, sarRiskCount:flagsWithRFI.filter(f=>f.sarRisk).length };
      }));
      batchRes.forEach(r => { if (r.status==='fulfilled'&&r.value) results.entityResults.push(r.value); });
      if (i+BATCH<applicants.length) await sleep(250);
    }

    results.entityResults.sort((a,b)=>b.riskScore-a.riskScore);
    results.totalTransactionsAnalyzed = results.entityResults.reduce((s,e)=>s+e.transactionCount,0);
    results.totalFlags = results.entityResults.reduce((s,e)=>s+e.flagCount,0);
    results.sarRiskFlags = results.entityResults.reduce((s,e)=>s+e.sarRiskCount,0);
    results.entityResults.forEach(e => {
      results.riskTierDistribution[e.riskTier]=(results.riskTierDistribution[e.riskTier]||0)+1;
      e.flags.forEach(f => { results.flagsByCategory[f.category]=(results.flagsByCategory[f.category]||0)+1; results.flagsBySeverity[f.severity]=(results.flagsBySeverity[f.severity]||0)+1; });
    });
    results.top5 = results.entityResults.slice(0,5).map(e=>({applicantId:e.applicantId,applicantName:e.applicantName,riskScore:e.riskScore,riskTier:e.riskTier,riskTierLabel:e.riskTierLabel,flagCount:e.flagCount,sarRiskCount:e.sarRiskCount}));
    results.runtimeMs = Date.now()-startTime;

    res.json({ success: true, results });
  } catch (err) {
    console.error('Analysis failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export endpoints
app.post('/export/rfi', (req, res) => {
  const { flag, applicantName, periodLabel } = req.body;
  if (!flag?.rfi) return res.status(400).json({ error: 'no RFI on this flag' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="RFI-${flag.id}.txt"`);
  res.send(flag.rfi.full);
});

// ── Frontend — served directly from Render URL ────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Kira AML Bot</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js"></script>
  <style>
    :root{--ink:#0D1117;--ink-mid:#3D4451;--ink-muted:#64748B;--surface:#F7F8FA;--panel:#FFFFFF;--border:#E2E5EA;--accent:#1A56DB;--accent-lo:#EEF3FF;--red:#C0392B;--red-lo:#FDF2F2;--amber:#D97706;--amber-lo:#FFFBEB;--green:#16A34A;--green-lo:#F0FDF4;--purple:#7C3AED;--purple-lo:#F5F3FF;--mono:'SF Mono','Fira Code',monospace;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:var(--surface);color:var(--ink);line-height:1.5;}
    .app{display:flex;height:100vh;overflow:hidden;}
    .sidebar{width:220px;flex-shrink:0;background:var(--ink);display:flex;flex-direction:column;}
    .logo{padding:20px;border-bottom:1px solid rgba(255,255,255,.08);}
    .logo .w{font-size:15px;font-weight:700;color:#fff;}
    .logo .t{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-top:2px;}
    .nav{flex:1;padding:10px 0;}
    .ni{display:flex;align-items:center;gap:10px;padding:9px 20px;cursor:pointer;border-left:3px solid transparent;font-size:13px;color:#94A3B8;transition:all .15s;}
    .ni:hover{background:rgba(255,255,255,.05);color:#fff;}
    .ni.active{border-left-color:var(--accent);background:rgba(26,86,219,.15);color:#fff;}
    .sf{padding:14px 20px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;}
    .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;}
    .dok{background:var(--green);}.derr{background:var(--red);}.didle{background:#475569;}
    .main{flex:1;overflow-y:auto;display:flex;flex-direction:column;}
    .topbar{background:var(--panel);border-bottom:1px solid var(--border);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
    .tt{font-size:16px;font-weight:600;}.ts{font-size:12px;color:var(--ink-muted);}
    .content{padding:24px 28px;flex:1;}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;}
    .bp{background:var(--accent);color:#fff;}.bp:hover{background:#1547C0;}.bp:disabled{background:#93B4F5;cursor:not-allowed;}
    .bg{background:transparent;color:var(--ink-mid);border:1px solid var(--border);}.bg:hover{background:var(--surface);}
    .bsm{padding:5px 10px;font-size:12px;}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;}
    .ct{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-muted);margin-bottom:14px;}
    .kgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-bottom:18px;}
    .kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;}
    .kl{font-size:11px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;}
    .kv{font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1;}
    .ks{font-size:11px;color:var(--ink-muted);margin-top:3px;}
    .cr{color:var(--red);}.ca{color:var(--amber);}.cb{color:var(--accent);}.cp{color:var(--purple);}
    .twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;}
    .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;}
    .br{background:var(--red-lo);color:var(--red);}.ba{background:var(--amber-lo);color:var(--amber);}
    .bb{background:var(--accent-lo);color:var(--accent);}.bg2{background:var(--green-lo);color:var(--green);}
    .bpu{background:var(--purple-lo);color:var(--purple);}.bgr{background:var(--surface);color:var(--ink-muted);}
    table{width:100%;border-collapse:collapse;font-size:13px;}
    th{padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--ink-muted);border-bottom:1px solid var(--border);background:var(--surface);}
    td{padding:10px 12px;border-bottom:1px solid var(--border);}
    tr:hover td{background:var(--surface);}
    .br2{display:flex;align-items:center;gap:10px;margin-bottom:9px;font-size:12px;}
    .bl{width:170px;flex-shrink:0;color:var(--ink-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .bt{flex:1;background:var(--surface);border-radius:3px;height:10px;overflow:hidden;}
    .bf{height:100%;border-radius:3px;transition:width .4s;}
    .bc{width:28px;text-align:right;font-weight:600;}
    .trow{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;}
    .tcell{text-align:center;padding:12px 4px;border-radius:8px;}
    .tcell .tn{font-size:24px;font-weight:700;}.tcell .tl{font-size:10px;margin-top:2px;}
    .t1c{background:var(--green-lo);color:var(--green);}.t2c{background:var(--accent-lo);color:var(--accent);}
    .t3c{background:var(--amber-lo);color:var(--amber);}.t4c{background:#FFF3E0;color:#E65100;}.t5c{background:var(--red-lo);color:var(--red);}
    .fc{background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden;}
    .fh{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;}
    .fh:hover{background:var(--surface);}
    .fid{font-family:var(--mono);font-size:11px;color:var(--ink-muted);flex-shrink:0;}
    .fr{font-weight:600;font-size:13px;flex:1;}
    .fb{border-top:1px solid var(--border);padding:16px;background:#FAFBFC;}
    .dg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
    .dl label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink-muted);margin-bottom:2px;}
    .rat{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:12px;line-height:1.65;color:var(--ink-mid);margin-bottom:12px;}
    .tids{font-family:var(--mono);font-size:11px;background:var(--ink);color:#94A3B8;padding:8px 12px;border-radius:6px;margin-bottom:12px;word-break:break-all;}
    .rfw{border:1px solid var(--border);border-radius:8px;overflow:hidden;}
    .rfh{background:var(--accent-lo);padding:10px 14px;font-size:12px;font-weight:600;color:var(--accent);display:flex;justify-content:space-between;align-items:center;}
    .rfb{padding:14px;font-size:12px;line-height:1.7;white-space:pre-wrap;max-height:260px;overflow-y:auto;background:var(--panel);}
    .sarb{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--red-lo);border:1px solid #FECACA;border-radius:6px;margin-bottom:12px;font-size:12px;font-weight:500;color:var(--red);}
    .filters{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;}
    .sel{padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--panel);color:var(--ink);cursor:pointer;}
    input.sel{min-width:180px;}
    .empty{text-align:center;padding:60px 20px;color:var(--ink-muted);}
    .ei{font-size:38px;margin-bottom:10px;}.eh{font-size:12px;color:#94A3B8;margin-top:6px;}
    .spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block;}
    @keyframes spin{to{transform:rotate(360deg);}}
    .prog{font-size:12px;color:var(--ink-muted);font-style:italic;margin-top:8px;}
    .ebox{background:var(--red-lo);border:1px solid #FECACA;border-radius:8px;padding:12px 16px;color:var(--red);font-size:13px;margin-bottom:14px;}
    .mani{background:var(--ink);color:#CBD5E1;border-radius:8px;padding:14px 16px;font-family:var(--mono);font-size:11px;line-height:1.9;}
    .mk{color:#475569;}.mv{color:#93C5FD;}.mvok{color:#86EFAC;}.mvw{color:#FCA5A5;}
    .sb{display:flex;align-items:center;gap:8px;}
    .st{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;}
    .sf2{height:100%;border-radius:3px;}
    .sf1c{background:var(--green);}.sf2c{background:var(--accent);}.sf3c{background:var(--amber);}.sf4c{background:#E65100;}.sf5c{background:var(--red);}
  </style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect } = React;


const BACKEND = window.location.origin;

function dl(content, filename, mime='text/plain') {
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type:mime}));
  a.download=filename;a.click();
}

function exportSummary(results) {
  const lines=[
    'KIRA FINANCIAL AI — AML ' + results.mode.toUpperCase() + ' REPORT',
    '='.repeat(55),
    'Period: ' + results.periodLabel + '  Run: ' + results.runTimestamp,
    'Rules: ' + results.ruleVersion, '',
    'EXECUTIVE SUMMARY', '-'.repeat(40),
    'Applicants: ' + results.totalApplicants + ' | Transactions: ' + results.totalTransactionsAnalyzed,
    'Flags: ' + results.totalFlags + ' | SAR-Risk: ' + results.sarRiskFlags, '',
    'FLAGS BY CATEGORY', '-'.repeat(40),
    ...Object.entries(results.flagsByCategory).map(([c,n])=>'  '+c+': '+n), '',
    'RISK TIER DISTRIBUTION', '-'.repeat(40),
    ...[1,2,3,4,5].map(t=>'  Tier '+t+': '+(results.riskTierDistribution[t]||0)), '',
    'TOP 5 ENTITIES', '-'.repeat(40),
    ...(results.top5||[]).map((e,i)=>'  '+(i+1)+'. '+e.applicantName+' — Score '+e.riskScore+' | '+e.riskTierLabel+' | '+e.flagCount+' flags | SAR: '+e.sarRiskCount), '',
    'HIGH SEVERITY FLAGS', '-'.repeat(40),
    ...results.entityResults.flatMap(e=>e.flags.filter(f=>f.severity==='High').flatMap(f=>[
      '', e.applicantName+' ('+e.applicantId+')',
      '  '+f.id+' — '+f.rule,
      '  '+f.rationale,
      f.txnIds?.filter(Boolean).length ? '  SumSub IDs: '+f.txnIds.filter(Boolean).slice(0,8).join(', ') : '',
      f.txnInternalIds?.filter(Boolean).length ? '  Internal IDs: '+f.txnInternalIds.filter(Boolean).slice(0,8).join(', ') : '',
      f.sarRisk?'  ⚠ SAR RISK':''
    ]).filter(Boolean))
  ];
  dl(lines.join('\\n'), 'AML-Summary-'+results.periodLabel+'.txt');
}

function exportCSV(results) {
  const hdr=['Flag ID','Period','Applicant ID','Applicant Name','Rule','Category','Severity','Score','Tier','SAR Risk','Action','SumSub Transaction IDs','Internal Transaction IDs','Counterparties','Rationale'];
  const rows=[hdr.join(',')];
  results.entityResults.forEach(e=>e.flags.forEach(f=>rows.push([
    f.id, results.periodLabel,
    e.applicantId,
    '"'+e.applicantName.replace(/"/g,'""')+'"',
    '"'+f.rule.replace(/"/g,'""')+'"',
    '"'+f.category+'"',
    f.severity, e.riskScore, e.riskTier,
    f.sarRisk?'YES':'NO',
    '"'+f.recommendedAction+'"',
    '"'+(f.txnIds||[]).filter(Boolean).join(' | ')+'"',
    '"'+(f.txnInternalIds||[]).filter(Boolean).join(' | ')+'"',
    '"'+(f.counterparties||[]).join(' | ')+'"',
    '"'+f.rationale.replace(/"/g,'""').replace(/\n/g,' ')+'"'
  ].join(','))));
  dl(rows.join('\n'), 'AML-Flags-'+results.periodLabel+'.csv', 'text/csv');
}

const SevBadge=({s})=>s==='High'?<span className="badge br">High</span>:s==='Medium'?<span className="badge ba">Medium</span>:<span className="badge bgr">Low</span>;
const CatBadge=({c})=>c==='Structuring & Layering'?<span className="badge bpu">Structuring</span>:c==='Network & Flow Pattern'?<span className="badge bb">Network</span>:<span className="badge ba">Behavioral</span>;
const scoreCls=s=>s<=25?'sf1c':s<=50?'sf2c':s<=74?'sf3c':s<=89?'sf4c':'sf5c';
const tierCls=t=>['','t1c','t2c','t3c','t4c','t5c'][t]||'t1c';
const tierBadge=t=>['','bg2','bb','ba','br','br'][t]||'bgr';

function FlagCard({flag, applicantName}) {
  const [open,setOpen]=useState(false);
  const [tab,setTab]=useState('why');
  const dlRFI=async()=>{
    try{
      const r=await fetch(BACKEND+'/export/rfi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flag,applicantName,periodLabel:flag._period||''})});
      dl(await r.text(),'RFI-'+flag.id+'.txt');
    }catch(e){alert('Download failed: '+e.message);}
  };
  return (
    <div className="fc">
      <div className="fh" onClick={()=>setOpen(!open)}>
        <span className="fid">{flag.id}</span>
        <SevBadge s={flag.severity}/>
        <CatBadge c={flag.category}/>
        <span className="fr">{flag.rule}</span>
        {flag.sarRisk&&<span className="badge br">⚠ SAR</span>}
        <span style={{color:'var(--ink-muted)',fontSize:16,marginLeft:'auto'}}>{open?'▾':'▸'}</span>
      </div>
      {open&&(
        <div className="fb">
          {flag.sarRisk&&<div className="sarb">⚠ SAR Risk — potential filing obligation under 31 U.S.C. § 5318(g)</div>}
          <div className="dg">
            <div className="dl"><label>Rule Reference</label><span style={{fontSize:12,fontFamily:'var(--mono)',color:'var(--ink-muted)'}}>{flag.ruleRef}</span></div>
            <div className="dl"><label>Action</label><span style={{fontWeight:600}}>{flag.recommendedAction}</span></div>
            <div className="dl"><label>Counterparties</label><span>{flag.counterparties?.join(', ')||'—'}</span></div>
            <div className="dl"><label>Status</label><span className="badge bb">{flag.status}</span></div>
          </div>
          <div className="rat">{flag.rationale}</div>
          {(flag.txnIds?.filter(Boolean).length>0||flag.txnInternalIds?.filter(Boolean).length>0)&&(
            <div className="tids">
              <div style={{color:'#64748B',fontSize:10,textTransform:'uppercase',letterSpacing:'.5px',marginBottom:6}}>Transaction IDs</div>
              {flag.txnIds?.filter(Boolean).slice(0,8).map((sid,i)=>(
                <div key={sid||i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5,flexWrap:'wrap'}}>
                  <span style={{color:'#64748B',fontSize:10,width:70,flexShrink:0}}>SumSub ID</span>
                  <a href={'https://cockpit.sumsub.com/checkus#/kyt/transaction/'+sid}
                     target="_blank" rel="noopener noreferrer"
                     style={{color:'#93C5FD',textDecoration:'underline',fontFamily:'var(--mono)',fontSize:11,flex:1}}>
                    {sid}
                  </a>
                  {flag.txnInternalIds?.[i]&&flag.txnInternalIds[i]&&(
                    <>
                      <span style={{color:'#64748B',fontSize:10,width:60,flexShrink:0}}>Internal ID</span>
                      <span style={{color:'#CBD5E1',fontFamily:'var(--mono)',fontSize:11}}>{flag.txnInternalIds[i]}</span>
                    </>
                  )}
                </div>
              ))}
              {/* Show any internal IDs that don't have a corresponding SumSub ID */}
              {flag.txnInternalIds?.filter(Boolean).slice(flag.txnIds?.filter(Boolean).length||0).map((tid,i)=>(
                <div key={'int-'+i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                  <span style={{color:'#64748B',fontSize:10,width:70,flexShrink:0}}>Internal ID</span>
                  <span style={{color:'#CBD5E1',fontFamily:'var(--mono)',fontSize:11}}>{tid}</span>
                </div>
              ))}
              {flag.txnIds?.filter(Boolean).length>8&&(
                <div style={{color:'#475569',fontSize:11,marginTop:4}}>+ {flag.txnIds.filter(Boolean).length-8} more transactions</div>
              )}
            </div>
          )}
          {flag.rfi&&(
            <div className="rfw">
              <div className="rfh">
                <span>📋 Request for Information</span>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn bg bsm" onClick={()=>setTab(tab==='why'?'what':'why')}>{tab==='why'?'View Questions →':'← Justification'}</button>
                  <button className="btn bp bsm" onClick={dlRFI}>⬇ Download RFI</button>
                </div>
              </div>
              <div className="rfb">{tab==='why'?flag.rfi.why:flag.rfi.what}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Dashboard({results,onRun,loading,msg,error}) {
  const now = new Date();
  const [mode,setMode]=useState('custom');
  const [year,setYear]=useState(now.getUTCFullYear());
  const [selectedMonths,setSelectedMonths]=useState([now.getUTCMonth()===0?12:now.getUTCMonth()]);
  const [selectedYear,setSelectedYear]=useState(now.getUTCMonth()===0?now.getUTCFullYear()-1:now.getUTCFullYear());

  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const years=[];
  for(let y=now.getUTCFullYear();y>=2024;y--) years.push(y);

  const toggleMonth=(m)=>{
    setSelectedMonths(prev=>
      prev.includes(m) ? prev.filter(x=>x!==m) : [...prev,m].sort((a,b)=>a-b)
    );
  };

  const buildRunPayload=()=>{
    if(mode==='monthly') return {mode:'monthly'};
    if(mode==='quarterly') return {mode:'quarterly'};

    if(!selectedMonths.length) return null;
    const sorted=[...selectedMonths].sort((a,b)=>a-b);
    const pad=n=>String(n).padStart(2,'0');
    return {
      mode:'custom',
      customStart:selectedYear+'-'+pad(sorted[0]),
      customEnd:selectedYear+'-'+pad(sorted[sorted.length-1]),
    };
  };

  const handleRun=()=>{
    const payload=buildRunPayload();
    if(!payload) return;
    onRun(payload);
  };

  const CAT_COLORS={'Behavioral Deviation':'#D97706','Structuring & Layering':'#7C3AED','Network & Flow Pattern':'#1A56DB'};
  const maxCat=results?Math.max(...Object.values(results.flagsByCategory),1):1;

  return (
    <div>
      <div className="card">
        <div className="ct">Run Analysis</div>

        {/* Analysis type selector */}
        <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
          {[['custom','Select Months'],['monthly','Prior Month'],['quarterly','Prior Quarter']].map(([v,lbl])=>(
            <button key={v} onClick={()=>setMode(v)}
              className="btn bsm"
              style={{background:mode===v?'var(--accent)':'transparent',color:mode===v?'#fff':'var(--ink-mid)',border:'1px solid',borderColor:mode===v?'var(--accent)':'var(--border)'}}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Custom month picker */}
        {mode==='custom'&&(
          <div style={{marginBottom:14}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
              <span style={{fontSize:12,color:'var(--ink-muted)',fontWeight:500}}>Year</span>
              <select className="sel" value={selectedYear} onChange={e=>setSelectedYear(Number(e.target.value))}>
                {years.map(y=><option key={y} value={y}>{y}</option>)}
              </select>
              <span style={{fontSize:11,color:'var(--ink-muted)'}}>
                {selectedMonths.length===0?'Select months below':
                 selectedMonths.length===1?MONTHS[selectedMonths[0]-1]+' '+selectedYear+' selected':
                 selectedMonths.length+' months selected'}
              </span>
              {selectedMonths.length>0&&(
                <button className="btn bg bsm" onClick={()=>setSelectedMonths([])} style={{marginLeft:'auto',fontSize:11}}>Clear</button>
              )}
            </div>
            {/* Month grid */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:6}}>
              {MONTHS.map((mn,i)=>{
                const m=i+1;
                const sel=selectedMonths.includes(m);
                const isFuture=selectedYear===now.getUTCFullYear()&&m>now.getUTCMonth()+1;
                return (
                  <button key={m} onClick={()=>!isFuture&&toggleMonth(m)} disabled={isFuture}
                    style={{
                      padding:'7px 4px',borderRadius:6,border:'1px solid',fontSize:12,fontWeight:sel?500:400,
                      cursor:isFuture?'not-allowed':'pointer',
                      background:sel?'var(--accent)':'transparent',
                      color:isFuture?'var(--border)':sel?'#fff':'var(--ink-mid)',
                      borderColor:sel?'var(--accent)':'var(--border)',
                      transition:'all .15s',
                    }}>
                    {mn}
                  </button>
                );
              })}
            </div>
            {selectedMonths.length>1&&(
              <div style={{marginTop:8,fontSize:11,color:'var(--ink-muted)'}}>
                ℹ️ Multi-month selection analyses the full range from {MONTHS[selectedMonths[0]-1]} to {MONTHS[selectedMonths[selectedMonths.length-1]-1]} {selectedYear}
              </div>
            )}
          </div>
        )}

        {/* Run button row */}
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <button className="btn bp"
            onClick={handleRun}
            disabled={loading||(mode==='custom'&&selectedMonths.length===0)}>
            {loading?<><span className="spin"/> Analyzing…</>:'▶ Run Analysis'}
          </button>
          {results&&<>
            <button className="btn bg bsm" onClick={()=>exportSummary(results)}>⬇ Summary .txt</button>
            <button className="btn bg bsm" onClick={()=>exportCSV(results)}>⬇ Flags .csv</button>
          </>}
          {mode==='custom'&&selectedMonths.length===0&&<span style={{fontSize:11,color:'var(--amber)'}}>Select at least one month</span>}
        </div>
        {loading&&<p className="prog">{msg}</p>}
        {error&&<div className="ebox" style={{marginTop:10}}>⚠ {error}</div>}
      </div>
      {!results&&!loading&&(<div className="empty"><div className="ei">🔍</div><p>No analysis run yet.</p><p className="eh">Select a period and click Run Analysis.</p></div>)}
      {results&&(<>
        <div className="kgrid">
          <div className="kpi"><div className="kl">Applicants</div><div className="kv cb">{results.totalApplicants.toLocaleString()}</div><div className="ks">{results.periodLabel}</div></div>
          <div className="kpi"><div className="kl">Transactions</div><div className="kv">{results.totalTransactionsAnalyzed.toLocaleString()}</div></div>
          <div className="kpi"><div className="kl">Total Flags</div><div className="kv ca">{results.totalFlags}</div><div className="ks">High: {results.flagsBySeverity?.High||0} · Med: {results.flagsBySeverity?.Medium||0}</div></div>
          <div className="kpi"><div className="kl">SAR-Risk</div><div className="kv cr">{results.sarRiskFlags}</div><div className="ks">§ 5318(g)</div></div>
          <div className="kpi"><div className="kl">Tier 4–5</div><div className="kv cp">{(results.riskTierDistribution?.[4]||0)+(results.riskTierDistribution?.[5]||0)}</div></div>
        </div>
        <div className="twocol">
          <div className="card">
            <div className="ct">Flags by Category</div>
            {Object.entries(results.flagsByCategory).map(([cat,n])=>(
              <div className="br2" key={cat}>
                <span className="bl" title={cat}>{cat}</span>
                <div className="bt"><div className="bf" style={{width:(n/maxCat*100)+'%',background:CAT_COLORS[cat]||'#94A3B8'}}/></div>
                <span className="bc">{n}</span>
              </div>
            ))}
            {!Object.keys(results.flagsByCategory).length&&<p style={{fontSize:12,color:'var(--ink-muted)'}}>No flags.</p>}
          </div>
          <div className="card">
            <div className="ct">Risk Tier Distribution</div>
            <div className="trow">
              {[1,2,3,4,5].map(t=>(
                <div key={t} className={'tcell '+tierCls(t)}>
                  <div className="tn">{results.riskTierDistribution?.[t]||0}</div>
                  <div className="tl">T{t}</div>
                </div>
              ))}
            </div>
            <div style={{marginTop:10,fontSize:11,color:'var(--ink-muted)'}}>T1 None · T2 Monitor · T3 Investigate · T4 SAR · T5 Mandatory</div>
          </div>
        </div>
        <div className="card">
          <div className="ct">Top 5 Highest-Risk Entities</div>
          <table>
            <thead><tr><th>Applicant</th><th>Score</th><th>Tier</th><th>Flags</th><th>SAR</th></tr></thead>
            <tbody>
              {(results.top5||[]).map(e=>(
                <tr key={e.applicantId}>
                  <td><div style={{fontWeight:600}}>{e.applicantName}</div><div style={{fontSize:11,color:'var(--ink-muted)',fontFamily:'var(--mono)'}}>{e.applicantId}</div></td>
                  <td><div className="sb"><div className="st"><div className={'sf2 '+scoreCls(e.riskScore)} style={{width:e.riskScore+'%'}}/></div><span style={{fontWeight:700,minWidth:28}}>{e.riskScore}</span></div></td>
                  <td><span className={'badge '+tierBadge(e.riskTier)}>T{e.riskTier}</span> {e.riskTierLabel}</td>
                  <td style={{fontWeight:600}}>{e.flagCount}</td>
                  <td>{e.sarRiskCount>0?<span className="badge br">⚠ {e.sarRiskCount}</span>:<span className="badge bg2">None</span>}</td>
                </tr>
              ))}
              {!(results.top5||[]).length&&<tr><td colSpan={5} style={{textAlign:'center',color:'var(--ink-muted)',padding:20}}>No flagged entities.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="ct">Run Manifest</div>
          <div className="mani">
            <div><span className="mk">period:       </span><span className="mv">{results.periodLabel}</span></div>
            <div><span className="mk">mode:         </span><span className="mv">{results.mode}</span></div>
            <div><span className="mk">run_timestamp:</span><span className="mv">{results.runTimestamp}</span></div>
            <div><span className="mk">applicants:   </span><span className="mvok">{results.totalApplicants}</span></div>
            <div><span className="mk">transactions: </span><span className="mvok">{results.totalTransactionsAnalyzed}</span></div>
            <div><span className="mk">flags:        </span><span className={results.totalFlags>0?'mvw':'mvok'}>{results.totalFlags}</span></div>
            <div><span className="mk">sar_risk:     </span><span className={results.sarRiskFlags>0?'mvw':'mvok'}>{results.sarRiskFlags}</span></div>
            <div><span className="mk">runtime:      </span><span className="mv">{results.runtimeMs?.toLocaleString()||'—'}ms</span></div>
          </div>
        </div>
      </>)}
    </div>
  );
}

function FlagsTab({results}) {
  const [sev,setSev]=useState('All');
  const [cat,setCat]=useState('All');
  const [sar,setSar]=useState('All');
  const [q,setQ]=useState('');
  if (!results) return <div className="empty"><div className="ei">🚩</div><p>Run an analysis first.</p></div>;
  const all=results.entityResults.flatMap(e=>e.flags.map(f=>({...f,_name:e.applicantName,_score:e.riskScore,_tier:e.riskTier,_period:results.periodLabel})));
  const filtered=all.filter(f=>(sev==='All'||f.severity===sev)&&(cat==='All'||f.category===cat)&&(sar==='All'||f.sarRisk)&&(!q||f.rule.toLowerCase().includes(q.toLowerCase())||f._name.toLowerCase().includes(q.toLowerCase())));
  const cats=[...new Set(all.map(f=>f.category))];
  return (
    <div>
      <div className="filters">
        <input type="text" placeholder="Search…" className="sel" value={q} onChange={e=>setQ(e.target.value)}/>
        <select className="sel" value={sev} onChange={e=>setSev(e.target.value)}><option value="All">All Severities</option><option>High</option><option>Medium</option></select>
        <select className="sel" value={cat} onChange={e=>setCat(e.target.value)}><option value="All">All Categories</option>{cats.map(c=><option key={c}>{c}</option>)}</select>
        <select className="sel" value={sar} onChange={e=>setSar(e.target.value)}><option value="All">All</option><option value="SAR">SAR Risk Only</option></select>
        <span style={{fontSize:12,color:'var(--ink-muted)'}}>{filtered.length}/{all.length}</span>
      </div>
      {!filtered.length&&<div className="empty"><div className="ei">✅</div><p>No flags match filters.</p></div>}
      {filtered.map(f=>(
        <div key={f.id}>
          <div style={{fontSize:11,color:'var(--ink-muted)',marginBottom:3,marginTop:8}}>{f._name} · Score {f._score} · Tier {f._tier}</div>
          <FlagCard flag={f} applicantName={f._name}/>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [tab,setTab]=useState('dashboard');
  const [results,setResults]=useState(null);
  const [loading,setLoading]=useState(false);
  const [msg,setMsg]=useState('');
  const [error,setError]=useState(null);
  const [ok,setOk]=useState(null);

  useEffect(()=>{
    fetch(BACKEND+'/health').then(r=>r.json()).then(d=>setOk(d.ok&&d.credentials==='configured')).catch(()=>setOk(false));
  },[]);

  const MSGS=['Fetching applicants from SumSub…','Building statistical baselines…','Running behavioral deviation rules…','Running structuring detection…','Analyzing network patterns…','Computing risk scores…','Generating RFIs…','Finalizing…'];
  let mi=0;

  const onRun=async(payload)=>{
    setLoading(true);setError(null);setMsg(MSGS[0]);
    const iv=setInterval(()=>{mi=(mi+1)%MSGS.length;setMsg(MSGS[mi]);},4000);
    try{
      const r=await fetch(BACKEND+'/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(!d.success) throw new Error(d.error||'Analysis failed');
      setResults(d.results);setTab('dashboard');
    }catch(e){setError(e.message);}
    finally{clearInterval(iv);setLoading(false);setMsg('');}
  };

  const sarCount=results?.sarRiskFlags||0;

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo"><div className="w">Kira Financial AI</div><div className="t">AML Monitoring Bot</div></div>
        <nav className="nav">
          <div className={'ni '+(tab==='dashboard'?'active':'')} onClick={()=>setTab('dashboard')}>◈ Dashboard</div>
          <div className={'ni '+(tab==='flags'?'active':'')} onClick={()=>setTab('flags')}>
            🚩 Flags {results?.totalFlags>0&&<span className="badge ba" style={{marginLeft:'auto',fontSize:10}}>{results.totalFlags}</span>}
          </div>
        </nav>
        <div className="sf">
          <div style={{color:ok===true?'#86EFAC':ok===false?'#FCA5A5':'#94A3B8'}}>
            <span className={'dot '+(ok===true?'dok':ok===false?'derr':'didle')}/>
            {ok===true?'Ready':ok===false?'Check environment vars':'Connecting…'}
          </div>
          {sarCount>0&&<div style={{marginTop:8,padding:'6px 8px',background:'rgba(192,57,43,.15)',borderRadius:5,color:'#F87171',fontSize:10}}>⚠ {sarCount} SAR-risk flag{sarCount>1?'s':''}</div>}
        </div>
      </div>
      <div className="main">
        <div className="topbar">
          <div>
            <div className="tt">{tab==='dashboard'?'AML Analysis Dashboard':'Flag Review'}</div>
            {results&&<div className="ts">{results.mode} · {results.periodLabel} · {results.runTimestamp?.slice(0,16).replace('T',' ')} UTC</div>}
          </div>
          {sarCount>0&&<span className="badge br">⚠ {sarCount} SAR-Risk</span>}
        </div>
        <div className="content">
          {tab==='dashboard'&&<Dashboard results={results} onRun={onRun} loading={loading} msg={msg} error={error}/>}
          {tab==='flags'&&<FlagsTab results={results}/>}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Kira AML Bot running on port ${PORT}`));
