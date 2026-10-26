import {MODELS,resolveModel,makeHybrid} from "./models.js";
import {fitOne,parseTable,csvExport} from "./fitting.js";
import {EXAMPLES,findExample,exampleCsv} from "./examples.js";
import {autoSelect} from "./auto_select.js";
import {bootstrapConfidence,confidenceCsv,parameterConfidenceCsv} from "./confidence.js";
import {diagnoseIdentifiability} from "./identifiability.js";
import {mountSpreadsheetGrid,mapColumns} from "../shared/spreadsheet-grid/grid.js";
import {readXlsx} from "../shared/spreadsheet-grid/xlsx.js";
import {analyzeRowBranches,buildBranchCSV} from "./branch_data.js";

const $=id=>document.getElementById(id);
const FIT_SEED=20261023;
const picked=new Set(["henry","langmuir","dual_langmuir","freundlich","sips","toth","brouers_sotolongo"]);
const presets=[...picked];
let results=[],current=null,source=null,failed=[],chosenExample=null,automatic=null,ciGeneration=0;
const f=(n,p=4)=>n==null||!Number.isFinite(n)?"—":Number(n).toPrecision(p);
const status=(s,bad=false)=>{$("status").textContent=s;$("status").className="status"+(bad?" error":"");};
const GRID_COLUMNS=[
  {key:"pressure",label:"Pressure / x",aliases:["x","p","concentration","relative_p","p/p0","activity"]},
  {key:"loading",label:"Loading / q",aliases:["q","qe","uptake","capacity","adsorbed"]},
  {key:"sigma",label:"Sigma",aliases:["stddev","uncertainty","std_error"]},
  {key:"branch",label:"Branch",aliases:["direction"]}
];
const grid=mountSpreadsheetGrid($("spreadsheetGrid"),{
  columns:GRID_COLUMNS,
  onChange:({reason})=>{
    if(reason==="setRows"||reason==="paste")inferImportedBranchMode({replace:reason==="setRows"});
    chosenExample=null;clearResults();preview();
  }
});
function applyBranchVisibility(){
  const mixed=$("mixedBranches").checked;
  grid.setColumnVisible("branch",mixed);
  const all=$("branch").querySelector('option[value="all"]');
  all.disabled=!mixed;all.hidden=!mixed;
  if(!mixed&&$("branch").value==="all")$("branch").value="adsorption";
}
function inferImportedBranchMode({replace=false}={}){
  const summary=analyzeRowBranches(grid.getRows());
  if(summary.mixed||replace){
    $("mixedBranches").checked=summary.mixed;
    if(summary.mixed) $("branch").value="adsorption";
  }
  if(!summary.mixed&&summary.labels.length===1)$("branch").value=summary.labels[0];
  applyBranchVisibility();
}
const eligible=m=>!m.relative||$("dataDomain").value==="relative";
function modelPicker(){
  const el=$("modelsList");el.replaceChildren();
  for(const group of new Set(MODELS.map(m=>m.group))){
    const h=document.createElement("div");h.className="group-title";h.textContent=group;el.append(h);
    for(const m of MODELS.filter(m=>m.group===group)){
      const label=document.createElement("label");label.className="option";
      const check=document.createElement("input");check.type="checkbox";check.value=m.id;check.checked=picked.has(m.id);check.disabled=!eligible(m);
      check.addEventListener("change",()=>{check.checked?picked.add(m.id):picked.delete(m.id);$("selectedCount").textContent=picked.size+" selected";});
      const span=document.createElement("span");span.textContent=m.label;
      label.append(check,span);
      if(m.relative){const sm=document.createElement("small");sm.textContent="p/p₀";label.append(sm);}
      el.append(label);
    }
  }
  $("selectedCount").textContent=picked.size+" selected";
}
function hybridPicker(){
  const choices=MODELS.filter(m=>!m.relative&&!["dual_langmuir","triple_langmuir"].includes(m.id));
  for(let i=1;i<=3;i++)for(const model of choices){
    const opt=document.createElement("option");opt.value=model.id;opt.textContent=model.label;$("hybrid"+i).append(opt);
  }
  $("hybrid1").value="langmuir";$("hybrid2").value="henry";$("hybrid3").value="";
}
function data(){
  if(!grid.getRows().length)throw Error("Enter or import data in the table.");
  const csv=buildBranchCSV(grid.getRows(),{
    selectedBranch:$("branch").value,mixed:$("mixedBranches").checked
  });
  const src=parseTable(csv,$("branch").value);
  if($("dataDomain").value==="relative"&&src.data.some(d=>d.x>1))throw Error("Relative pressure requires 0 ≤ p/p₀ ≤ 1.");
  return src;
}
function preview(){
  try{
    const v=data(),host=$("dataInfo");host.className="data-chips";host.replaceChildren();
    for(const label of [v.data.length+" valid points",v.otherBranch+" other-branch rows excluded",v.skipped+" invalid rows excluded"]){
      if(label.startsWith("0 "))continue;
      const span=document.createElement("span");span.textContent=label;host.append(span);
    }
  }catch(e){$("dataInfo").className="micro";$("dataInfo").textContent=e.message;}
}
function loadExample(){
  const ex=findExample($("exampleSelect").value);
  if(!ex)return;
  grid.setDelimited(exampleCsv(ex));
  chosenExample=ex;
  $("dataDomain").value=ex.domain;$("branch").value=ex.recommended_branch;
  $("xUnit").value=ex.xUnit;$("qUnit").value=ex.qUnit;
  modelPicker();preview();clearResults();
  status("Example loaded.");
}
function clearResults(){
 ciGeneration++;
 results=[];current=null;automatic=null;
 $("ciNote").textContent="";
 $("paramCINote").textContent="";
 $("identifiabilitySummary").replaceChildren();$("identifiabilityCorrelations").replaceChildren();
 $("ciDiagnostics").textContent="";
 $("plot").replaceChildren();
 $("recommendation").textContent="";
 $("rankNote").textContent="";
 $("downloadCSV").disabled=true;$("downloadJSON").disabled=true;$("downloadCI").disabled=true;$("downloadParamCI").disabled=true;
}
const ns="http://www.w3.org/2000/svg";
function plot(target,series,options={}){
  const W=720,H=options.residual?220:340,m={l:60,r:24,t:20,b:43},iw=W-m.l-m.r,ih=H-m.t-m.b;
  const all=series.flatMap(s=>s.points).filter(p=>p.every(Number.isFinite));
  if(!all.length)return;
  const xs=all.map(v=>v[0]),ys=all.flatMap(v=>v.length===3?[v[1],v[2]]:[v[1]]);
  const xmin=options.xmin??Math.min(0,...xs),xmax=options.xmax??Math.max(...xs);
  let ymin=options.residual?-Math.max(1e-8,...ys.map(Math.abs))*1.2:Math.min(0,...ys);
  let ymax=options.residual?-ymin:Math.max(1e-8,...ys)*1.15;
  if(ymax<=ymin){ymax=ymin+1;}
  const xp=x=>m.l+iw*(x-xmin)/Math.max(1e-12,xmax-xmin);
  const yp=y=>m.t+ih*(1-(y-ymin)/(ymax-ymin));
  const svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 "+W+" "+H);
  svg.classList.add("chart");svg.setAttribute("role","img");svg.setAttribute("aria-label",options.residual?"Residual chart":"Fitted isotherm chart");
  function add(type,attrs,txt){
    const e=document.createElementNS(ns,type);
    for(const key in attrs)e.setAttribute(key,attrs[key]);
    if(txt!==undefined)e.textContent=txt;svg.append(e);
  }
  for(let i=0;i<=4;i++){
    const y=ymin+(ymax-ymin)*i/4,py=yp(y),x=xmin+(xmax-xmin)*i/4,px=xp(x);
    add("line",{x1:m.l,x2:W-m.r,y1:py,y2:py,class:"gridline"});
    add("text",{x:m.l-8,y:py+4,"text-anchor":"end",class:"axis-label"},f(y,3));
    add("line",{x1:px,x2:px,y1:m.t,y2:H-m.b,class:"gridline"});
    add("text",{x:px,y:H-m.b+20,"text-anchor":"middle",class:"axis-label"},f(x,3));
  }
  if(options.residual)add("line",{x1:m.l,x2:W-m.r,y1:yp(0),y2:yp(0),class:"baseline"});
  const confidenceOutlines=[];
  for(const group of series){
    if(group.kind==="band"){
      const lower=group.points.map(a=>xp(a[0]).toFixed(2)+","+yp(a[1]).toFixed(2));
      const upper=group.points.map(a=>xp(a[0]).toFixed(2)+","+yp(a[2]).toFixed(2));
      add("polygon",{points:lower.concat(upper.slice().reverse()).join(" "),class:"confidence-band"});
      confidenceOutlines.push(lower,upper);
    }else if(group.kind==="line")add("polyline",{points:group.points.map(a=>xp(a[0]).toFixed(2)+","+yp(a[1]).toFixed(2)).join(" "),class:"line"});
    else for(const a of group.points)add("circle",{cx:xp(a[0]),cy:yp(a[1]),r:4,class:options.residual?"residual-dot":"dot"});
  }
  // Draw true upper/lower bounds above the fitted mean line so narrow
  // confidence intervals remain visible. Never artificially widen CI values.
  for(const points of confidenceOutlines)
    add("polyline",{points:points.join(" "),class:"confidence-edge"});
  add("text",{x:W/2,y:H-4,"text-anchor":"middle",class:"axis-label"},options.xLabel||"x");
  add("text",{x:14,y:H/2,"text-anchor":"middle",class:"axis-label",transform:"rotate(-90 14 "+(H/2)+")"},options.yLabel||"q");
  target.replaceChildren(svg);
}
function drawFit(){
  const xs=source.data.map(d=>d.x),xmin=Math.min(...xs),xmax=Math.max(...xs);
  const curve=[];
  for(let i=0;i<=180;i++){
    const x=xmin+(xmax-xmin)*i/180,y=current.predict(x);
    if(Number.isFinite(y))curve.push([x,y]);
  }
  const ci=$("enableCI").checked?current.confidenceInterval:null;
  const series=[...(ci?[{kind:"band",points:ci.grid.map(d=>[d.x,d.lower,d.upper])}]:[]),
    {kind:"line",points:curve},{kind:"dots",points:source.data.map(d=>[d.x,d.y])}];
  plot($("plot"),series,{
    xmin:Math.min(0,xmin),xmax,
    xLabel:$("dataDomain").value==="relative"?"p/p₀":"x ("+$("xUnit").value+")",
    yLabel:"q ("+$("qUnit").value+")"
  });
  $("plotNote").textContent=ci?Math.round(ci.level*100)+"% CI: shaded region between dashed bounds (fitted mean).":"";
}

