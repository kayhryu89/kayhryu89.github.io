import {MODELS,makeHybrid,evaluate} from "./models.js";
import {fitOne} from "./fitting.js";

// Canonical mathematical forms only. Aliases may be fitted manually but must not
// be counted as independent candidates during automatic selection.
const ALIASES=new Set(["radke_prausnitz","koble_corrigan"]);
const advanced=new Set(["triple_langmuir","jensen_seaton","fritz_schlunder"]);
export function candidateModels({relative=false,n=0,hybrids=true}={}) {
  const candidates=MODELS.filter(m=>(relative||!m.relative)&&!ALIASES.has(m.id)&&
    n>=Math.max(8,3*m.params.length+3)&&(!advanced.has(m.id)||n>=6*m.params.length+5));
  // The first hybrid is expected to aid non-saturating tails; the second is a
  // deliberately flexible case. Never conflate pure-component additive sites
  // with competitive mixed-gas adsorption.
  if(!relative&&hybrids&&n>=20){
    candidates.push(makeHybrid(["langmuir","henry"]));
    if(n>=30)candidates.push(makeHybrid(["langmuir","sips"]));
  }
  return candidates;
}
export function stratifiedFolds(data,k=4) {
  if(data.length<12) return [];
  const folds=Array.from({length:Math.min(k,Math.floor(data.length/3))},()=>[]);
  data.map((d,i)=>({d,i})).sort((a,b)=>a.d.x-b.d.x).forEach(({i},rank)=>folds[rank%folds.length].push(i));
  return folds;
}
function monotonicity(model,fit,data) {
  const lo=Math.min(...data.map(r=>r.x)),hi=Math.max(...data.map(r=>r.x));
  let prev=-Infinity,negative=0,invalid=0;
  for(let i=0;i<=100;i++){
    const x=lo+(hi-lo)*i/100;
    const y=fit.predict(x);
    if(!Number.isFinite(y)||y<0){invalid++;continue;}
    if(i>0&&y<prev-1e-8*Math.max(1,Math.abs(prev)))negative++;
    prev=y;
  }
  return {negative,invalid};
}
export function validateFit(model,fullFit,data) {
  const g=monotonicity(model,fullFit,data);
  // Physical/numerical eligibility is checked over the measured interval.
  const bound=fullFit.params.some((v,i)=>v<=model.params[i].low*1.002||v>=model.params[i].high*.998);
  return {eligible:g.invalid===0&&g.negative===0,physicalWarnings:[
    ...(g.invalid?["Nonfinite/negative fitted prediction in experimental range."]:[]),
    ...(g.negative?["Fitted uptake decreases over sampled experimental range."]:[]),
    ...(bound?["One or more fit parameters reached a bound."]:[])
  ],bound};
}
/**
 * Four interleaved pressure-stratified folds. This targets INTERPOLATION and
 * is not independent experimental validation or blocked extrapolation.
 */
export function crossValidate(model,data,{foldCount=4,starts=4,seed=20261023,weighted=false,optimizer="lbfgs"}={}) {
  const folds=stratifiedFolds(data,foldCount);
  if(!folds.length)return {rmse:null,folds:0,reason:"Need >=12 observations for interleaved cross-validation."};
  let n=0,sse=0,foldErrors=[],failures=[];
  for(let i=0;i<folds.length;i++){
    const held=new Set(folds[i]);
    const train=data.filter((_,j)=>!held.has(j));
    const test=data.filter((_,j)=>held.has(j));
    if(train.length<=model.params.length+1){
      failures.push("Too few calibration points in fold "+(i+1));continue;
    }
    try{
      const fitted=fitOne(model,train,{starts,seed:seed+101*i,weighted,optimizer,maxIter:optimizer==="lbfgs"?200:120});
      let foldSSE=0;
      for(const r of test){
        const p=fitted.predict(r.x);
        if(!Number.isFinite(p))throw Error("Nonfinite held-out prediction");
        foldSSE+=(r.y-p)**2;
      }
      foldErrors.push(Math.sqrt(foldSSE/test.length));
      sse+=foldSSE;n+=test.length;
    }catch(e){failures.push("Fold "+(i+1)+": "+e.message);}
  }
  if(failures.length || n!==data.length)return {rmse:null,folds:foldErrors.length,reason:failures.join("; ")||"Incomplete CV"};
  return {rmse:Math.sqrt(sse/n),folds:foldErrors.length,foldErrors,reason:null};
}
/** Select models with similar CV error, prefer fewer parameters/AICc, and
 * exclude clearly non-monotone predictions. */
export function recommend(scored,{relativeTolerance=.05}={}) {
  const evaluated=scored.filter(r=>r.cv&&Number.isFinite(r.cv.rmse)&&r.verification?.eligible);
  if(!evaluated.length)return null;
  const minCV=Math.min(...evaluated.map(r=>r.cv.rmse));
  const bestPool=evaluated.filter(r=>r.cv.rmse<=minCV*(1+relativeTolerance)+1e-9);
  bestPool.sort((a,b)=>a.fit.metrics.k-b.fit.metrics.k||
    (a.fit.metrics.aicc??Infinity)-(b.fit.metrics.aicc??Infinity)||a.cv.rmse-b.cv.rmse);
  return {winner:bestPool[0],bestCV:minCV,nearBest:bestPool.length,
    criterion:"Interleaved pressure-stratified CV RMSE; within 5% of minimum prefer lower parameter count then AICc"};
}
/** Evaluates auto model candidates, optionally yielding between candidates. */
export async function autoSelect(data,{relative=false,weighted=false,starts=8,seed=20261023,hybrids=true,optimizer="lbfgs",onProgress=null,yieldTask=null}={}) {
  const candidates=candidateModels({relative,n:data.length,hybrids});
  const scored=[],failures=[];
  for(let i=0;i<candidates.length;i++){
    const model=candidates[i];
    if(onProgress)onProgress(i+1,candidates.length,model.label);
    if(yieldTask)await yieldTask();
    try{
      const full=fitOne(model,data,{starts,seed,weighted,optimizer});
      const check=validateFit(model,full,data);
      if(!check.eligible){failures.push(model.label+": failed physical checks");continue;}
      const cv=crossValidate(model,data,{foldCount:4,starts:Math.max(2,Math.min(starts,4)),seed,weighted,optimizer});
      scored.push({model,fit:full,cv,verification:check});
    }catch(e){failures.push(model.label+": "+e.message);}
  }
  const choice=recommend(scored);
  const sorted=scored.sort((a,b)=>
    (a.cv.rmse??Infinity)-(b.cv.rmse??Infinity)||a.fit.metrics.k-b.fit.metrics.k);
  return {choice,scored:sorted,failures,totalCandidates:candidates.length,criterion:choice?.criterion||"No validated CV recommendation"};
}
