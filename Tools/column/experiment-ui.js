import {parseBreakthroughCSV,analyzeBreakthrough,compareBreakthrough} from './breakthrough.js';
const $=id=>document.getElementById(id);
let measured=null,lastResult=null,lastAnalysis=null,lastComparison=null,lastFit=null,fitWorker=null;
const message=(text,error=false)=>{$('experimentStatus').textContent=text;$('experimentStatus').className='status'+(error?' error':'');};
const fmt=x=>x===null||x===undefined?'Not reached':Number(x).toPrecision(5);
function currentSettings(){
 const n=id=>Number($(id).value),R=n('radius'),L=n('length'),eps=n('porosity'),rho=n('density');
 $('expFlow').value=(Math.PI*R*R*n('velocity')).toPrecision(8);
 $('expMass').value=(Math.PI*R*R*L*(1-eps)*rho).toPrecision(8);
 message('Values estimated from the column settings. Replace with independently measured flow and dry adsorbent mass when available.');
}
function drawChart(){
 const root=$('experimentChart');root.replaceChildren();if(!measured)return;
 const simulated=lastResult?.samples?.filter(s=>Number.isFinite(s.outletFraction))||[];
 const fitted=lastFit?.fittedModel?.samples?.filter(s=>Number.isFinite(s.outletFraction))||[];
 const all=[...measured,...simulated.map(s=>({time:s.time,ratio:s.outletFraction})),...fitted.map(s=>({time:s.time,ratio:s.outletFraction}))];
 const tmax=Math.max(1,...all.map(p=>p.time)),ymax=Math.max(1,...all.map(p=>p.ratio))*1.08;
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 760 330');svg.setAttribute('role','img');
 svg.setAttribute('aria-label','Measured and simulated outlet concentration ratio versus time');
 svg.classList.add('column-breakthrough');
 const NS='http://www.w3.org/2000/svg',newEl=(name,attrs,text)=>{const node=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;return node;};
 const X=t=>66+650*t/tmax,Y=y=>20+255*(1-y/ymax);
 for(let i=0;i<=4;i++){
  svg.append(newEl('line',{x1:66,x2:716,y1:Y(i*ymax/4),y2:Y(i*ymax/4),stroke:'#d8e1e8'}));
  svg.append(newEl('text',{x:58,y:Y(i*ymax/4)+4,'text-anchor':'end',class:'axis'},(i*ymax/4).toFixed(2)));
  svg.append(newEl('text',{x:X(i*tmax/4),y:299,'text-anchor':'middle',class:'axis'},(i*tmax/4).toPrecision(3)));
 }
 const line=(data,color,dash)=>{
  if(!data.length)return;
  const p=newEl('polyline',{points:data.map(s=>X(s.time)+','+Y(s.ratio)).join(' '),fill:'none',stroke:color,'stroke-width':2.6});
  if(dash)p.setAttribute('stroke-dasharray','7 5');svg.append(p);
 };
 line(simulated.map(s=>({time:s.time,ratio:s.outletFraction})),'#b45309',true);
 line(fitted.map(s=>({time:s.time,ratio:s.outletFraction})),'#1f7a48',true);
 line(measured,'#17627a',false);
 const kept=measured.length>250?measured.filter((_,i)=>i%Math.ceil(measured.length/250)===0):measured;
 for(const p of kept)svg.append(newEl('circle',{cx:X(p.time),cy:Y(p.ratio),r:2.2,fill:'#17627a'}));
 svg.append(newEl('text',{x:390,y:320,'text-anchor':'middle',class:'axis'},'Time (s)'));
 svg.append(newEl('text',{x:15,y:150,'text-anchor':'middle',transform:'rotate(-90 15 150)',class:'axis'},'Cout/Cin'));
 root.append(svg);
 $('experimentChartNote').textContent='Measured: blue solid line. '+(simulated.length?'Forward model: orange dashed line.':'')+(fitted.length?' Fitted '+(lastFit?.fitSolver==='globaloc1d'?'1D Global OC':'1D FVM')+': green dashed line.':'')+' Time in seconds, concentration as Cout/Cin.';
}
function summarize(){
 if(!measured)return;
 const metrics=$('experimentMetrics');metrics.replaceChildren();
 const vals=[['t5 (s)',fmt(lastAnalysis.t05)],['t50 (s)',fmt(lastAnalysis.t50)],['t95 (s)',fmt(lastAnalysis.t95)],['Retained (mol/kg)',fmt(lastAnalysis.netRetainedPerKgMolKg)]];
 if(lastComparison)vals.push(['Model RMSE (C/Cin)',fmt(lastComparison.rmse)],['Compared points',lastComparison.n+'/'+measured.length]);
 if(lastFit)vals.push(['Fitted RMSE (C/Cin)',fmt(lastFit.metrics.rmse)]);
 for(const [name,value] of vals){const card=document.createElement('div');card.className='metric';const v=document.createElement('div');v.className='value';v.textContent=String(value);const l=document.createElement('div');l.className='name';l.textContent=name;card.append(v,l);metrics.append(card);}
 $('experimentWarnings').textContent=lastAnalysis.warning.join(' ')+(lastComparison?.excluded?' '+lastComparison.excluded+' measurements outside simulation time ignored.':'');
 drawChart();
}
function analyze(){
 if(fitWorker)cancelFit("Experimental data changed; fit cancelled.");
 lastFit=null;clearFitDisplay();
 try{
  const parsed=parseBreakthroughCSV($('experimentData').value,{timeUnit:$('expTimeUnit').value,
    concentrationMode:$('expMode').value,feedConcentration:Number($('feed').value)});
  measured=parsed.points;
  lastAnalysis=analyzeBreakthrough(measured,{feedConcentration:Number($('feed').value),
    flowRateM3s:Number($('expFlow').value),adsorbentMassKg:Number($('expMass').value)});
  lastComparison=null;
  if(lastResult&&lastResult.config.gas.feedConcentration>0){
    try{lastComparison=compareBreakthrough(measured,lastResult.samples);}catch(e){message('Measurements loaded, but model comparison unavailable: '+e.message);}
  }
  summarize();message(measured.length+' measured points analyzed. '+(lastComparison?'Model comparison calculated.':'Run a forward model to compare.'));
 }catch(e){message('Experiment analysis error: '+e.message,true);}
}
$('expApplySettings').addEventListener('click',currentSettings);
$('expAnalyze').addEventListener('click',analyze);
$('expFile').addEventListener('change',async e=>{
 const file=e.target.files?.[0];if(!file)return;
 try{if(file.size>3000000)throw Error('Maximum CSV size is 3 MB.');$('experimentData').value=await file.text();analyze();}
 catch(err){message(err.message,true);}finally{e.target.value='';}
});
$('expExport').addEventListener('click',()=>{
 if(!lastAnalysis)return;
 const out={tool:'Adsorp Column Studio experiment',units:{time:'s',ratio:'Cout/Cin',flow:'m3/s',mass:'kg'},
  measurements:measured,analysis:lastAnalysis,comparison:lastComparison,
  modelSource:lastResult?.engine||null,fitting:lastFit};
 const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='breakthrough_experiment.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.addEventListener('column:result',event=>{
 lastResult=event.detail;
 if(!measured)return;
 try{lastComparison=lastResult.config.gas.feedConcentration>0?compareBreakthrough(measured,lastResult.samples):null;summarize();
 message('Measured breakthrough compared with the new forward run.');}catch(e){lastComparison=null;summarize();message('Model comparison not available: '+e.message);}
});
document.addEventListener('column:reset',()=>{lastResult=null;lastComparison=null;lastFit=null;
 if(fitWorker)cancelFit('Model inputs changed; fit cancelled.');clearFitDisplay();if(measured)summarize();});