/**
 * Run uncertainty only for the selected fitted model; changing a selection or
 * any CI option invalidates earlier jobs. A cache avoids duplicate re-fits.
 */
async function updateConfidence(){
  const request=++ciGeneration;
  const fit=current;
  if(!fit){
    $("ciNote").textContent=$("enableCI").checked||$("enableParamCI").checked?"Fit a model before calculating confidence intervals.":"";
    return;
  }
  if(!$("enableCI").checked&&!$("enableParamCI").checked){
    $("downloadCI").disabled=true;$("downloadParamCI").disabled=true;
    drawFit();refreshParameterTable(fit);refreshParamCINote(fit);
    $("ciNote").textContent="";
    $("ciDiagnostics").textContent="";
    return;
  }
  const level=Number($("ciLevel").value),replicates=Number($("ciReplicates").value);
  const optimizer=fit.convergence.algorithm==="legacy_lm"?"lm":"lbfgs";
  const seed=fit.convergence.seed+47519;
  const key=[level,replicates,optimizer,fit.metrics.weighted,seed].join(":");
  fit.confidenceCache??={};
  if(fit.confidenceCache[key]){
    fit.confidenceInterval=fit.confidenceCache[key];
    $("downloadCI").disabled=false;$("downloadParamCI").disabled=!$("enableParamCI").checked;
    drawFit();refreshParameterTable(fit);refreshParamCINote(fit);
    $("ciNote").textContent="";
    $("ciDiagnostics").textContent=ciDescription(fit.confidenceInterval);
    return;
  }
  fit.confidenceInterval=null;
  $("ciDiagnostics").textContent="";
  $("downloadCI").disabled=true;$("downloadParamCI").disabled=true;
  drawFit();refreshParameterTable(fit);refreshParamCINote(fit);
  $("ciNote").textContent="Calculating "+Math.round(level*100)+"% confidence interval: 0 / "+replicates;
  if($("enableParamCI").checked)$("paramCINote").textContent="Computing coefficient bootstrap intervals…";
  try{
    const interval=await bootstrapConfidence(fit,source.data,{
      level,replicates,optimizer,seed,weighted:fit.metrics.weighted,
      starts:Math.min(4,fit.convergence.starts),
      onProgress:(i,n)=>{if(request===ciGeneration&&i%4===1)$("ciNote").textContent="Calculating "+Math.round(level*100)+"% confidence interval: "+i+" / "+n+" refits.";},
      yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0)),
      shouldAbort:()=>request!==ciGeneration
    });
    if(request!==ciGeneration)return;
    fit.confidenceInterval=interval;
    fit.confidenceCache[key]=interval;
    $("downloadCI").disabled=false;$("downloadParamCI").disabled=!$("enableParamCI").checked;
    drawFit();refreshParameterTable(fit);refreshParamCINote(fit);
    $("ciNote").textContent="";
    $("ciDiagnostics").textContent=ciDescription(interval);
  }catch(e){
    if(request!==ciGeneration)return;
    fit.confidenceInterval=null;
    $("downloadCI").disabled=true;$("downloadParamCI").disabled=true;
    drawFit();refreshParameterTable(fit);refreshParamCINote(fit);
    $("ciNote").textContent="Confidence interval unavailable: "+e.message;
  }
}
function ciDescription(ci){
  const method=ci.weighted?"Gaussian bootstrap using provided sigma":"centered residual bootstrap";
  return Math.round(ci.level*100)+"% pointwise fitted-mean confidence interval · "+ci.successful+"/"+ci.requested+" successful · "+method+". "+
    (ci.warnings.length?"Cautions: "+ci.warnings.join(" "):"")+
    " Not an individual-observation prediction interval or simultaneous band.";
}


