import express from "express";
import cors from "cors";
import crypto from "crypto";

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const TOKEN  = process.env.SUMSUB_TOKEN;
const SECRET = process.env.SUMSUB_SECRET;
const BASE   = "https://api.sumsub.com";

function sumsubHeaders(method, url, body = "") {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(ts + method.toUpperCase() + url + body)
    .digest("hex");
  return {
    "X-App-Token":      TOKEN,
    "X-App-Access-Sig": sig,
    "X-App-Access-Ts":  ts,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
  };
}

async function sumsubGet(path) {
  const headers = sumsubHeaders("GET", path);
  const res = await fetch(BASE + path, { headers });
  if (!res.ok) throw new Error("SumSub " + path + " " + res.status + ": " + await res.text());
  return res.json();
}

function periodBounds(period) {
  const now = new Date();
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const label = start.getFullYear() + "-" + String(start.getMonth()+1).padStart(2,"0");
    return { start, end, label, periodType: "monthly" };
  }
  const curQ  = Math.floor(now.getMonth() / 3);
  const prevQ = curQ === 0 ? 3 : curQ - 1;
  const year  = curQ === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const start = new Date(year, prevQ * 3, 1);
  const end   = new Date(year, prevQ * 3 + 3, 0, 23, 59, 59, 999);
  return { start, end, label: year + "Q" + (prevQ+1), periodType: "quarterly" };
}

async function fetchAllApplicants() {
  const all = []; let offset = 0;
  while (true) {
    let data;
    try { data = await sumsubGet("/resources/applicants?limit=100&offset=" + offset); } catch { break; }
    const items = data.items || data.list?.items || [];
    all.push(...items);
    if (items.length < 100) break;
    offset += 100;
  }
  return all;
}

async function fetchApplicantTxns(id, fromTs, toTs) {
  const all = []; let offset = 0;
  while (true) {
    let data;
    try { data = await sumsubGet("/resources/applicants/" + id + "/kyt/txns?limit=100&offset=" + offset + "&dateFrom=" + fromTs + "&dateTo=" + toTs); } catch { break; }
    const items = data.items || data.list?.items || [];
    all.push(...items);
    if (items.length < 100) break;
    offset += 100;
  }
  return all;
}

function normaliseTxn(raw, appId, appName) {
  const info = raw.info || raw.data?.info || {};
  const cp   = raw.counterparty || raw.data?.counterparty || {};
  return {
    txn_id: raw.id || raw.externalId || "",
    applicant_id: appId, applicant: appName,
    direction: (info.direction || "").toLowerCase(),
    amount: parseFloat(info.amount || info.value || 0) || 0,
    currency: info.currencyCode || info.currency || "USD",
    date: raw.createdAt || raw.txnDate || raw.data?.txnDate || "",
    counterparty: cp.fullName || cp.name || "Unknown",
    cp_id: cp.id || cp.externalId || "",
    review: raw.review?.reviewResult?.reviewAnswer || "",
    invoice_url: raw.paymentDetails?.invoiceUrl || "",
    note: raw.note || "",
    txn_type: info.type || "",
  };
}

const fmt = n => n>=1e6 ? "$"+(n/1e6).toFixed(2)+"M" : n>=1e3 ? "$"+(n/1e3).toFixed(1)+"K" : "$"+(+n||0).toFixed(0);
const toMonth = d => { const dt=new Date(d); if(isNaN(dt))return null; return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0"); };
const wkOfMo = d => Math.ceil(new Date(d).getDate()/7);
const daysDiff = (a,b) => Math.abs(new Date(b)-new Date(a))/86400000;

function buildBaselines(hist) {
  const byApp = {};
  hist.forEach(r => {
    const k=r.applicant_id||r.applicant, m=toMonth(r.date);
    if(!m)return;
    if(!byApp[k])byApp[k]={periods:{},cps:new Set()};
    if(!byApp[k].periods[m])byApp[k].periods[m]={count:0,vol:0,sizes:[]};
    byApp[k].periods[m].count++;
    byApp[k].periods[m].vol+=r.amount;
    byApp[k].periods[m].sizes.push(r.amount);
    byApp[k].cps.add(r.counterparty);
  });
  const mean=arr=>arr.reduce((s,v)=>s+v,0)/arr.length;
  const std=arr=>{const m=mean(arr);return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length);};
  const result={};
  Object.entries(byApp).forEach(([id,d])=>{
    const ps=Object.values(d.periods);if(!ps.length)return;
    const counts=ps.map(p=>p.count),vols=ps.map(p=>p.vol),sizes=ps.flatMap(p=>p.sizes);
    result[id]={mean_count:mean(counts),std_count:ps.length>1?std(counts):0,mean_vol:mean(vols),std_vol:ps.length>1?std(vols):0,mean_avg_size:sizes.length?mean(sizes):0,periods:ps.length,known_counterparties:[...d.cps]};
  });
  return result;
}

