import {kineticModel,readIsothermReport,KINETIC_MODELS} from "./models.js";
import {parseKineticCSV} from "./parser.js";
import {fitKinetic,kineticCsv} from "./fitting.js";
import {chooseKinetic,forwardValidate} from "./selection.js";
import {kineticIdentifiability,kineticBootstrap,kineticConfidenceCSV,kineticParameterCSV} from "./statistics.js";
import {KINETIC_EXAMPLES,DEMO_ISOTHERM_REPORT,kineticExampleCSV} from "./examples.js";

const $=id=>document.getElementById(id);
const fmt=(v,n=4)=>v==null||!Number.isFinite(v)?"—":Number(v).toPrecision(n);
const ns="http://www.w3.org/2000/svg",selectedIds=new Set(["pfo","pso","avrami","elovich","ldf"]);
let source=null,results=[],current=null,equilibriumModel=null,automatic=null,errors=[],currentExample=null,ciJob=0;
const yieldUI=()=>new Promise(done=>setTimeout(done,0));
const status=(text,bad=false)=>{$("status").textContent=text;$("status").className="status"+(bad?" error":"");};
const modelEnabled=id=>{
 if(["elovich","diffusion"].includes(id)&&$("branch").value==="desorption")return false;
 if(id==="ldf"&&$("eqMode").value==="free")return false;
 return true;
};
function modelPicker(){
 const host=$("models");host.replaceChildren();
 for(const m of KINETIC_MODELS){
   const label=document.createElement("label");label.className=modelEnabled(m.id)?"":"disabled";
   const check=document.createElement("input");check.type="checkbox";check.value=m.id;check.checked=selectedIds.has(m.id);check.disabled=!modelEnabled(m.id);
   check.addEventListener("change",()=>check.checked?selectedIds.add(m.id):selectedIds.delete(m.id));
   const span=document.createElement("span");span.textContent=m.label+(m.kind==="diagnostic"?" · diagnostic only":"");
   label.append(check,span);host.append(label);
 }
}
function updateEqPanel(){
 const mode=$("eqMode").value;
 $("eqFixedBox").classList.toggle("hidden",mode!=="fixed");
 $("eqLinkedBox").classList.toggle("hidden",mode!=="linked");
 modelPicker();clearResults();
}
function clearResults(){
 ciJob++;source=null;results=[];current=null;automatic=null;errors=[];
 for(const id of ["exportCSV","exportCI","exportParamCI","exportJSON"])$(id).disabled=true;
 $("resultTable").replaceChildren();$("chart").replaceChildren();$("residual").replaceChildren();
 $("parameters").replaceChildren();$("identifiability").replaceChildren();$("warnings").replaceChildren();
 $("formula").textContent="";$("chosen").textContent="—";$("confidenceNote").textContent="";
 $("recommendation").textContent="Model recommendation appears here.";
}
function exampleLoad(){
 const ex=KINETIC_EXAMPLES.find(x=>x.id===$("exampleSelect").value);if(!ex)return;
 $("csv").value=kineticExampleCSV(ex);$("branch").value="adsorption";
 $("tUnit").value="min";$("qUnit").value="mmol/g";$("pUnit").value="bar";$("weighted").checked=false;$("fitQ0").checked=false;
 equilibriumModel=ex.linked?readIsothermReport(DEMO_ISOTHERM_REPORT,{pressureUnit:"bar",loadingUnit:"mmol/g"}):null;
 $("eqMode").value=ex.linked?"linked":"free";
 $("forcingInterpolation").value=ex.linked?"hold":"linear";
 $("eqInfo").textContent=equilibriumModel?"Synthetic linked equilibrium: "+equilibriumModel.label:"No imported isotherm yet.";
 $("exampleInfo").textContent=ex.description+" These are generated data, not measured observations.";
 currentExample=ex.id;updateEqPanel();preview();
 status("Loaded "+ex.name+".");
}
function preview(){
 try{
   const r=parseKineticCSV($("csv").value,{branch:$("branch").value});
   $("dataInfo").textContent=r.data.length+" valid time points · "+r.otherBranch+" excluded other-branch rows · "+r.skipped+" invalid rows";
 }catch(e){$("dataInfo").textContent="Data warning: "+e.message;}
}
function inputs(){
 const parsed=parseKineticCSV($("csv").value,{branch:$("branch").value});
 if($("weighted").checked&&parsed.data.some(d=>!(d.sigma>0)))throw Error("Weighted mode requires sigma>0 for each observation.");
 const mode=$("eqMode").value;
 if(mode==="linked"){
   if(!equilibriumModel)throw Error("Import an Isotherm Studio report before linked LDF fitting.");
   if(equilibriumModel.branch&&equilibriumModel.branch!=="all"&&equilibriumModel.branch!==$("branch").value)
     throw Error("Imported isotherm branch ("+equilibriumModel.branch+") differs from the selected kinetic branch ("+$("branch").value+"). Import matching equilibrium data.");
   if(equilibriumModel.sourceUnits.x.toLowerCase()!==$("pUnit").value.trim().toLowerCase()||
     equilibriumModel.sourceUnits.q.toLowerCase()!==$("qUnit").value.trim().toLowerCase())
     throw Error("Pressure/uptake units disagree with imported equilibrium; convert input data first.");
   if(parsed.data.some(d=>!Number.isFinite(d.pressure)))throw Error("Linked LDF needs a pressure column in every row.");
 }
 if(mode==="fixed"&&(!Number.isFinite(Number($("eqValue").value))||Number($("eqValue").value)<0))
   throw Error("Specify a nonnegative fixed q*.");
 source=parsed;
 return parsed.data;
}
function options(data){
 return {eqMode:$("eqMode").value,branch:$("branch").value,q0Fit:$("fitQ0").checked,
   weighted:$("weighted").checked,optimizer:$("optimizer").value,starts:Number($("starts").value),
   seed:Number($("seed").value)||20261023,forcingRows:data,qEquilibrium:Number($("eqValue").value),
   equilibriumModel:$("eqMode").value==="linked"?equilibriumModel:null,
   forcingInterpolation:$("forcingInterpolation").value};
}
function make(tag,attributes={},txt){
 const node=document.createElementNS(ns,tag);
 for(const [k,v] of Object.entries(attributes))node.setAttribute(k,v);
 if(txt!=null)node.textContent=txt;return node;
}
function chart(host,series,{residual=false,xLabel="Time",yLabel="Uptake"}={}){
 const w=720,h=residual?200:320,m={left:58,right:18,top:20,bottom:40};
 const all=series.flatMap(s=>s.points.flatMap(p=>p.length===3?[[p[0],p[1]],[p[0],p[2]]]:[p]))
   .filter(p=>p.every(Number.isFinite));
 if(!all.length){host.textContent="No finite data to plot.";return;}
 const xmin=Math.min(...all.map(p=>p[0])),xmax=Math.max(...all.map(p=>p[0]));
 const yValues=all.map(p=>p[1]);
 let ylo=residual?-Math.max(1e-10,...yValues.map(Math.abs))*1.3:Math.min(0,...yValues);
 let yhi=residual?-ylo:Math.max(...yValues)*1.12;if(yhi<=ylo)yhi=ylo+1;
 const X=x=>m.left+(w-m.left-m.right)*(x-xmin)/Math.max(xmax-xmin,1e-12);
 const Y=y=>m.top+(h-m.top-m.bottom)*(1-(y-ylo)/(yhi-ylo));
 const svg=make("svg",{viewBox:"0 0 "+w+" "+h,role:"img","aria-label":residual?"Kinetic residual chart":"Kinetic adsorption fitting chart",class:"chart"});
 for(let i=0;i<=4;i++){
   const y=ylo+(yhi-ylo)*i/4,t=xmin+(xmax-xmin)*i/4;
   svg.append(make("line",{x1:m.left,x2:w-m.right,y1:Y(y),y2:Y(y),class:"gridline"}));
   svg.append(make("text",{x:m.left-6,y:Y(y)+4,"text-anchor":"end",class:"axis-label"},fmt(y,3)));
   svg.append(make("line",{x1:X(t),x2:X(t),y1:m.top,y2:h-m.bottom,class:"gridline"}));
   svg.append(make("text",{x:X(t),y:h-m.bottom+18,"text-anchor":"middle",class:"axis-label"},fmt(t,3)));
 }
 if(residual)svg.append(make("line",{x1:m.left,x2:w-m.right,y1:Y(0),y2:Y(0),class:"baseline"}));
 for(const s of series){
   const pt=p=>X(p[0]).toFixed(2)+","+Y(p[1]).toFixed(2);
   if(s.kind==="band"){
     const lower=s.points.map(p=>[p[0],p[1]]),upper=s.points.map(p=>[p[0],p[2]]).reverse();
     svg.append(make("polygon",{points:lower.concat(upper).map(pt).join(" "),class:"confidence-band"}));
     for(const arr of [lower,upper])svg.append(make("polyline",{points:arr.map(pt).join(" "),class:"confidence-edge"}));
   }else if(s.kind==="line"||s.kind==="equilibrium"){
     svg.append(make("polyline",{points:s.points.map(pt).join(" "),class:s.kind==="line"?"line":"equilibrium"}));
   }else for(const p of s.points)svg.append(make("circle",{cx:X(p[0]),cy:Y(p[1]),r:3.5,class:residual?"residual-dot":"dot"}));
 }
 svg.append(make("text",{x:w/2,y:h-3,"text-anchor":"middle",class:"axis-label"},xLabel));
 svg.append(make("text",{x:14,y:h/2,"text-anchor":"middle",class:"axis-label",transform:"rotate(-90 14 "+h/2+")"},yLabel));
 host.replaceChildren(svg);
}
function draw(){
 if(!current||!source)return;
 const rows=source.data,times=rows.map(r=>r.time);
 const grid=Array.from({length:161},(_,i)=>times[0]+(times.at(-1)-times[0])*i/160);
 const curve=current.predict(grid);
 const ci=$("showCI").checked?current.confidence:null;
 const series=[...(ci?[{kind:"band",points:ci.grid.map(r=>[r.time,r.lower,r.upper])}]:[]),
   {kind:"line",points:grid.map((t,i)=>[t,curve[i]])}];
 if(current.id==="ldf"&&current.equilibrium?.type==="imported_isotherm"&&equilibriumModel){
   const eqPoints=rows.map(r=>[r.time,equilibriumModel.predict(r.pressure)]);
   if(current.config.forcingInterpolation==="hold"){
     const steps=[eqPoints[0]];
     for(let i=1;i<eqPoints.length;i++){
       steps.push([eqPoints[i][0],eqPoints[i-1][1]],eqPoints[i]);
     }
     series.push({kind:"equilibrium",points:steps});
   }else series.push({kind:"equilibrium",points:eqPoints});
 }
 series.push({kind:"dots",points:rows.map(d=>[d.time,d.y])});
 chart($("chart"),series,{xLabel:"Time ("+$("tUnit").value+")",yLabel:"q ("+$("qUnit").value+")"});
 $("chartNote").textContent="Orange: data · Blue: fitted curve"+
   (current.equilibrium?.type==="imported_isotherm"?" · Dashed gray: q*(P(t))":"")+
   (ci?" · Shaded: pointwise "+Math.round(ci.level*100)+"% mean confidence interval":"")+
   ". Entire graph restricted to observed time. No uncertainty from imported equilibrium fit.";
 chart($("residual"),[{kind:"dots",points:current.observed.map(r=>[r.time,r.residual])}],
   {residual:true,xLabel:"Time ("+$("tUnit").value+")",yLabel:"Residual ("+$("qUnit").value+")"});
}
function parameterTable(){
 const host=$("parameters"),table=document.createElement("table"),thead=document.createElement("tr");
 ["Parameter","Physical estimate",...($("showCI").checked?["Marginal CI"]:[]),"Scaled estimate","Scaled bounds"].forEach(x=>{
   const th=document.createElement("th");th.textContent=x;thead.append(th);
 });
 table.append(thead);
 for(let i=0;i<current.params.length;i++){
   const tr=document.createElement("tr"),param=current.model.params[i],c=$("showCI").checked?current.confidence?.parameters?.[i]:null;
   const fields=[param.name,fmt(current.physicalParameters[i],6),
     ...($("showCI").checked?[c?"["+fmt(c.lower,4)+", "+fmt(c.upper,4)+"]":"Pending"]:[]),
     fmt(current.params[i],6),"["+fmt(param.low,3)+", "+fmt(param.high,3)+"]"];
   for(const value of fields){const td=document.createElement("td");td.textContent=value;tr.append(td);}
   table.append(tr);
 }host.replaceChildren(table);
}
function showDiagnostics(){
 const host=$("identifiability");host.replaceChildren();
 try{
   current.identifiability??=kineticIdentifiability(current,source.data,current.config);
   const d=current.identifiability;
   const title=document.createElement("div");title.className="hint";
   title.textContent="Local Jacobian rank "+d.rank+"/"+d.total+" · condition "+(d.condition===null?"rank deficient":fmt(d.condition,4))+
     " · sensitivity coupling "+d.coupled.length+" pair(s).";host.append(title);
   for(const msg of d.warnings){const p=document.createElement("div");p.className="warn";p.textContent=msg;host.append(p);}
   const caption=document.createElement("div");caption.className="small-note";caption.textContent="Normalized Jacobian sensitivity correlations:";host.append(caption);
   const table=document.createElement("table"),header=document.createElement("tr");
   ["",...current.paramNames].forEach(s=>{const e=document.createElement("th");e.textContent=s;header.append(e);});table.append(header);
   for(let i=0;i<d.total;i++){
     const tr=document.createElement("tr"),th=document.createElement("th");th.textContent=current.paramNames[i];tr.append(th);
     for(let j=0;j<d.total;j++){const e=document.createElement("td");e.textContent=fmt(d.correlations[i][j],3);tr.append(e);}
     table.append(tr);
   }host.append(table);
 }catch(e){const el=document.createElement("div");el.className="warn";el.textContent="Identifiability unavailable: "+e.message;host.append(el);}
}
function tableResults(){
 const body=$("resultTable");body.replaceChildren();
 for(const r of results){
   const tr=document.createElement("tr");if(r===current)tr.className="selected";
   const vals=[r.label,String(r.metrics.k),fmt(r.metrics.rmse),fmt(r.metrics.r2),fmt(r.metrics.aicc),fmt(r.cv?.rmse),r.warnings.length?"Review":"Fitted"];
   vals.forEach(text=>{const td=document.createElement("td");td.textContent=text;tr.append(td);});
   tr.addEventListener("click",()=>select(r));body.append(tr);
 }
}
function select(r){
 current=r;ciJob++;$("chosen").textContent=r.label;$("formula").textContent=r.formula;
 $("metricRMSE").textContent=fmt(r.metrics.rmse);$("metricR2").textContent=fmt(r.metrics.r2);
 for(const name of ["exportCSV","exportJSON"])$(name).disabled=false;
 $("exportCI").disabled=!r.confidence;$("exportParamCI").disabled=!r.confidence;
 tableResults();draw();parameterTable();showDiagnostics();
 const host=$("warnings");host.replaceChildren();
 for(const msg of r.warnings){const div=document.createElement("div");div.className="warn";div.textContent=msg;host.append(div);}
 if($("showCI").checked)void refreshConfidence();else $("confidenceNote").textContent="Confidence intervals off.";
}
async function refreshConfidence(){
 const token=++ciJob,r=current;
 if(!r)return;
 if(!$("showCI").checked){$("exportCI").disabled=true;$("exportParamCI").disabled=true;$("confidenceNote").textContent="Confidence intervals off.";draw();parameterTable();return;}
 const level=Number($("confidenceLevel").value),replicates=Number($("confidenceN").value);
 const key=[level,replicates].join(":");r.ciCache??={};
 if(r.ciCache[key]){r.confidence=r.ciCache[key];$("exportCI").disabled=false;$("exportParamCI").disabled=false;draw();parameterTable();$("confidenceNote").textContent=confidenceCaption(r.confidence);return;}
 r.confidence=null;$("exportCI").disabled=true;$("exportParamCI").disabled=true;draw();parameterTable();
 $("confidenceNote").textContent="Calculating "+replicates+" bootstrap refits for "+r.label+"…";
 try{
   const ci=await kineticBootstrap(r,source.data,r.config,{level,replicates,seed:r.convergence.seed+314159,starts:3,
     shouldAbort:()=>token!==ciJob,yieldTask:yieldUI,
     onProgress:(i,n)=>{if(token===ciJob&&i%4===1)$("confidenceNote").textContent="Bootstrap "+i+"/"+n+" for "+r.label;}});
   if(token!==ciJob)return;
   r.confidence=ci;r.ciCache[key]=ci;$("exportCI").disabled=false;$("exportParamCI").disabled=false;
   draw();parameterTable();$("confidenceNote").textContent=confidenceCaption(ci);
 }catch(e){if(token!==ciJob)return;$("confidenceNote").textContent="Uncertainty unavailable: "+e.message;status("Bootstrap: "+e.message,true);}
}
function confidenceCaption(ci){return Math.round(ci.level*100)+"% pointwise curve / individual coefficient percentile intervals · "+
 ci.successful+"/"+ci.replicates+" successful · "+ci.method+". "+ci.warnings.join(" ");}