function refreshParameterTable(r){
  if(!r)return;
  const model=r.modelComponents?makeHybrid(r.modelComponents):resolveModel(r.id);
  const host=$("paramTable"),tab=document.createElement("table"),head=document.createElement("thead"),
    hrow=document.createElement("tr"),body=document.createElement("tbody");
  const showCI=$("enableParamCI").checked;
  ["Parameter","Physical coefficient",...(showCI?["Pointwise parameter CI"]:[]),"Scaled value","Bounds (scaled)"].forEach(t=>{
    const th=document.createElement("th");th.textContent=t;hrow.append(th);
  });head.append(hrow);
  for(let i=0;i<r.params.length;i++){
    const tr=document.createElement("tr"),ci=showCI?r.confidenceInterval?.parameters?.[i]:null;
    const label=(ci?.name||r.paramNames[i]);
    const bounds="["+f(model.params[i].low,3)+", "+f(model.params[i].high,3)+"]";
    const vals=[label,f(r.physicalParameters[i],7),
      ...(showCI?[ci?"["+f(ci.lower,5)+", "+f(ci.upper,5)+"]":"Pending / unavailable"]:[]),
      f(r.params[i],7),bounds];
    vals.forEach(t=>{const td=document.createElement("td");td.textContent=t;tr.append(td);});
    body.append(tr);
  }
  tab.append(head,body);host.replaceChildren(tab);
}
function refreshParamCINote(r){
  if(!$("enableParamCI").checked){
    $("paramCINote").textContent="";
    return;
  }
  const ci=r?.confidenceInterval;
  if(!ci?.parameters?.length){
    $("paramCINote").textContent="Calculating parameter intervals…";
    return;
  }
  $("paramCINote").textContent=Math.round(ci.level*100)+"% parameter intervals available.";
}
function renderIdentifiability(r){
  const host=$("identifiabilitySummary"),corr=$("identifiabilityCorrelations");
  host.replaceChildren();corr.replaceChildren();
  try{
    r.identifiability??=diagnoseIdentifiability(r,source.data);
    const d=r.identifiability,headline=document.createElement("div");
    headline.className="hint";headline.textContent="Local practical identifiability · Jacobian rank "+
      d.rank+"/"+d.k+" · normalized condition "+
      (Number.isFinite(d.conditionNumber)?f(d.conditionNumber,4):"rank deficient / ∞")+
      " · "+(d.rank===d.k&&d.conditionNumber<1e6?"locally distinguishable at this dataset":"potentially weak/non-identifiable")+
      ". Not a proof of structural identifiability.";
    host.append(headline);
    for(const warning of d.warnings){
      const p=document.createElement("div");p.className="warn";p.textContent=warning;host.append(p);
    }
    const correlation=d.parameterCorrelation||d.sensitivityCorrelation;
    const label=document.createElement("div");label.className="small-note padded-top";
    label.textContent=d.parameterCorrelation?
      "Approximate physical-parameter correlation (local inverse curvature + delta method, not bootstrap correlation):":
      "Normalized Jacobian sensitivity correlation (covariance unavailable due to rank/bounds/conditioning):";
    corr.append(label);
    const table=document.createElement("table"),row=document.createElement("tr");
    ["",...r.paramNames].forEach(x=>{const th=document.createElement("th");th.textContent=x;row.append(th);});
    table.append(row);
    for(let i=0;i<d.k;i++){
      const rr=document.createElement("tr"),th=document.createElement("th");th.textContent=r.paramNames[i];rr.append(th);
      for(let j=0;j<d.k;j++){const td=document.createElement("td");td.textContent=f(correlation[i][j],3);rr.append(td);}
      table.append(rr);
    }
    corr.append(table);
  }catch(e){
    const p=document.createElement("div");p.className="warn";p.textContent="Identifiability diagnosis unavailable: "+e.message;host.append(p);
  }
}

