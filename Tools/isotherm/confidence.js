import {fitOne} from "./fitting.js";
import {resolveModel,makeHybrid} from "./models.js";

/**
 * Pointwise percentile bootstrap confidence intervals for the fitted conditional
 * mean isotherm, evaluated ONLY on the observed pressure/concentration interval.
 *
 * Unweighted: centered residual bootstrap at the fixed observed x.
 * Weighted with known sigma: parametric N(0, sigma_i^2) bootstrap.
 *
 * Assumes independent observations and correctly specified mean equation. This
 * does not account for model-selection uncertainty, systematic errors, temporal
 * correlation or extrapolation. It is NOT a prediction interval, nor simultaneous
 * confidence coverage of the entire plotted curve.
 */
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function rng(seed) {
  let s=(seed>>>0)||1;
  return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};
}
function gaussian(random){
  const u=Math.max(1e-12,random()),v=random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
export function percentile(sorted,p) {
  if(!sorted.length)throw Error("No samples for percentile.");
  const index=clamp(p,0,1)*(sorted.length-1),a=Math.floor(index),b=Math.ceil(index);
  return sorted[a]+(sorted[b]-sorted[a])*(index-a);
}
export function parameterConfidenceCsv(interval) {
  if(!interval?.parameters?.length)throw Error("No computed parameter confidence intervals to export.");
  const escape=x=>'"'+String(x).replaceAll('"','""')+'"';
  const header="parameter,estimate_physical,lower_physical,upper_physical,confidence_level,bound_frequency";
  const data=interval.parameters.map(p=>[escape(p.name),p.estimate,p.lower,p.upper,interval.level,p.boundFrequency].join(","));
  return header+"\n"+data.join("\n")+"\n";
}

export function confidenceCsv(interval) {
  if(!interval?.grid?.length)throw Error("No computed confidence interval to export.");
  return "x,confidence_lower,confidence_upper\n"+interval.grid.map(d=>[d.x,d.lower,d.upper].join(",")).join("\n")+"\n";
}

/**
 * Match exchangeable sites of a bootstrap refit to the reference fit.
 * Assignment is by shortest squared distance in log-coefficient space;
 * site labels have no physical meaning when sites coincide. For non-identical
 * additive components, preserve the component order as defined by the user.
 */
export function alignExchangeableParameters(model,sample,reference) {
  const k=sample.length;
  if(k!==reference.length)return sample.slice();
  let blocks=[];
  if(model.id==="dual_langmuir"||model.id==="triple_langmuir"){
    blocks=Array.from({length:k/2},(_,i)=>({indices:[2*i,2*i+1],kind:"langmuir"}));
  }else if(model.components){
    let index=0;
    blocks=model.components.map(id=>{
      const n=resolveModel(id).params.length;
      const indices=Array.from({length:n},(_,i)=>index+i);index+=n;
      return {indices,kind:id};
    });
  }else return sample.slice();
  const out=sample.slice(),used=new Set();
  for(const group of new Set(blocks.map(x=>x.kind))){
    const indices=blocks.map((b,i)=>b.kind===group?i:-1).filter(i=>i>=0);
    if(indices.length<2)continue;
    const permutations=list=>{
      if(list.length<=1)return [list];
      return list.flatMap((v,i)=>permutations([...list.slice(0,i),...list.slice(i+1)]).map(t=>[v,...t]));
    };
    let best=null,minScore=Infinity;
    for(const perm of permutations(indices)){
      let score=0;
      indices.forEach((targetSite,j)=>{
        const dest=blocks[targetSite].indices,src=blocks[perm[j]].indices;
        for(let p=0;p<dest.length;p++){
          const a=Math.log(Math.max(sample[src[p]],1e-300));
          const b=Math.log(Math.max(reference[dest[p]],1e-300));
          score+=(a-b)**2;
        }
      });
      if(score<minScore){minScore=score;best=perm;}
    }
    indices.forEach((targetSite,j)=>{
      const dest=blocks[targetSite].indices,src=blocks[best[j]].indices;
      dest.forEach((d,p)=>{out[d]=sample[src[p]];used.add(d);});
    });
  }
  return out;
}

export async function bootstrapConfidence(fit,data,{
  level=.95,replicates=120,starts=4,seed=20261023,optimizer="lbfgs",
  weighted=false,gridPoints=181,onProgress=null,yieldTask=null,shouldAbort=null
}={}) {
  if(!(level>.5&&level<1))throw Error("Confidence level must be between 50% and 100%.");
  if(!Number.isInteger(replicates)||replicates<20||replicates>500)throw Error("Bootstrap count must be between 20 and 500.");
  if(!Number.isInteger(gridPoints)||gridPoints<2||gridPoints>401)throw Error("Invalid confidence grid size.");
  const model=fit.modelComponents?makeHybrid(fit.modelComponents):resolveModel(fit.id);
  const k=model.params.length;
  if(data.length<Math.max(8,k+3))throw Error("Too few observations for bootstrap uncertainty (need at least max(8, k+3)).");
  if(weighted&&data.some(d=>!(d.sigma>0)))throw Error("Weighted parametric bootstrap requires positive sigma for every observation.");
  const xMin=Math.min(...data.map(r=>r.x)),xMax=Math.max(...data.map(r=>r.x));
  if(!(xMax>xMin))throw Error("Bootstrap requires more than one distinct x.");
  if(fit.observed.length!==data.length)throw Error("Fit and data size mismatch.");
  // Associate residuals by input rather than assuming sorted row order.
  const matched=data.every((d,i)=>Math.abs(d.x-fit.observed[i].x)<1e-12&&Math.abs(d.y-fit.observed[i].y)<1e-12);
  if(!matched)throw Error("Bootstrap data must have the same row order as the fitted data.");
  const means=data.map(d=>fit.predict(d.x));
  if(means.some(y=>!Number.isFinite(y)))throw Error("Fitted mean contains nonfinite predictions.");
  const rawResid=data.map((d,i)=>d.y-means[i]);
  const avg=rawResid.reduce((sum,v)=>sum+v,0)/rawResid.length;
  const resids=rawResid.map(x=>x-avg);
  const gridX=Array.from({length:gridPoints},(_,i)=>xMin+(xMax-xMin)*i/(gridPoints-1));
  const draws=gridX.map(()=>[]);
  const parameterDraws=Array.from({length:k},()=>[]);
  const parameterBounds=Array(k).fill(0);
  const paramNames=fit.paramNames.slice();
  const random=rng((seed>>>0)+781261),alpha=(1-level)/2;
  let successful=0,failed=0,nonConverged=0,atBounds=0,truncated=0;
  const bootstrapStarts=clamp(Math.floor(starts),1,8);
  for(let b=0;b<replicates;b++){
    if(shouldAbort?.())throw Error("Confidence interval calculation cancelled.");
    if(onProgress)onProgress(b+1,replicates);
    if(yieldTask&&b%4===0)await yieldTask();
    if(shouldAbort?.())throw Error("Confidence interval calculation cancelled.");
    const artificial=data.map((row,i)=>{
      const noise=weighted?gaussian(random)*row.sigma:resids[Math.floor(random()*data.length)];
      const raw=means[i]+noise;
      if(raw<0)truncated++;
      return {...row,y:Math.max(0,raw)};
    });
    try{
      const boot=fitOne(model,artificial,{
        optimizer,weighted,starts:bootstrapStarts,seed:seed+479*b+17,
        maxIter:optimizer==="lbfgs"?180:130
      });
      const estimates=gridX.map(x=>boot.predict(x));
      if(estimates.some(v=>!Number.isFinite(v)||v<0)){failed++;continue;}
      if(boot.convergence.converged===false)nonConverged++;
      if(boot.params.some((v,j)=>v<=model.params[j].low*1.002||v>=model.params[j].high*.998))atBounds++;
      estimates.forEach((y,i)=>draws[i].push(y));
      const aligned=alignExchangeableParameters(model,boot.params,fit.params);
      const alignedPhysical=alignExchangeableParameters(model,boot.physicalParameters,fit.physicalParameters);
      alignedPhysical.forEach((v,j)=>parameterDraws[j].push(v));
      aligned.forEach((v,j)=>{if(v<=model.params[j].low*1.002||v>=model.params[j].high*.998)parameterBounds[j]++;});
      successful++;
    }catch(_){failed++;}
  }
  if(successful<Math.max(20,Math.ceil(replicates*.7))){
    throw Error("Too few valid bootstrap refits ("+successful+"/"+replicates+"); confidence band not reliable.");
  }
  const grid=gridX.map((x,i)=>{
    const sorted=draws[i].sort((a,b)=>a-b);
    return {x,lower:percentile(sorted,alpha),upper:percentile(sorted,1-alpha)};
  });
  const parameters=parameterDraws.map((values,j)=>{
    const sorted=values.sort((a,b)=>a-b);
    const estimate=fit.physicalParameters[j];
    const lower=percentile(sorted,alpha),upper=percentile(sorted,1-alpha);
    return {name:paramNames[j],estimate,lower,upper,
      unitConvention:"physical_input_units",boundFrequency:parameterBounds[j]/successful,
      relativeWidth:(upper-lower)/Math.max(Math.abs(estimate),1e-12)};
  });
  const warnings=[];
  if(nonConverged>0)warnings.push(nonConverged+" bootstrap refits did not meet projected-gradient convergence.");
  if(atBounds>0)warnings.push(atBounds+" bootstrap refits reached a parameter bound (weak identifiability possible).");
  if(truncated>0)warnings.push(truncated+" negative simulated uptake values were clipped to zero; coverage may be distorted near q=0.");
  if(failed>0)warnings.push(failed+" bootstrap refits failed; percentiles use successful refits only.");
  if(successful<100)warnings.push("Fewer than 100 successful draws: percentile estimates may be noisy.");
  if(parameters.some(p=>p.relativeWidth>2))warnings.push("At least one parameter CI is wider than 200% of its point estimate; possible weak identifiability.");
  if(parameters.some(p=>p.boundFrequency>.1))warnings.push("At least one parameter hits a bound in more than 10% of bootstrap refits.");
  if(model.id==="dual_langmuir"||model.id==="triple_langmuir"||model.components?.some((id,i,a)=>a.indexOf(id)!==i))
    warnings.push("Exchangeable site parameter samples were matched to the reference fit by minimum log-distance; overlapping sites can still make these intervals unreliable.");
  if(model.components&&model.components.length>1)warnings.push("Hybrid component parameters may be non-unique when component isotherms are nearly equivalent.");
  const rms=Math.sqrt(rawResid.reduce((sum,e)=>sum+e*e,0)/rawResid.length);
  if(rms<1e-10)warnings.push("Near-zero residuals: residual bootstrap cannot quantify instrumental/model uncertainty.");
  warnings.push("Pointwise conditional-mean interval only; does not account for model selection or guarantee simultaneous 95% curve coverage.");
  return {
    type:"pointwise_confidence_interval",method:weighted?"parametric_normal_known_sigma":"centered_residual_bootstrap",
    level,requested:replicates,successful,failed,seed,
    optimizer,starts:bootstrapStarts,weighted,domain:[xMin,xMax],
    nonConverged,atBounds,truncated,warnings,grid,parameters,
    parameterMethod:"physical_coefficient_percentile_bootstrap_reference_site_alignment"
  };
}