function runRuleEngine(rows, periodType, periodLabel, baselines) {
  const flags=[]; let seq=1;
  const mkFlag=(appId,appName,rule,category,severity,rationale,amount,txnIds,counterparties,meta)=>({
    id:"AML-"+periodLabel.replace(/[-Q]/g,"")+"-"+String(seq++).padStart(4,"0"),
    period:periodLabel,period_type:periodType,applicant_id:appId,applicant:appName,
    rule,category,severity,rationale,total_amount:Math.round(amount*100)/100,
    txn_ids:txnIds||[],counterparties:counterparties||[],status:"Open",
    triggered_at:new Date().toISOString(),meta:meta||{}
  });
  const byApp={};
  rows.forEach(r=>{const k=r.applicant_id||r.applicant;if(!byApp[k])byApp[k]={rows:[],id:r.applicant_id,name:r.applicant};byApp[k].rows.push(r);});
  Object.values(byApp).forEach(({rows:grp,id:appId,name:appName})=>{
    const b=baselines[appId]||null,hasB=b&&b.periods>=2&&(b.std_count>0||b.std_vol>0);
    const totalVol=grp.reduce((s,r)=>s+r.amount,0),txnCount=grp.length,avgSize=txnCount?totalVol/txnCount:0;
    const outRows=grp.filter(r=>r.direction==="out"),inRows=grp.filter(r=>r.direction==="in");
    const totalOut=outRows.reduce((s,r)=>s+r.amount,0),totalIn=inRows.reduce((s,r)=>s+r.amount,0);
    if(hasB&&b.std_count>0){const z=(txnCount-b.mean_count)/b.std_count;if(z>2.0)flags.push(mkFlag(appId,appName,"Volume Spike — Transaction Count","Behavioral Deviation","High","Transaction count "+txnCount+" is "+z.toFixed(2)+"σ above historical mean (μ="+b.mean_count.toFixed(1)+", σ="+b.std_count.toFixed(1)+"). Trailing "+b.periods+"-period average exceeded by "+Math.round((txnCount/b.mean_count-1)*100)+"%.",totalVol,grp.map(r=>r.txn_id),[],{z:z.toFixed(2),mean:b.mean_count,std:b.std_count,txnCount}));}
    else if(!hasB&&txnCount>10)flags.push(mkFlag(appId,appName,"Volume Spike — Absolute Threshold (New Entity)","Behavioral Deviation","Medium",txnCount+" transactions this period. Insufficient baseline ("+( b?.periods||0)+" prior periods). Absolute threshold >10.",totalVol,grp.map(r=>r.txn_id),[],{txnCount,periods:b?.periods||0}));
    if(hasB&&b.std_vol>0){const z=(totalVol-b.mean_vol)/b.std_vol;if(z>2.0)flags.push(mkFlag(appId,appName,"Amount Spike — Total Volume","Behavioral Deviation","High","Total volume "+fmt(totalVol)+" is "+z.toFixed(2)+"σ above historical mean (μ="+fmt(b.mean_vol)+", σ="+fmt(b.std_vol)+").",totalVol,grp.map(r=>r.txn_id),[],{z:z.toFixed(2),mean:b.mean_vol,std:b.std_vol}));}
    else if(!hasB&&totalVol>50000)flags.push(mkFlag(appId,appName,"Amount Spike — Absolute Threshold (New Entity)","Behavioral Deviation","Medium","Total volume "+fmt(totalVol)+" exceeds $50K absolute threshold.",totalVol,grp.map(r=>r.txn_id),[],{totalVol}));
    const wkC={};grp.forEach(r=>{const w=wkOfMo(r.date);wkC[w]=(wkC[w]||0)+1;});
    const weeks=Object.keys(wkC).map(Number).sort();
    for(let i=0;i<weeks.length-1;i++){const w1=wkC[weeks[i]],w2=wkC[weeks[i+1]];if(w1>0&&w2>=2*w1){flags.push(mkFlag(appId,appName,"Velocity Escalation — Weekly Cadence Doubles","Behavioral Deviation","Medium","Transaction frequency doubled: week "+weeks[i]+"→"+weeks[i+1]+": "+w1+"→"+w2+" transactions.",totalVol,grp.map(r=>r.txn_id),[],{w1,w2}));break;}}
    if(b&&b.mean_avg_size>0&&avgSize>1.5*b.mean_avg_size)flags.push(mkFlag(appId,appName,"Transaction Size Threshold Jump","Behavioral Deviation","Medium","Average size "+fmt(avgSize)+" is "+((avgSize/b.mean_avg_size-1)*100).toFixed(0)+"% above prior-period average ("+fmt(b.mean_avg_size)+"). Exceeds 150% threshold.",totalVol,grp.map(r=>r.txn_id),[],{avgSize,priorAvg:b.mean_avg_size}));
    if(outRows.length>=3&&totalOut>0){const cpV={};outRows.forEach(r=>{cpV[r.counterparty]=(cpV[r.counterparty]||0)+r.amount;});const top=Object.entries(cpV).sort((a,b)=>b[1]-a[1])[0];if(top&&top[1]/totalOut>0.70)flags.push(mkFlag(appId,appName,"Concentration Risk — Single Beneficiary","Behavioral Deviation","Medium",((top[1]/totalOut)*100).toFixed(0)+"% of outbound ("+fmt(top[1])+" of "+fmt(totalOut)+") to '"+top[0]+"'. >70% concentration.",top[1],outRows.filter(r=>r.counterparty===top[0]).map(r=>r.txn_id),[top[0]],{pct:((top[1]/totalOut)*100).toFixed(0),beneficiary:top[0]}));}
    if(txnCount>=4){const rc=grp.filter(r=>r.amount>0&&r.amount%1000===0).length;if(rc/txnCount>0.40)flags.push(mkFlag(appId,appName,"Round-Dollar Clustering","Behavioral Deviation","Medium",rc+" of "+txnCount+" transactions ("+((rc/txnCount)*100).toFixed(0)+"%) are exact round-dollar amounts.",totalVol,grp.filter(r=>r.amount>0&&r.amount%1000===0).map(r=>r.txn_id),[],{roundCount:rc,txnCount}));}
    if(periodType==="quarterly"&&totalIn>50000&&totalOut>50000){const nr=Math.abs(totalIn-totalOut)/Math.max(totalIn,totalOut);if(nr<0.10)flags.push(mkFlag(appId,appName,"Quarterly Net Flow Near-Zero — Transit Account","Network Pattern","High","Quarterly inflow "+fmt(totalIn)+" vs outflow "+fmt(totalOut)+". Net deviation "+(nr*100).toFixed(1)+"% (<10%). Persistent conduit indicator.",totalIn+totalOut,grp.map(r=>r.txn_id),[],{inflow:totalIn,outflow:totalOut,netRatio:(nr*100).toFixed(1)}));}
    if(b&&b.periods>=2&&b.mean_count<3&&txnCount>5&&totalVol>25000)flags.push(mkFlag(appId,appName,"Dormancy-to-Activity Transition","Behavioral Deviation","High","Previously low-activity (avg "+b.mean_count.toFixed(1)+" txns/period) now "+txnCount+" transactions totalling "+fmt(totalVol)+".",totalVol,grp.map(r=>r.txn_id),[],{priorAvg:b.mean_count,txnCount,totalVol}));
    if(periodType==="quarterly"){const mV={};grp.forEach(r=>{const m=toMonth(r.date);if(m)mV[m]=(mV[m]||0)+r.amount;});const entries=Object.entries(mV);if(entries.length>=2&&totalVol>0){const[maxM,maxV]=entries.sort((a,b)=>b[1]-a[1])[0];if(maxV/totalVol>0.60)flags.push(mkFlag(appId,appName,"Temporal Concentration — Single Month Dominance","Behavioral Deviation","Medium",((maxV/totalVol)*100).toFixed(0)+"% of quarterly volume ("+fmt(maxV)+") concentrated in "+maxM+". >60% in single month.",maxV,grp.filter(r=>toMonth(r.date)===maxM).map(r=>r.txn_id),[],{month:maxM,pct:((maxV/totalVol)*100).toFixed(0)}));}}
  });
  Object.values(byApp).forEach(({rows:grp,id:appId,name:appName})=>{
    const sorted=[...grp].sort((a,b)=>new Date(a.date)-new Date(b.date));
    const sub=sorted.filter(r=>r.amount>=8000&&r.amount<10000);
    if(sub.length>=2){const clusters=[];let cl=[sub[0]];for(let i=1;i<sub.length;i++){if(daysDiff(cl[0].date,sub[i].date)<=3)cl.push(sub[i]);else{if(cl.length>=2)clusters.push([...cl]);cl=[sub[i]];}}if(cl.length>=2)clusters.push(cl);if(clusters.length>0){const big=clusters.sort((a,b)=>b.length-a.length)[0];const ct=big.reduce((s,r)=>s+r.amount,0);flags.push(mkFlag(appId,appName,"Structuring — Just-Below-Threshold Clustering","Structuring","High",big.length+" transactions in $8K-$9,999 band within 72h, totalling "+fmt(ct)+". 31 U.S.C. § 5324.",ct,big.map(r=>r.txn_id),[...new Set(big.map(r=>r.counterparty))],{clusterSize:big.length,total:ct}));}}
    const amounts=grp.map(r=>r.amount).filter(a=>a>1000);
    if(amounts.length>=3){const mean=amounts.reduce((s,a)=>s+a,0)/amounts.length;if(amounts.every(a=>Math.abs(a-mean)/mean<0.05)&&mean>1000){const total=amounts.reduce((s,a)=>s+a,0);flags.push(mkFlag(appId,appName,"Structuring — Frequency & Uniformity Pattern","Structuring","High",amounts.length+" transactions near-identical (avg "+fmt(mean)+", variance <5%). Aggregate "+fmt(total)+".",total,grp.filter(r=>Math.abs(r.amount-mean)/mean<0.05).map(r=>r.txn_id),[],{count:amounts.length,mean,total}));}}
    const outR=grp.filter(r=>r.direction==="out");const cpG={};outR.forEach(r=>{(cpG[r.counterparty]=cpG[r.counterparty]||[]).push(r);});
    Object.entries(cpG).forEach(([cp,cr])=>{if(cr.length>=2){const t=cr.reduce((s,r)=>s+r.amount,0);if((t%10000<500||t%10000>9500)&&t>8000)flags.push(mkFlag(appId,appName,"Structuring — Split Payments to Same Beneficiary","Structuring","High",cr.length+" payments to '"+cp+"' sum to "+fmt(t)+" — threshold-adjacent total.",t,cr.map(r=>r.txn_id),[cp],{payments:cr.length,total:t,beneficiary:cp}));}});
  });
  const appFlows={};
  rows.forEach(r=>{if(!appFlows[r.applicant])appFlows[r.applicant]={out:{},in:{}};const dir=r.direction==="out"?"out":"in";if(!appFlows[r.applicant][dir][r.counterparty])appFlows[r.applicant][dir][r.counterparty]=[];appFlows[r.applicant][dir][r.counterparty].push(r);});
  const checked=new Set();
  Object.entries(appFlows).forEach(([appA,fA])=>{Object.entries(fA.out||{}).forEach(([cp,outTxns])=>{const pk=[appA,cp].sort().join("|");if(checked.has(pk))return;checked.add(pk);const rf=appFlows[cp]?.out?.[appA];if(rf&&rf.length>0){const ot=outTxns.reduce((s,r)=>s+r.amount,0),it=rf.reduce((s,r)=>s+r.amount,0),ratio=Math.abs(ot-it)/Math.max(ot,it);if(ratio<=0.20&&ot>0&&it>0){const allT=[...outTxns,...rf].sort((a,b)=>new Date(a.date)-new Date(b.date));const within7=allT.length>=2&&daysDiff(allT[0].date,allT[allT.length-1].date)<=7;const appId=rows.find(r=>r.applicant===appA)?.applicant_id||"";flags.push(mkFlag(appId,appA+" ↔ "+cp,"Reciprocal Payment Pattern","Network Pattern","High",appA+" sent "+fmt(ot)+" to '"+cp+"'; '"+cp+"' sent "+fmt(it)+" back. Within "+(ratio*100).toFixed(0)+"%."+( within7?" Within 7 days.":""),ot+it,[...outTxns,...rf].map(r=>r.txn_id),[appA,cp],{ratio:(ratio*100).toFixed(0),within7}));}}});});
  const byApp2={};rows.forEach(r=>{const k=r.applicant_id||r.applicant;if(!byApp2[k])byApp2[k]={rows:[],id:r.applicant_id,name:r.applicant};byApp2[k].rows.push(r);});
  Object.values(byApp2).forEach(({rows:grp,id:appId,name:appName})=>{
    const inf=grp.filter(r=>r.direction==="in").sort((a,b)=>new Date(a.date)-new Date(b.date));
    const outf=grp.filter(r=>r.direction==="out").sort((a,b)=>new Date(a.date)-new Date(b.date));
    if(!inf.length||!outf.length)return;
    const matched=[];inf.forEach(iR=>{outf.forEach(oR=>{const dt=(new Date(oR.date)-new Date(iR.date))/3600000;if(dt>=0&&dt<=48){const ratio=Math.abs(iR.amount-oR.amount)/Math.max(iR.amount,oR.amount);if(ratio<=0.10&&iR.amount>1000)matched.push({iR,oR,dt:dt.toFixed(1)});}});});
    if(matched.length>=1){const tp=matched.reduce((s,m)=>s+m.iR.amount,0);flags.push(mkFlag(appId,appName,"Pass-Through / Transit Payment","Network Pattern","High",matched.length+" inbound→outbound pair(s) forwarded within 48h at ≤10% net difference."+(matched.length>=2?" Repeated.":"")+" Received "+fmt(matched[0].iR.amount)+" from '"+matched[0].iR.counterparty+"', paid "+fmt(matched[0].oR.amount)+" to '"+matched[0].oR.counterparty+"' "+matched[0].dt+"h later.",tp,matched.flatMap(m=>[m.iR.txn_id,m.oR.txn_id]),[...new Set(matched.flatMap(m=>[m.iR.counterparty,m.oR.counterparty]))],{pairs:matched.length}));}
  });
  const edges=[];rows.filter(r=>r.direction==="out").forEach(r=>edges.push({from:r.applicant,to:r.counterparty,amount:r.amount,txn_id:r.txn_id}));
  const eMap={};edges.forEach(e=>{(eMap[e.from]=eMap[e.from]||{})[e.to]=(eMap[e.from][e.to]||0)+e.amount;});
  const cc=new Set();[...new Set([...edges.map(e=>e.from),...edges.map(e=>e.to)])].forEach(a=>{Object.keys(eMap[a]||{}).forEach(b=>{const k=[a,b].sort().join("|");if(cc.has(k))return;cc.add(k);if(eMap[b]?.[a]){const atb=eMap[a][b],bta=eMap[b][a],ratio=Math.abs(atb-bta)/Math.max(atb,bta);if(ratio<=0.15){const appId=rows.find(r=>r.applicant===a)?.applicant_id||"";flags.push(mkFlag(appId,a+" ↔ "+b,"Circular / Closed-Loop Payment","Network Pattern","High","Funds cycle between '"+a+"' and '"+b+"': "+fmt(atb)+" → "+fmt(bta)+" ("+(ratio*100).toFixed(0)+"% diff). No net economic transfer.",atb+bta,edges.filter(e=>(e.from===a&&e.to===b)||(e.from===b&&e.to===a)).map(e=>e.txn_id),[a,b],{aToB:atb,bToA:bta}));}}});});
  const benA={};rows.filter(r=>r.direction==="out").forEach(r=>{if(!benA[r.counterparty])benA[r.counterparty]={apps:new Set(),rows:[]};benA[r.counterparty].apps.add(r.applicant);benA[r.counterparty].rows.push(r);});
  Object.entries(benA).forEach(([bene,{apps,rows:br}])=>{if(apps.size>=3){const t=br.reduce((s,r)=>s+r.amount,0);flags.push(mkFlag("MULTI",apps.size+" applicants → "+bene,"Shared Beneficiary — Multiple Unrelated Applicants","Network Pattern","High",apps.size+" unrelated applicants route to common beneficiary '"+bene+"'. Total: "+fmt(t)+". Funnel account pattern.",t,br.map(r=>r.txn_id),[bene],{appCount:apps.size,beneficiary:bene}));}});
  const seen=new Map();const so={High:0,Medium:1,Low:2};
  flags.forEach(f=>{const k=(f.applicant_id||f.applicant)+"|"+f.rule+"|"+f.period;if(!seen.has(k)||so[seen.get(k).severity]>so[f.severity])seen.set(k,f);});
  return[...seen.values()].sort((a,b)=>(so[a.severity]||2)-(so[b.severity]||2)||b.total_amount-a.total_amount);
}