function tableView(){
  const body=$("resultsTable");body.replaceChildren();
  for(const r of results){
    const tr=document.createElement("tr");if(r===current)tr.classList.add("selected");
    const texts=[r.label,String(r.metrics.k),f(r.metrics.rmse),f(r.metrics.r2),f(r.metrics.aicc,5),f(r.cv?.rmse),r.warnings.length?"Review":"Fitted"];
    texts.forEach((t,i)=>{
      const cell=document.createElement("td");if(i>=1&&i<=5)cell.classList.add("num");
      if(i===0){const x=document.createElement("span");x.className="ellipsis";x.textContent=t;x.title=t;cell.append(x);}
      else if(i===6){const pill=document.createElement("span");pill.className="pill"+(r.warnings.length?" warn-pill":"");pill.textContent=t;cell.append(pill);}
      else cell.textContent=t;
      tr.append(cell);
    });
    tr.addEventListener("click",()=>select(r));body.append(tr);
  }
}
function select(r){
  current=r;$("downloadCI").disabled=true;$("downloadParamCI").disabled=true;drawFit();tableView();
  $("selectedLabel").textContent=r.label;
  const model=r.modelComponents?makeHybrid(r.modelComponents):resolveModel(r.id);
  $("formula").classList.remove("hidden");$("formula").textContent=model.formula;
  $("normalization").textContent="Physical parameters are expressed in the displayed x/q units. Optimizer scaling: X = x / "+f(r.scale.xScale,6)+
    ", Y = q / "+f(r.scale.yScale,6)+". Physical and scaled parameters are shown separately; both are included in the export.";
  refreshParameterTable(r);
  renderIdentifiability(r);
  plot($("residualPlot"),[{kind:"dots",points:r.observed.map(d=>[d.x,d.residual])}],{
    residual:true,xmin:Math.min(0,...r.observed.map(d=>d.x)),xmax:Math.max(...r.observed.map(d=>d.x)),
    xLabel:"x ("+($("dataDomain").value==="relative"?"p/p₀":$("xUnit").value)+")",
    yLabel:"Residual ("+$("qUnit").value+")"
  });
  const warns=$("warnings");warns.replaceChildren();
  for(const message of r.warnings){const e=document.createElement("div");e.className="warn";e.textContent=message;warns.append(e);}
  $("metricRMSE").textContent=f(r.metrics.rmse);$("metricR2").textContent=f(r.metrics.r2);
  $("downloadJSON").disabled=false;$("downloadCSV").disabled=false;
  void updateConfidence();
}
async function fit(){
  if($("fitBtn").disabled||$("autoBtn").disabled)return;
  let models;
  try{
    source=data();models=MODELS.filter(m=>picked.has(m.id)&&eligible(m));
    if($("enableHybrid").checked)models.push(makeHybrid([$("hybrid1").value,$("hybrid2").value,$("hybrid3").value].filter(Boolean)));
    if(!models.length)throw Error("Select at least one model.");
    if($("weighted").checked&&source.data.some(d=>!(d.sigma>0)))throw Error("Weighted mode requires a positive sigma column on all selected rows.");
  }catch(e){status(e.message,true);return;}
  $("fitBtn").disabled=true;$("autoBtn").disabled=true;ciGeneration++;results=[];failed=[];current=null;automatic=null;$("recommendation").textContent="";
  try{
    const options={optimizer:$("optimizer").value,starts:+$("starts").value,seed:FIT_SEED,weighted:$("weighted").checked};
    for(let i=0;i<models.length;i++){
      const model=models[i];status("Fitting "+(i+1)+" / "+models.length+" — "+model.label);
      await new Promise(resolve=>setTimeout(resolve,0));
      try{results.push(fitOne(model,source.data,options));}
      catch(e){failed.push(model.label+": "+e.message);}
    }
    results.sort((a,b)=>a.metrics.aicc!=null&&b.metrics.aicc!=null?
      a.metrics.aicc-b.metrics.aicc:a.metrics.rmse-b.metrics.rmse);
    if(!results.length)throw Error("No model fit succeeded. "+failed.slice(0,3).join(" | "));
    $("metricN").textContent=source.data.length;
    $("metricModels").textContent=results.length;
    $("fitDescriptor").textContent=$("branch").value+" · "+$("dataDomain").selectedOptions[0].text;
    $("rankNote").textContent=$("weighted").checked?
      "Weighted fit: AICc/BIC omitted; models ranked descriptively by unweighted RMSE.":
      "Ranked by AICc where defined (otherwise RMSE). This is in-sample ranking, not predictive validation.";
    select(results[0]);
    status(results.length+" models fitted"+(failed.length?" · "+failed.length+" failed/skipped: "+failed.slice(0,2).join(" | "):"")+".");
  }catch(e){status(e.message,true);}
  finally{$("fitBtn").disabled=false;$("autoBtn").disabled=false;}
}