async function fit(auto=false){
 if($("fitBtn").disabled)return;
 let data,opts,models;
 try{
   data=inputs();opts=options(data);
   models=KINETIC_MODELS.filter(m=>selectedIds.has(m.id)&&modelEnabled(m.id))
     .map(m=>kineticModel(m.id,opts));
   if(!auto&&!models.length)throw Error("Select at least one eligible kinetic model.");
 }catch(e){status(e.message,true);return;}
 for(const name of ["fitBtn","autoBtn"])$(name).disabled=true;
 ciJob++;results=[];current=null;errors=[];automatic=null;
 try{
   if(auto){
     status("Running time-ordered forward validation…");
     automatic=await chooseKinetic(data,{...opts,
       yieldTask:yieldUI,onProgress:(i,n,name)=>status("Auto comparison "+i+"/"+n+": "+name)});
     errors=automatic.failed;
     results=automatic.scored.map(v=>{v.fit.cv=v.cv;v.fit.config=opts;return v.fit;});
     if(!results.length)throw Error("No candidate model passed forward validation.");
     results.sort((a,b)=>(a.cv?.rmse??Infinity)-(b.cv?.rmse??Infinity));
     $("recommendation").textContent=automatic.winner?"Recommended: "+automatic.winner.fit.label+"; "+
       automatic.criterion:"No reliable winner. "+errors.join(" | ");
     $("rankNote").textContent="Forward time-ordered validation; later samples were not used to fit the current split. Compare an independent experiment before trusting rate transferability.";
   }else{
     for(let i=0;i<models.length;i++){
       status("Fitting "+(i+1)+"/"+models.length+": "+models[i].label);
       await yieldUI();
       try{
         const r=fitKinetic(models[i],data,opts);
         r.config=opts;
         r.cv=models[i].kind==="diagnostic"?null:forwardValidate(models[i],data,opts);
         results.push(r);
       }catch(e){errors.push(models[i].label+": "+e.message);}
     }
     results.sort((a,b)=>(a.metrics.aicc??Infinity)-(b.metrics.aicc??Infinity)||a.metrics.rmse-b.metrics.rmse);
     $("recommendation").textContent="Manual fit ranked by in-sample AICc (where defined), not by physical plausibility. PFO and free-q* LDF are duplicates, so only PFO is used.";
     $("rankNote").textContent="Forward-origin RMSE shown for compatible models; AICc is not reported for known-sigma weighted likelihood without the appropriate likelihood specification.";
   }
   if(!results.length)throw Error("No models converged. "+errors.slice(0,3).join(" | "));
   $("metricN").textContent=data.length;$("metricM").textContent=results.length;
   $("descriptor").textContent=$("branch").value+" · "+$("eqMode").value+" q* · "+$("tUnit").value;
   select(auto&&automatic?.winner?automatic.winner.fit:results[0]);
   status(results.length+" models fitted; "+errors.length+" skipped/failed. Check residuals and identifiability.");
 }catch(e){status(e.message,true);}
 finally{for(const name of ["fitBtn","autoBtn"])$(name).disabled=false;}
}
function download(filename,mime,text){
 const blob=new Blob([text],{type:mime}),url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function report(){
 const r=current;
 return {schema_version:"0.1",tool:"Adsorp Kinetic Studio",generated_at:new Date().toISOString(),
   source_example:currentExample,units:{time:$("tUnit").value,loading:$("qUnit").value,pressure:$("pUnit").value},
   branch:$("branch").value,selected_model:r.id,
   equilibrium:r.equilibrium,forcing_interpolation:r.config.forcingInterpolation,optimizer:r.convergence.algorithm,
   initial:r.initial,confidence:r.confidence??null,identifiability:r.identifiability??null,
   automatic_selection:automatic?{method:automatic.criterion,recommended:automatic.winner?.fit.id||null,excluded:errors}:null,
   runs:results.map(x=>({id:x.id,label:x.label,formula:x.formula,parameters:Object.fromEntries(x.paramNames.map((p,i)=>[p,x.physicalParameters[i]])),
     normalized_parameters:Object.fromEntries(x.paramNames.map((p,i)=>[p,x.params[i]])),
     scale:x.scale,metrics:x.metrics,convergence:x.convergence,warnings:x.warnings,cv:x.cv||null})),
   observed:r.observed,
   interpretation:"Time-series calibrated, model-conditional. Empirical pseudo-order fits do not establish microscopic kinetics."};
}
KINETIC_EXAMPLES.forEach(ex=>{const op=document.createElement("option");op.value=ex.id;op.textContent=ex.name;$("exampleSelect").append(op);});
$("loadExample").addEventListener("click",exampleLoad);
$("csv").addEventListener("input",()=>{currentExample=null;$("exampleInfo").textContent="User-entered data.";clearResults();preview();});
$("dataFile").addEventListener("change",async e=>{
 const file=e.target.files?.[0];if(!file)return;
 try{
   if(file.size>2e6)throw Error("Maximum kinetic CSV size is 2 MB.");
   $("csv").value=await file.text();currentExample=null;$("exampleInfo").textContent="User-uploaded dataset; source and permissions are controlled by the user.";
   clearResults();preview();status("Uploaded "+file.name);
 }catch(error){status(error.message,true);}
 e.target.value="";
});
$("eqFile").addEventListener("change",async e=>{
 const file=e.target.files?.[0];if(!file)return;
 try{
   if(file.size>2e6)throw Error("Maximum isotherm JSON is 2 MB.");
   equilibriumModel=readIsothermReport(await file.text(),{pressureUnit:$("pUnit").value,loadingUnit:$("qUnit").value});
   $("eqInfo").textContent="Loaded "+equilibriumModel.label+" from Isotherm Studio · q* evaluated in "+equilibriumModel.sourceUnits.q+".";
   clearResults();status("Imported "+equilibriumModel.label+".");
 }catch(err){status(err.message,true);}
 e.target.value="";
});
$("eqMode").addEventListener("change",updateEqPanel);
$("forcingInterpolation").addEventListener("change",clearResults);
$("eqValue").addEventListener("change",clearResults);
$("branch").addEventListener("change",()=>{modelPicker();clearResults();preview();});
for(const id of ["optimizer","starts","seed","weighted","fitQ0","pUnit","qUnit","tUnit"])$(id).addEventListener("change",clearResults);
$("showCI").addEventListener("change",refreshConfidence);
$("confidenceLevel").addEventListener("change",refreshConfidence);
$("confidenceN").addEventListener("change",refreshConfidence);
$("fitBtn").addEventListener("click",()=>void fit(false));
$("autoBtn").addEventListener("click",()=>void fit(true));
$("exportCSV").addEventListener("click",()=>current&&download("kinetic_"+current.id+".csv","text/csv",kineticCsv(current)));
$("exportCI").addEventListener("click",()=>{
 if(current?.confidence)download("kinetic_"+current.id+"_confidence.csv","text/csv",
   kineticConfidenceCSV(current.confidence));
});
$("exportParamCI").addEventListener("click",()=>current?.confidence&&download("kinetic_"+current.id+"_parameters_CI.csv","text/csv",kineticParameterCSV(current.confidence)));
$("exportJSON").addEventListener("click",()=>current&&download("kinetic_fit_report.json","application/json",JSON.stringify(report(),null,2)));
modelPicker();$("exampleSelect").value=KINETIC_EXAMPLES[0].id;exampleLoad();
