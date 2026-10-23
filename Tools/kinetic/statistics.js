import {kineticModel} from "./models.js";
import {fitKinetic,prepareKinetic} from "./fitting.js";
import {symmetricEigen} from "../isotherm/identifiability.js";
const clip=(v,a,b)=>Math.max(a,Math.min(b,v));
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const norm=a=>Math.sqrt(dot(a,a));
const rng=seed=>{let s=seed>>>0||1;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;}};
const gaussian=r=>Math.sqrt(-2*Math.log(Math.max(1e-12,r())))*Math.cos(2*Math.PI*r());
export function percentile(x,f){if(!x.length)throw Error("No bootstrap samples.");const s=x.slice().sort((a,b)=>a-b),t=clip(f,0,1)*(s.length-1),i=Math.floor(t);return s[i]+((s[i+1]??s[i])-s[i])*(t-i);}
export function kineticIdentifiability(fit,data,options={}){
 const state=prepareKinetic(fit.model,data,options),n=data.length,k=fit.params.length;
 if(n<=k+2)throw Error("Not enough points for local identifiability.");
 const z=fit.params.map(Math.log),lo=fit.model.params.map(p=>Math.log(p.low)),hi=fit.model.params.map(p=>Math.log(p.high));
 const times=data.map(d=>d.time),weighted=fit.metrics.weighted;
 const sensitivities=[];
 for(let j=0;j<k;j++){
   const plus=z.slice(),minus=z.slice(),h=1e-4;
   plus[j]=Math.min(hi[j],plus[j]+h);minus[j]=Math.max(lo[j],minus[j]-h);
   const qp=state.calculate(plus.map(Math.exp),times),qm=state.calculate(minus.map(Math.exp),times);
   sensitivities.push(qp.map((v,i)=>(v-qm[i])/(plus[j]-minus[j])/(weighted?data[i].sigma:state.qScale)));
 }
 const norms=sensitivities.map(norm),maxNorm=Math.max(1e-20,...norms),normalized=sensitivities.map((v,i)=>norms[i]/maxNorm>1e-9?v.map(x=>x/norms[i]):v.map(()=>0));
 const gram=normalized.map(v=>normalized.map(w=>dot(v,w)));
 const eig=symmetricEigen(gram);
 const singular=eig.map(e=>Math.sqrt(Math.max(e.value,0))),rank=singular.filter(v=>v>1e-6*singular[0]).length;
 const condition=rank<k?null:singular[0]/singular.at(-1);
 const coupled=[];
 for(let i=0;i<k;i++)for(let j=i+1;j<k;j++){
   const rho=dot(normalized[i],normalized[j]);
   if(Math.abs(rho)>.95)coupled.push({a:fit.paramNames[i],b:fit.paramNames[j],sensitivityCorrelation:rho});
 }
 const warnings=[];
 if(rank<k)warnings.push("Numerical sensitivity Jacobian is rank deficient; kinetic parameters cannot be independently resolved.");
 if(condition!==null&&condition>1e6)warnings.push("Sensitivity matrix is ill-conditioned (>1e6).");
 if(coupled.length)warnings.push("High parameter sensitivity correlation in "+coupled.length+" pair(s).");
 if(fit.boundary.some(Boolean))warnings.push("Parameter(s) at optimization bounds; local uncertainty estimates may be unreliable.");
 if(n<4*k)warnings.push("Fewer than four observations per fitted parameter.");
 return {method:"local_normalized_log_parameter_jacobian",rank,total:k,condition,singularValues:singular,
   correlations:normalized.map(a=>normalized.map(b=>dot(a,b))),coupled,warnings,
   notice:"Local practical identifiability only, not structural identifiability or a full parameter-covariance estimate."};
}
export async function kineticBootstrap(fit,data,options={},{
 level=.95,replicates=80,starts=3,seed=20261023,
 onProgress=null,yieldTask=null,shouldAbort=null
}={}){
 if(![.9,.95,.99].includes(level))throw Error("Select 90%, 95% or 99% confidence.");
 if(!Number.isInteger(replicates)||replicates<20||replicates>500)throw Error("Bootstrap count must be 20–500.");
 const model=fit.model,weighted=fit.metrics.weighted,n=data.length;
 if(n<Math.max(8,model.params.length+4))throw Error("Insufficient observations for confidence intervals.");
 const baseline=fit.predict(data.map(d=>d.time)),residual=data.map((d,i)=>d.y-baseline[i]);
 const avg=residual.reduce((s,v)=>s+v,0)/n,centered=residual.map(v=>v-avg);
 const random=rng(seed+7391),curve=Array.from({length:n},()=>[]),parameters=Array.from({length:fit.params.length},()=>[]);
 let failed=0,clipped=0,bound=0,nonconverged=0,completed=0;
 for(let j=0;j<replicates;j++){
   if(shouldAbort?.())throw Error("Bootstrap computation cancelled.");
   if(yieldTask&&j%4===0)await yieldTask();
   if(shouldAbort?.())throw Error("Bootstrap computation cancelled.");
   onProgress?.(j+1,replicates);
   const synthetic=data.map((d,i)=>{
     const err=weighted?d.sigma*gaussian(random):centered[Math.floor(random()*n)];
     let y=baseline[i]+err;if(y<0){y=0;clipped++;}
     return {...d,y};
   });
   try{
     const r=fitKinetic(model,synthetic,{...options,weighted,q0Fixed:fit.initial.q0,
       starts:Math.min(4,starts),seed:seed+j*673+13,maxIter:160});
     const yh=r.predict(data.map(d=>d.time));
     if(yh.some(v=>!Number.isFinite(v)||v<0))throw Error("Nonfinite bootstrap curve");
     yh.forEach((v,i)=>curve[i].push(v));
     r.physicalParameters.forEach((v,i)=>parameters[i].push(v));
     if(r.boundary.some(Boolean))bound++;
     if(r.convergence.algorithm==="lbfgs"&&r.convergence.converged===0)nonconverged++;
     completed++;
   }catch{failed++;}
 }
 if(completed<Math.max(20,Math.ceil(.7*replicates)))throw Error("Too few successful bootstrap fits: "+completed+"/"+replicates);
 const a=(1-level)/2;
 const grid=data.map((d,i)=>({time:d.time,lower:percentile(curve[i],a),upper:percentile(curve[i],1-a)}));
 const coeff=parameters.map((draws,i)=>({name:fit.paramNames[i],estimate:fit.physicalParameters[i],lower:percentile(draws,a),upper:percentile(draws,1-a),
   relativeWidth:(percentile(draws,1-a)-percentile(draws,a))/Math.max(Math.abs(fit.physicalParameters[i]),1e-10)}));
 const warnings=["Pointwise conditional-on-model confidence intervals only; no model selection uncertainty, joint/simultaneous coverage or individual-observation prediction interval."];
 if(failed)warnings.push(failed+" bootstrap optimizations failed; percentiles use successful runs.");
 if(clipped)warnings.push(clipped+" negative simulated loading values clipped to zero; coverage may be distorted.");
 if(bound)warnings.push(bound+" refits encountered parameter bounds.");
 if(nonconverged)warnings.push(nonconverged+" refits did not meet projected-gradient convergence.");
 if(coeff.some(p=>p.relativeWidth>2))warnings.push("Some parameter intervals exceed twice their point estimates: weak identifiability possible.");
 if(completed<100)warnings.push("Fewer than 100 successful bootstrap draws; quantiles may be noisy.");
 return {level,method:weighted?"normal_known_sigma":"centered_residual",replicates,successful:completed,failed,clipped,bound,nonconverged,seed,
   grid,parameters:coeff,warnings};
}
export function kineticConfidenceCSV(result){return "time,lower,upper\n"+result.grid.map(r=>[r.time,r.lower,r.upper].join(",")).join("\n")+"\n";}
export function kineticParameterCSV(result){return "name,estimate_physical,lower_physical,upper_physical\n"+result.parameters.map(r=>[r.name,r.estimate,r.lower,r.upper].join(",")).join("\n")+"\n";}