async function autoFit(){
  if($("fitBtn").disabled||$("autoBtn").disabled)return;
  try{
    source=data();
    if($("weighted").checked&&source.data.some(d=>!(d.sigma>0)))throw Error("Weighted automatic selection requires sigma>0 for every observation.");
    $("autoBtn").disabled=true;$("fitBtn").disabled=true;ciGeneration++;results=[];failed=[];current=null;
    $("downloadJSON").disabled=true;$("downloadCSV").disabled=true;
    const opts={relative:$("dataDomain").value==="relative",weighted:$("weighted").checked,
      starts:+$("starts").value,seed:FIT_SEED,hybrids:true,optimizer:$("optimizer").value,
      onProgress:(i,n,label)=>status("Automatic model comparison "+i+"/"+n+": "+label),
      yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0))};
    automatic=await autoSelect(source.data,opts);
    failed=automatic.failures;
    results=automatic.scored.map(s=>{
      const f=s.fit;f.cv=s.cv;f.autoWarnings=s.verification.physicalWarnings;
      if(f.autoWarnings.length)f.warnings.push(...f.autoWarnings);
      return f;
    });
    if(!results.length)throw Error("No eligible models fitted successfully.");
    const winner=automatic.choice?.winner.fit||null;
    results.sort((a,b)=>(a.cv?.rmse??Infinity)-(b.cv?.rmse??Infinity)||a.metrics.k-b.metrics.k);
    $("metricN").textContent=String(source.data.length);$("metricModels").textContent=String(results.length);
    $("fitDescriptor").textContent=$("branch").value+" · "+$("dataDomain").selectedOptions[0].text+" · automatic selection";
    if(winner){
      const range=Math.max(...source.data.map(d=>d.y))-Math.min(...source.data.map(d=>d.y));
      const normalizedError=range>0?winner.cv.rmse/range:Infinity;
      const fitWarning=normalizedError>.05?" CAUTION: CV error exceeds 5% of measured q range; none of the available formulas should yet be considered adequate without further checks.":"";
      $("recommendation").textContent="Recommended among tested models: "+winner.label+" (CV RMSE "+f(winner.cv?.rmse)+
        "; "+f(100*normalizedError,3)+"% of observed uptake range). "+automatic.criterion+"."+fitWarning+" CV tests interpolation within a single campaign, not independent experimental validation.";
      select(winner);
    }else{
      $("recommendation").textContent="No reliable cross-validated winner. Check points/constraints, or use manually inspected AICc and residuals.";
      select(results[0]);
    }
    $("rankNote").textContent="Table sorted by 4-fold pressure-interleaved CV RMSE. This does not test extrapolation or an independent experimental campaign.";
    status(results.length+" candidates evaluated. "+failed.length+" excluded/failed. Review residuals, parameter bounds and model applicability.");
  }catch(e){status(e.message,true);$("recommendation").textContent="Automatic selection could not complete: "+e.message;}
  finally{$("autoBtn").disabled=false;$("fitBtn").disabled=false;}
}