function clearFitDisplay(){
 $('fitMetrics').replaceChildren();$('fitWarnings').textContent='';
 $('fitApply').disabled=true;$('fitExport').disabled=true;
}
function setFitRunning(running){
 $('fitBtn').disabled=running;$('fitCancel').disabled=!running;$('runBtn').disabled=running;
}
function fitMessage(text,error=false){
 $('fitStatus').textContent=text;
 $('fitStatus').className='status'+(error?' error':'');
}
function cancelFit(reason='Fitting cancelled.'){
 if(fitWorker){fitWorker.terminate();fitWorker=null;}
 setFitRunning(false);
 fitMessage(reason);
}
function showFit(){
 if(!lastFit)return;
 const metrics=[
  ['Fitted kLDF (1/s)',lastFit.fitted.k===undefined?'Fixed':fmt(lastFit.fitted.k)],
  ['Fitted Dz (m²/s)',lastFit.fitted.dz===undefined?'Fixed':fmt(lastFit.fitted.dz)],
  ['Initial RMSE',fmt(lastFit.baselineRmse)],
  ['Fit RMSE',fmt(lastFit.metrics.rmse)],
  ['Evaluations',lastFit.evaluations],
  ['Failed trials',lastFit.failedEvaluations]];
 if(lastFit.modelLineage?.kinetic)metrics.push(['Kinetic upstream (1/s)',fmt(lastFit.modelLineage.kinetic.rateConstant)]);
 if(lastFit.gridCheck)metrics.push(['Doubled-grid RMS difference',fmt(lastFit.gridCheck.rmsCurveDifference)]);
 const container=$('fitMetrics');container.replaceChildren();
 for(const [name,value] of metrics){
  const card=document.createElement('div');card.className='metric';
  const v=document.createElement('div');v.className='value';v.textContent=String(value);
  const l=document.createElement('div');l.className='name';l.textContent=name;
  card.append(v,l);container.append(card);
 }
 $('fitWarnings').textContent=lastFit.warnings.join(' ');
 $('fitApply').disabled=false;$('fitExport').disabled=false;
 summarize();
}
function fit(){
 if(fitWorker)return;
 if(!measured){fitMessage('Analyze measured CSV before fitting.',true);return;}
 try{
  const detail={};document.dispatchEvent(new CustomEvent('column:fit-config-request',{detail}));
  if(detail.error)throw Error(detail.error);
  if(!detail.config)throw Error('Forward-model settings are unavailable.');
  const fitConfig=structuredClone(detail.config);
  const projectedTo1D=$('fitUniform1D').checked;
  if(projectedTo1D){
   fitConfig.grid.nr=1;
   fitConfig.flow.inletAmplitude=0;
   fitConfig.flow.velocityAmplitude=0;
   fitConfig.flow.radialDispersion=0;
  }
  const payload={config:fitConfig,projectedTo1D,lineage:detail.lineage,measurements:measured,parameters:$('fitMode').value,
   bounds:{k:{min:Number($('fitKMin').value),max:Number($('fitKMax').value)},
           dz:{min:Number($('fitDMin').value),max:Number($('fitDMax').value)}},
   maxEvaluations:Number($('fitBudget').value),fitSolver:$('fitSolver').value};
  lastFit=null;clearFitDisplay();drawChart();
  fitWorker=new Worker(new URL('./fit-worker.js',import.meta.url),{type:'module'});
  fitWorker.onmessage=event=>{
   const data=event.data||{};
   if(data.type==='progress'){
    fitMessage('Fitting: '+data.evaluations+'/'+data.maxEvaluations+' simulations; best RMSE '+(data.bestRmse===null?'—':fmt(data.bestRmse)));
   }else if(data.type==='error'){
    cancelFit('Parameter fitting failed: '+data.message);
    $('fitStatus').classList.add('error');
   }else if(data.type==='result'){
    lastFit=data.result;
    fitWorker.terminate();fitWorker=null;setFitRunning(false);
    showFit();
    fitMessage('Fitting completed using '+(lastFit.fitSolver==='globaloc1d'?'1D Global OC':'1D FVM')+'. Review mesh/time convergence and identifiability warnings.');
   }
  };
  fitWorker.onerror=e=>{cancelFit('Fit worker failed: '+(e.message||'Unknown error'));$('fitStatus').classList.add('error');};
  setFitRunning(true);
  fitMessage('Starting bounded '+($('fitSolver').value==='globaloc1d'?'Global OC':'FVM')+' parameter estimation…');
  fitWorker.postMessage({type:'fit',payload});
 }catch(e){
  if(fitWorker){fitWorker.terminate();fitWorker=null;}
  setFitRunning(false);fitMessage(e?.message||String(e),true);
 }
}
$('fitBtn').addEventListener('click',fit);
$('fitCancel').addEventListener('click',()=>cancelFit());
$('fitApply').addEventListener('click',()=>{
 if(!lastFit)return;
 const detail={fitted:lastFit.fitted,applied:false};
 document.dispatchEvent(new CustomEvent('column:fit-apply',{detail}));
 fitMessage(detail.applied?'Fitted values applied. The fitting report should be exported before rerunning the model.':detail.error||'Could not apply values.',!detail.applied);
});
$('fitExport').addEventListener('click',()=>{
 if(!lastFit)return;
 const blob=new Blob([JSON.stringify({...lastFit,measurements:measured},null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='breakthrough_parameter_fit.json';document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
});
for(const id of ['fitSolver','fitMode','fitBudget','fitKMin','fitKMax','fitDMin','fitDMax','fitUniform1D']){
 $(id).addEventListener('change',()=>{
  if(fitWorker)cancelFit('Fitting settings changed; previous run cancelled.');
  if(lastFit){lastFit=null;clearFitDisplay();if(measured)summarize();}
  fitMessage('Fitting settings changed; rerun parameter estimation.');
 });
}
$('experimentData').addEventListener('input',()=>{
 measured=null;lastAnalysis=null;lastComparison=null;lastFit=null;
 if(fitWorker)cancelFit('Measurements edited; analyze again before fitting.');
 clearFitDisplay();$('experimentMetrics').replaceChildren();
 $('experimentChart').replaceChildren();fitMessage('Measurements edited. Analyze the curve before fitting.');
});

currentSettings();
