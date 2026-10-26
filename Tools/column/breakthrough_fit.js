/* Bounded log-parameter, derivative-free estimation of 1D FVM column breakthrough.
   Parameters: k_LDF (s^-1), axial dispersion Dz (m^2/s), optionally both.
   Fixed equilibrium, flow and geometry; no unreported parameter fitting. */
import {simulateColumn,normalizeColumnConfig} from "./solver.js";
import {simulateGlobalOc1D} from "./global_oc1d.js";
import {compareBreakthrough} from "./breakthrough.js";

const valid=(x,name)=>{const v=Number(x);if(!Number.isFinite(v))throw Error(name+" must be finite.");return v;};
const limits={k:{field:"rateConstant",lo:1e-8,hi:1e4,label:"kLDF (1/s)"},
              dz:{field:"axialDispersion",lo:1e-10,hi:1e-2,label:"Dz (m²/s)"}};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const copy=x=>JSON.parse(JSON.stringify(x));
function predict(series,t){
 if(t<series[0].time-1e-9||t>series.at(-1).time+1e-9)throw Error("Measurement outside simulation horizon.");
 let low=0,high=series.length-1;
 while(high-low>1){const mid=(low+high)>>1;if(series[mid].time<=t)low=mid;else high=mid;}
 const a=series[low],b=series[high];
 const ya=Number(a.outletFraction),yb=Number(b.outletFraction);
 if(!Number.isFinite(ya)||!Number.isFinite(yb))throw Error("Invalid simulated outlet concentration.");
 return ya+(yb-ya)*clamp((t-a.time)/(b.time-a.time),0,1);
}
export function validateFitInputs({config,measurements,parameters="k",bounds={},fitSolver="fv"}){
 if(!Array.isArray(measurements)||measurements.length<8||measurements.length>5000)
  throw Error("Fitting requires 8–5,000 measured points spanning a breakthrough transition.");
 let previous=-Infinity,lowest=Infinity,highest=-Infinity;
 for(const p of measurements){
  const t=valid(p.time,"Measured time"),y=valid(p.ratio,"Measured outlet ratio");
  if(t<0||t<=previous||y<0||y>1.2)throw Error("Measured time must increase strictly and Cout/Cin must be within [0, 1.2].");
  previous=t;lowest=Math.min(lowest,y);highest=Math.max(highest,y);
 }
 if(highest-lowest<.1)throw Error("Measured data do not span a meaningful breakthrough transition (range < 0.1).");
 if(measurements.length>300)throw Error("Fitting supports up to 300 observations. Downsample the experimental curve for PE; retain the full original for comparison.");
 const raw=copy(config);
 const cfg=normalizeColumnConfig(raw);
 fitSolver=String(fitSolver);
 if(!["fv","globaloc1d"].includes(fitSolver))
  throw Error("Breakthrough fitting solver must be fv or globaloc1d.");
 if(cfg.thermal.enabled)throw Error("Breakthrough PE currently supports isothermal FVM or Global OC only; disable non-isothermal mode for fitting.");
 if(fitSolver==="globaloc1d"&&cfg.grid.nz>80)
  throw Error("1D Global OC fitting supports at most 80 global axial nodes.");
 if(cfg.grid.nr!==1||cfg.flow.inletAmplitude!==0||cfg.flow.velocityAmplitude!==0)
  throw Error("1D fitting requires radial rings=1 and zero radial inlet/velocity amplitudes.");
 if(cfg.gas.direction!=="adsorption"||cfg.gas.feedConcentration<=0)
  throw Error("This fitting workflow requires an adsorption step with positive constant feed concentration.");
 if(cfg.gas.initialConcentration!==0||cfg.adsorption.initialLoading!==0)
  throw Error("Initial gas concentration and solid loading must both be zero for this step-response fit.");
 if(cfg.flow.superficialVelocity<=0)throw Error("A positive superficial velocity is required.");
 if(measurements.at(-1).time>cfg.simulation.endTime+1e-8)
  throw Error("Simulation end time must cover ALL measured points. Increase model end time.");
 const selected=parameters==="both"?["k","dz"]:[parameters];
 if(selected.some(x=>!limits[x]))throw Error("Choose k, dz, or both for estimation.");
 const ranges={};
 for(const name of selected){
  const l=limits[name],b=bounds[name]||{};
  const low=valid(b.min??(name==="k"?1e-4:1e-7),l.label+" lower bound");
  const high=valid(b.max??(name==="k"?20:1e-3),l.label+" upper bound");
  if(low<l.lo||high>l.hi||low>=high)
   throw Error(l.label+" bounds must satisfy "+l.lo+" ≤ min < max ≤ "+l.hi+".");
  ranges[name]={min:low,max:high,logMin:Math.log(low),logWidth:Math.log(high/low)};
 }
 // A kinetic report is a source of the INITIAL rate, not an overriding fit parameter.
 // normalizeColumnConfig already resolves imported kinetic units.
 return {config:cfg,measurements:measurements.map(p=>({time:p.time,ratio:p.ratio})),selected,ranges,fitSolver};
}
export async function fitColumnBreakthrough(options,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const {config,measurements,selected,ranges,fitSolver}=validateFitInputs(options);
 const solveForward=fitSolver==="globaloc1d"?simulateGlobalOc1D:simulateColumn;
 const maxEvaluations=Math.trunc(Number(options.maxEvaluations??160));
 if(!Number.isFinite(maxEvaluations)||maxEvaluations<20||maxEvaluations>350)
   throw Error("Evaluation budget must be an integer in [20, 350].");
 const initial={k:config.adsorption.rateConstant,dz:config.flow.axialDispersion};
 const toNormal=(name,value)=>{
  const r=ranges[name];return value>0?clamp(Math.log(value/r.min)/r.logWidth,0,1):0;
 };
 const start=selected.map(name=>toNormal(name,initial[name]));
 const decode=x=>Object.fromEntries(selected.map((name,i)=>[name,ranges[name].min*Math.exp(clamp(x[i],0,1)*ranges[name].logWidth)]));
 const keys=x=>x.map(v=>clamp(v,0,1).toFixed(9)).join(":");
 const seen=new Map();
 let evaluations=0,failed=0,best=null,lastError=null;
 async function objective(coords){
  if(shouldAbort?.())throw Error("Fit cancelled.");
  const x=coords.map(v=>clamp(v,0,1)),key=keys(x);
  if(seen.has(key))return seen.get(key);
  if(evaluations>=maxEvaluations)return null;
  evaluations++;
  const params=decode(x),trial=copy(config);
  if(params.k!==undefined){trial.adsorption.rateConstant=params.k;delete trial.adsorption.kineticReport;}
  if(params.dz!==undefined)trial.flow.axialDispersion=params.dz;
  let record;
  try{
   const simulation=await solveForward(trial,{shouldAbort,yieldTask});
   if(Math.abs(simulation.statistics.relativeMassResidual)>1e-7)
     throw Error("Mass conservation tolerance exceeded.");
   const metrics=compareBreakthrough(measurements,simulation.samples);
   if(metrics.n!==measurements.length)throw Error("Measured points exceed simulation horizon.");
   record={x,params,loss:metrics.rmse*metrics.rmse,metrics,simulation};
  }catch(e){
   if(shouldAbort?.())throw Error("Fit cancelled.");
   failed++;lastError=e?.message||String(e);
   record={x,params,loss:Infinity,metrics:null,simulation:null};
  }
  seen.set(key,record);
  if(Number.isFinite(record.loss)&&(!best||record.loss<best.loss))best=record;
  if(onProgress&&(evaluations===1||evaluations%5===0))
   onProgress({evaluations,maxEvaluations,failed,bestRmse:best?.metrics.rmse??null});
  if(yieldTask&&evaluations%2===0)await yieldTask();
  return record;
 }
 // Deterministic multistart: always check imported/user starting point first.
 const searchLimit=maxEvaluations-2*selected.length;
 const starts=selected.length===1?[start,[.15],[.5],[.85]]:[
   start,[.15,.15],[.85,.85],[.15,.85],[.85,.15],[.5,.5]];
 const baseline=await objective(start);
 const directions=selected.length===1?[[1],[-1]]:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
 for(const seed of starts){
  if(evaluations>=searchLimit||shouldAbort?.())break;
  let current=await objective(seed);
  if(!current)break;
  let step=.25;
  while(step>=.004&&evaluations<searchLimit){
   if(shouldAbort?.())throw Error("Fit cancelled.");
   let improved=current;
   for(const d of directions){
    if(evaluations>=searchLimit)break;
    const trial=await objective(current.x.map((v,i)=>clamp(v+step*d[i],0,1)));
    if(!trial)break;
    if(trial.loss+1e-14<improved.loss)improved=trial;
   }
   if(improved!==current)current=improved;else step*=.5;
  }
 }
 if(shouldAbort?.())throw Error("Fit cancelled.");
 if(!best||!Number.isFinite(best.loss))
  throw Error("All forward-model evaluations failed; last failure: "+(lastError||"unknown"));
 const warnings=[
  ...(options.projectedTo1D?["Fitting uses a radially uniform 1D approximation of the current column settings. Radial flow/composition effects from the 2D model were excluded; fitted parameters may not transfer."]:[]),
  "The same breakthrough curve was used for fitting and assessing fit quality; independent prediction validation is required.",
  "The equilibrium, feed step, geometry, flow and porosity are held fixed; uncertainty in them is not reflected in fitted parameters.",
  fitSolver==="globaloc1d"?"Global spectral truncation, global positivity correction, and first-order BE time integration may bias fitted Dz or kLDF; refine global nodes and BE steps.":"Finite-volume numerical dispersion and 64–80-point outlet reporting may bias fitted Dz or kLDF; repeat the fit on a refined grid."
 ];
 if(measurements[0].time>0)warnings.push("Measurements do not begin at t=0; injection-time offset was not estimated.");
 const rangesAtLimit=selected.filter((name,i)=>best.x[i]<.015||best.x[i]>.985);
 if(rangesAtLimit.length)warnings.push("Fitted parameter(s) at or near the bound: "+rangesAtLimit.join(", ")+". Check physical constraints and identifiability.");
 if(failed)warnings.push(failed+" trial simulation(s) failed or violated mass balance.");
 const sensitivity=[];
 for(let i=0;i<selected.length;i++){
  const plus=[...best.x],minus=[...best.x],delta=.0125;
  plus[i]=clamp(plus[i]+delta,0,1);minus[i]=clamp(minus[i]-delta,0,1);
  const rp=await objective(plus),rm=await objective(minus);
  if(!rp?.simulation||!rm?.simulation||plus[i]===minus[i]){sensitivity.push(null);continue;}
  sensitivity.push(measurements.map(p=>
   (predict(rp.simulation.samples,p.time)-predict(rm.simulation.samples,p.time))/(plus[i]-minus[i])));
 }
 let correlation=null,conditioning=null;
 if(sensitivity.every(Boolean)){
  const norms=sensitivity.map(v=>v.reduce((s,x)=>s+x*x,0));
  if(norms.some(n=>n<1e-9)){
   warnings.push("At least one fitted parameter has near-zero local sensitivity: it is practically unidentifiable.");
  }else if(selected.length===2){
   const dot=sensitivity[0].reduce((s,v,i)=>s+v*sensitivity[1][i],0);
   correlation=dot/Math.sqrt(norms[0]*norms[1]);
   const trace=norms[0]+norms[1],disc=Math.sqrt((norms[0]-norms[1])**2+4*dot*dot);
   conditioning=trace>disc?(trace+disc)/(trace-disc):Infinity;
   if(Math.abs(correlation)>.9||conditioning>1e4)
    warnings.push("kLDF and Dz have strongly correlated/small local sensitivities; simultaneous estimates may be non-unique.");
  }
 }
 let gridCheck=null;
 const gridLimit=fitSolver==="globaloc1d"?80:160;
 if(config.grid.nz*2<=gridLimit){
  const refine=copy(best.simulation.config);refine.grid.nz=2*config.grid.nz;
  try{
   const finer=await solveForward(refine,{shouldAbort,yieldTask});
   const compared=compareBreakthrough(measurements,finer.samples);
   gridCheck={coarseCells:config.grid.nz,fineCells:refine.grid.nz,
    coarseRmse:best.metrics.rmse,fineRmseAtSameParameters:compared.rmse,
    rmsCurveDifference:Math.sqrt(measurements.reduce((sum,p)=>sum+
      (predict(best.simulation.samples,p.time)-predict(finer.samples,p.time))**2,0)/measurements.length)};
   if(gridCheck.rmsCurveDifference>Math.max(.0025,.25*best.metrics.rmse))
    warnings.push("Breakthrough changes materially after doubling "+(fitSolver==="globaloc1d"?"Global OC nodal":"FV cell")+" resolution. Fitted coefficients may contain spatial-discretization bias.");
  }catch(e){if(shouldAbort?.())throw Error("Fit cancelled.");warnings.push("Refined-grid check failed: "+String(e?.message||e));}
 }else warnings.push("Automatic double-grid check unavailable: twice the selected "+(fitSolver==="globaloc1d"?"Global OC nodes":"FV cells")+" exceeds method limit.");
 return {tool:"Adsorp Column Studio breakthrough PE",schemaVersion:"1.1",fitSolver,
   algorithm:"bounded log-space deterministic multistart pattern search",
   selected,initial,modelLineage:options.lineage||null,
   upstreamKineticRole:options.lineage?.kinetic?(selected.includes("k")?"initial value, refitted":"fixed upstream rate"):null,
   projectedTo1D:Boolean(options.projectedTo1D),bounds:Object.fromEntries(selected.map(n=>[n,{min:ranges[n].min,max:ranges[n].max}])),
   fitted:best.params,baselineRmse:baseline?.metrics?.rmse??null,metrics:best.metrics,
   evaluations,failedEvaluations:failed,maxEvaluations,
   sensitivity:{correlation,conditionNumber:conditioning},
   gridCheck,warnings,
   fittedModel:{config:best.simulation.config,engine:best.simulation.engine,statistics:best.simulation.statistics,
     samples:best.simulation.samples}};
}