function exportFile(name,mime,body){
  const blob=new Blob([body],{type:mime}),url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
EXAMPLES.forEach(ex=>{const opt=document.createElement("option");opt.value=ex.id;opt.textContent=ex.name+" · "+(ex.kind==="measured"?"measured":"synthetic");$("exampleSelect").append(opt);});
$("exampleBtn").addEventListener("click",loadExample);
$("fileInput").addEventListener("change",async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{
    if(/\.xlsx$/i.test(file.name)){
      if(file.size>4e6)throw Error("Maximum Excel file size is 4 MB.");
      const matrix=await readXlsx(await file.arrayBuffer(),{maxRows:2000,maxColumns:16});
      grid.setRows(mapColumns(matrix,GRID_COLUMNS));
    }else if(/\.(csv|tsv|txt)$/i.test(file.name)){
      if(file.size>2e6)throw Error("Maximum text file size is 2 MB.");
      grid.setDelimited(await file.text());
    }else throw Error("Choose a .xlsx, .csv or .tsv file (.xls is not supported).");
    chosenExample=null;preview();status("Imported "+file.name);
  }catch(error){status("Could not import file: "+error.message,true);}
  e.target.value="";
});
$("branch").addEventListener("change",()=>{clearResults();preview();});
$("mixedBranches").addEventListener("change",()=>{
  if($("mixedBranches").checked){
    const fallback=$("branch").value;
    const rows=grid.getRows().map(row=>{
      const copy=row.slice();
      if(!String(copy[3]??"").trim()&&(String(copy[0]??"").trim()||String(copy[1]??"").trim()))copy[3]=fallback;
      return copy;
    });
    grid.setRows(rows,{notifyChange:false});
  }
  applyBranchVisibility();clearResults();preview();
});
$("dataDomain").addEventListener("change",()=>{
  for(const m of MODELS)if(m.relative&&!eligible(m))picked.delete(m.id);
  modelPicker();clearResults();preview();$("xUnit").value=$("dataDomain").value==="relative"?"p/p₀":"bar";
});
$("coreModelsBtn").addEventListener("click",()=>{picked.clear();presets.forEach(x=>picked.add(x));modelPicker();});
$("allModelsBtn").addEventListener("click",()=>{MODELS.filter(eligible).forEach(m=>picked.add(m.id));modelPicker();});
$("clearModelsBtn").addEventListener("click",()=>{picked.clear();modelPicker();});
$("enableHybrid").addEventListener("change",()=>$("hybridPicker").classList.toggle("hidden",!$("enableHybrid").checked));
$("fitBtn").addEventListener("click",fit);
function requestConfidence(){
  const enabled=$("enableCI").checked||$("enableParamCI").checked;
  $("ciControls").classList.toggle("hidden",!enabled);
  // A checkbox requesting uncertainty is an actionable fit request, even
  // when the user has only loaded data without pressing a fitting button.
  if(enabled&&!current&&!$("fitBtn").disabled&&!$("autoBtn").disabled){
    $("ciNote").textContent="Fitting selected models before calculating confidence intervals…";
    void fit(); // select() will launch the bootstrap for the chosen model.
    return;
  }
  void updateConfidence();
}
$("enableCI").addEventListener("change",requestConfidence);
$("enableParamCI").addEventListener("change",requestConfidence);
$("ciLevel").addEventListener("change",()=>{if($("enableCI").checked||$("enableParamCI").checked)void updateConfidence();});
$("ciReplicates").addEventListener("change",()=>{if($("enableCI").checked||$("enableParamCI").checked)void updateConfidence();});
$("autoBtn").addEventListener("click",autoFit);
$("downloadCSV").addEventListener("click",()=>{
  if(current)exportFile("isotherm_"+current.id.replace(/\W/g,"_")+".csv","text/csv",csvExport(current));
});
$("downloadParamCI").addEventListener("click",()=>{
  if(current?.confidenceInterval?.parameters?.length&&$("enableParamCI").checked)
    exportFile("isotherm_"+current.id.replace(/\W/g,"_")+"_parameter_CI.csv","text/csv",
      parameterConfidenceCsv(current.confidenceInterval));
});
$("downloadCI").addEventListener("click",()=>{
  if(current?.confidenceInterval&&$("enableCI").checked)
    exportFile("isotherm_"+current.id.replace(/\W/g,"_")+"_confidence.csv","text/csv",confidenceCsv(current.confidenceInterval));
});
$("downloadJSON").addEventListener("click",()=>{
  if(!current)return;
  const payload={
    schema_version:"0.1",tool:"Adsorp Supporting Tool",created_at:new Date().toISOString(),
    domain:$("dataDomain").value,branch:$("branch").value,
    temperature_K:$("fitTemperature").value.trim()?Number($("fitTemperature").value):null,optimizer:$("optimizer").value,
    units:{x:$("xUnit").value,q:$("qUnit").value},data_columns:source.columns,
    comment:"params uses normalized X=x/xScale and Y=q/yScale; physical_params uses the supplied x/q units. Input units are NOT auto-converted.",
    selected_model:current.id,selected_components:current.modelComponents,
    example_provenance:chosenExample?{id:chosenExample.id,source:chosenExample.source,source_url:chosenExample.source_url||null,doi:chosenExample.doi||null,data_note:chosenExample.data_note}:null,
    automatic_selection:automatic?{method:automatic.criterion,recommended_model:automatic.choice?.winner.fit.id||null,candidates:automatic.totalCandidates,failures:automatic.failures,cv_rmse_over_observed_loading_range:automatic.choice?.winner?.cv?.rmse / (Math.max(...source.data.map(d=>d.y))-Math.min(...source.data.map(d=>d.y))),quality_screen_warning_threshold:0.05}:null,
    runs:results.map(r=>({
      id:r.id,label:r.label,components:r.modelComponents,
      params:Object.fromEntries(r.paramNames.map((n,i)=>[n,r.params[i]])),
      physical_params:Object.fromEntries(r.paramNames.map((n,i)=>[n,r.physicalParameters[i]])),
      xScale:r.scale.xScale,yScale:r.scale.yScale,metrics:r.metrics,
      convergence:r.convergence,warnings:r.warnings,cv_rmse:r.cv?.rmse??null,cv_folds:r.cv?.folds??0
    })),
    selected_observations:current.observed,failed_models:failed,
    selected_confidence_interval:($("enableCI").checked||$("enableParamCI").checked)?current.confidenceInterval||null:null,
    selected_identifiability:current.identifiability||null,
    confidence_interval_settings:{enabled:$("enableCI").checked,parameter_intervals_enabled:$("enableParamCI").checked,level:Number($("ciLevel").value),bootstrap_repetitions:Number($("ciReplicates").value)}
  };
  exportFile("isotherm_fitting_report.json","application/json",JSON.stringify(payload,null,2));
});
modelPicker();hybridPicker();applyBranchVisibility();$("exampleSelect").value=EXAMPLES[0].id;
status("Upload a CSV or paste data to begin.");
