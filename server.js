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
  const { mode } = req.body;
  if (!['monthly', 'quarterly'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be monthly or quarterly' });
  }

  try {
    const startTime = Date.now();

    // Date windows
    const now = new Date();
    let reviewStart, reviewEnd, periodLabel;
    if (mode === 'monthly') {
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

    const baselineBack = mode === 'monthly' ? 4 : 9;
    const baselineWindows = [];
    for (let i = baselineBack; i >= 1; i--) {
      let s, e;
      if (mode === 'monthly') {
        s = new Date(Date.UTC(reviewStart.getUTCFullYear(), reviewStart.getUTCMonth() - i, 1));
        e = new Date(Date.UTC(reviewStart.getUTCFullYear(), reviewStart.getUTCMonth() - i + 1, 0, 23, 59, 59, 999));
      } else {
        const q = Math.floor(reviewStart.getUTCMonth() / 3);
        const tq = q - i;
        const ay = Math.floor(tq / 4) + reviewStart.getUTCFullYear();
        const aq = ((tq % 4) + 4) % 4;
        s = new Date(Date.UTC(ay, aq * 3, 1));
        e = new Date(Date.UTC(ay, aq * 3 + 3, 0, 23, 59, 59, 999));
      }
      baselineWindows.push({ start: s, end: e });
    }

    // Fetch all applicants
    const applicants = [];
    let offset = 0;
    while (true) {
      const resp = await sumsubRequest('GET', `/resources/applicants?limit=100&offset=${offset}`);
      const items = resp.items || resp.list || [];
      applicants.push(...items);
      if (items.length < 100) break;
      offset += 100;
      await sleep(200);
    }

    async function getTxns(applicantId, from, to) {
      try {
        const f = Math.floor(from.getTime() / 1000);
        const t = Math.floor(to.getTime() / 1000);
        const r = await sumsubRequest('GET', `/resources/kyt/txns?applicantId=${applicantId}&createdAtGt=${f}&createdAtLt=${t}&limit=500`);
        return r.items || r.list || [];
      } catch { return []; }
    }

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
      const push = (rule, ruleRef, cat, sev, rationale, txnIds, counterparties, sarRisk) =>
        flags.push({ id: fid(), applicantId: aid, rule, ruleRef, category: cat, severity: sev, rationale, txnIds: txnIds.slice(0,20), counterparties, sarRisk });

      const out = txns.filter(t => ['outbound','debit','out'].includes((t.direction||t.type||'').toLowerCase()));
      const inb = txns.filter(t => ['inbound','credit','in'].includes((t.direction||t.type||'').toLowerCase()));
      const amt = t => Math.abs(parseFloat(t.amount || t.fiatAmount || 0));
      const ids = arr => arr.map(t => t.id || t.txnId || '');

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
      inb.forEach(inT=>{const inA=amt(inT);const inTime=new Date(inT.createdAt||inT.created_at||0);out.forEach(outT=>{const outA=amt(outT);const hrs=(new Date(outT.createdAt||outT.created_at||0)-inTime)/3600000;if(hrs>=0&&hrs<=48){const net=(inA-outA)/inA;const ip=inT.counterpartyName||inT.senderName||'?';const op=outT.counterpartyName||outT.beneficiaryName||'?';if(net>=0&&net<=0.1&&ip!==op)push('Pass-Through / Transit Payment','Spec §4.3.2 | Rule 3','Network & Flow Pattern','High',`$${inA.toLocaleString('en',{maximumFractionDigits:0})} from "${ip}" → $${outA.toLocaleString('en',{maximumFractionDigits:0})} to "${op}" in ${hrs.toFixed(1)}h at ${(net*100).toFixed(1)}% retention. Conduit entity.`,[inT.id||'',outT.id||''],[ip,op],true);}});});

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
      const why = `FLAG: ${flag.id} — ${flag.rule}\nREF: ${flag.ruleRef}\nPERIOD: ${periodLabel}\n\nDETECTION RATIONALE:\n${flag.rationale}\n\nTx IDs: ${flag.txnIds.slice(0,8).join(', ')}${sarWarn}`;
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
        const name = app.info?.companyInfo?.companyName || `${app.info?.firstName||''} ${app.info?.lastName||''}`.trim() || app.externalUserId || aid;
        const curTxns = await getTxns(aid, reviewStart, reviewEnd);
        if (!curTxns.length) return null;
        const hist = [];
        for (const w of baselineWindows) { hist.push(pSummary(await getTxns(aid, w.start, w.end))); await sleep(30); }
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Kira AML Bot running on port ${PORT}`));