function scoreEntity(ef){
  let s=0;ef.forEach(f=>{s+=f.severity==="High"?20:f.severity==="Medium"?8:2;if(f.category==="Structuring")s+=5;if(f.category==="Network Pattern")s+=3;});s=Math.min(s,100);
  if(s>=90)return{score:s,tier:5,label:"Mandatory SAR + Relationship Review",action:"File SAR; risk committee review; consider account exit"};
  if(s>=75)return{score:s,tier:4,label:"SAR Consideration",action:"Formal SAR filing assessment; 30-day investigation window"};
  if(s>=51)return{score:s,tier:3,label:"Investigator Escalation",action:"Assign to AML investigator; obtain customer explanation"};
  if(s>=26)return{score:s,tier:2,label:"Enhanced Monitoring",action:"Increase review frequency; update KYC if >6 months old"};
  return{score:s,tier:1,label:"No Action",action:"Document and close"};
}

app.get("/api/analyze", async(req,res)=>{
  if(!TOKEN||!SECRET)return res.status(500).json({error:"SUMSUB_TOKEN and SUMSUB_SECRET env vars not set."});
  const period=req.query.period||"month";
  if(!["month","quarter"].includes(period))return res.status(400).json({error:"period must be month or quarter"});
  try{
    const{start,end,label,periodType}=periodBounds(period);
    const histStart=new Date(start);histStart.setMonth(histStart.getMonth()-(period==="quarter"?9:4));
    const fromTs=Math.floor(histStart.getTime()/1000),toTs=Math.floor(end.getTime()/1000);
    const applicants=await fetchAllApplicants();
    const allTxnRows=[];
    for(let i=0;i<applicants.length;i+=10){
      const batch=applicants.slice(i,i+10);
      const results=await Promise.allSettled(batch.map(async app=>{
        const name=app.info?.companyInfo?.companyName||[app.info?.firstName,app.info?.lastName].filter(Boolean).join(" ")||app.id;
        const txns=await fetchApplicantTxns(app.id,fromTs,toTs);
        return txns.map(t=>normaliseTxn(t,app.id,name));
      }));
      results.forEach(r=>{if(r.status==="fulfilled")allTxnRows.push(...r.value);});
    }
    const histTxns=allTxnRows.filter(r=>new Date(r.date)<start);
    const currentTxns=allTxnRows.filter(r=>{const d=new Date(r.date);return d>=start&&d<=end;}).filter(r=>r.amount>0);
    const baselines=buildBaselines(histTxns);
    const flags=runRuleEngine(currentTxns,periodType,label,baselines);
    const byEntity={};flags.forEach(f=>{const k=f.applicant_id||f.applicant;if(!byEntity[k])byEntity[k]=[];byEntity[k].push(f);});
    const riskTiers={};Object.entries(byEntity).forEach(([k,ef])=>{riskTiers[k]=scoreEntity(ef);});
    const flagsOut=flags.map(f=>({...f,risk_tier:riskTiers[f.applicant_id||f.applicant]||{score:0,tier:1,label:"No Action",action:"Document and close"}}));
    res.json({period,label,period_type:periodType,date_range:{start:start.toISOString(),end:end.toISOString()},total_txns_analyzed:currentTxns.length,total_applicants:applicants.length,total_vol:currentTxns.reduce((s,r)=>s+r.amount,0),flags:flagsOut,summary:{total_flags:flagsOut.length,high:flagsOut.filter(f=>f.severity==="High").length,medium:flagsOut.filter(f=>f.severity==="Medium").length,rfi_required:flagsOut.filter(f=>f.risk_tier?.tier>=3).length,sar_consideration:flagsOut.filter(f=>f.risk_tier?.tier>=4).length,by_category:flags.reduce((m,f)=>{m[f.category]=(m[f.category]||0)+1;return m;},{})},run_manifest:{run_at:new Date().toISOString(),rule_version:"Kira AML Spec v0.1 + Master Compendium June 2026",period_covered:start.toDateString()+" - "+end.toDateString(),baseline_months_used:period==="quarter"?9:4}});
  }catch(err){console.error(err);res.status(500).json({error:err.message});}
});

app.get("/health",(_, res)=>res.json({status:"ok",time:new Date().toISOString()}));
app.listen(PORT,()=>console.log("Kira AML backend on port "+PORT));
