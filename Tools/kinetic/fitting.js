import {minimizeProjectedLBFGS} from "../isotherm/lbfgs.js";
import {minimizeBoundedTrustLS,minimizeDELBFGS} from "./optimizers.js";
import {normalEquations} from "../isotherm/fitting.js";
import {evaluateKinetic,parameterPhysical,ldfTrajectory,kineticModel} from "./models.js";

const clip=(x,l,h)=>Math.max(l,Math.min(h,x));
const rng=seed=>{let s=seed>>>0||1;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;}};
const sq=x=>x*x;
// Kinetic rate bounds are defined in the units supplied by the user,
// not in the normalized experiment duration (which can vary by orders
// of magnitude for the same physical experiment).
export function physicalBoundKineticModel(model,tScale,qScale){
 if(model._physicalBounded)return model;
 const factor={
   k1:tScale,kA:tScale,kLDF:tScale,
   k2:tScale*qScale,alpha:tScale/qScale,beta:qScale,kID:Math.sqrt(tScale)/qScale
 };
 const params=model.params.map(p=>{
   if(!(p.name in factor))return {...p};
   const scale=factor[p.name],lower=1e-9*scale,upper=1e5*scale;
   if(!(lower>0&&upper>lower&&Number.isFinite(upper)))throw Error("Rate-unit scaling outside supported floating point range.");
   return {...p,low:lower,high:upper};
 });
 return {...model,params,_physicalBounded:true};
}
export function prepareKinetic(model,data,options={}){
 if(data.length<Math.max(6,model.params.length+3))throw Error("Too few observations for "+model.label);
 if(data.some((r,i)=>!Number.isFinite(r.time)||!Number.isFinite(r.y)||r.y<0||
   (i>0&&r.time<=data[i-1].time)))throw Error("Times must be strictly increasing and loading nonnegative.");
 const origin=data[0].time,tScale=data.at(-1).time-origin;
 if(!(tScale>0))throw Error("Time span must be positive.");
 const qScale=Math.max(1e-8,...data.map(d=>d.y));
 const q0Fixed=options.q0Fixed??data[0].y;
 if(!Number.isFinite(q0Fixed)||q0Fixed<0)throw Error("Initial uptake must be finite and nonnegative.");
 const weighted=!!options.weighted;
 if(weighted&&data.some(d=>!(d.sigma>0)))throw Error("Weighted fit requires positive sigma.");
 const q0=q0Fixed/qScale;
 let forcing=null,qeFixed=null,metadata=null;
 if(model.id==="ldf"){
   if(options.equilibriumModel){
     const source=options.forcingRows||data;
     if(source[0].time>origin+1e-10)throw Error("Forcing must cover experiment start.");
     if(source.some(d=>!Number.isFinite(d.pressure)||d.pressure<0))throw Error("Imported-isotherm LDF needs pressure for every forcing sample.");
     const modelEq=options.equilibriumModel;
     if(modelEq.branch&&modelEq.branch!=="all"&&options.branch&&modelEq.branch!==options.branch)
       throw Error("Imported equilibrium branch differs from the requested kinetic adsorption/desorption branch.");
     const path=source.map(r=>({time:(r.time-origin)/tScale,equilibrium:modelEq.predict(r.pressure)/qScale}));
     if(path.some(d=>!Number.isFinite(d.equilibrium)||d.equilibrium<0))throw Error("Invalid q* from imported equilibrium model.");
     forcing=path;
     metadata={type:"imported_isotherm",model:modelEq.id,sourceUnits:modelEq.sourceUnits,
       interpolation:options.forcingInterpolation||"linear"};
   }else{
     const value=Number(options.qEquilibrium);
     if(!Number.isFinite(value)||value<0)throw Error("LDF requires a finite nonnegative fixed equilibrium uptake q*.");
     qeFixed=value/qScale;
     metadata={type:"fixed_equilibrium",value};
   }
 }
 function calculate(theta,times){
   const qInitial=model.params.some(p=>p.name==="q0")?theta.at(-1):q0;
   if(model.id==="ldf"&&forcing){
     return ldfTrajectory(times.map(t=>(t-origin)/tScale),forcing,qInitial,theta[0],0,options.forcingInterpolation||"linear").map(y=>y*qScale);
   }
   return times.map(time=>evaluateKinetic(model.id,theta,(time-origin)/tScale,qInitial,{equilibrium:qeFixed})*qScale);
 }
 return {origin,tScale,qScale,q0Fixed,weighted,forcing,metadata,calculate};
}
export function fitKinetic(rawModel,data,options={}){
 const state=prepareKinetic(rawModel,data,options);
 const model=physicalBoundKineticModel(rawModel,state.tScale,state.qScale),k=model.params.length,n=data.length;
 const optimizer=options.optimizer??"trls";
 if(!["trls","de_lbfgs","lbfgs","lm"].includes(optimizer))throw Error("Optimizer must be trls, de_lbfgs, lbfgs or lm.");
 const starts=clip(Math.floor(options.starts??8),1,24),maxIter=clip(Math.floor(options.maxIter??190),20,600);
 const seed=options.seed??20261023,random=rng(seed+model.id.length*367);
 const low=model.params.map(p=>Math.log(p.low)),high=model.params.map(p=>Math.log(p.high));
 const w=data.map(d=>state.weighted?1/d.sigma:1/state.qScale);
 const times=data.map(d=>d.time);
 const decode=z=>z.map((v,i)=>Math.exp(clip(v,low[i],high[i])));
 function residual(z){
   const values=state.calculate(decode(z),times);
   if(values.some(v=>!Number.isFinite(v)||v<0||v>1e30))return null;
   const r=values.map((v,i)=>(v-data[i].y)*w[i]);
   const cost=r.reduce((s,v)=>s+v*v,0);
   return Number.isFinite(cost)?{cost,r}:null;
 }
 function jac(z,base) {
   const j=Array.from({length:n},()=>Array(k).fill(0));
   for(let p=0;p<k;p++){
     const h=1e-4,plus=z.slice(),minus=z.slice();
     plus[p]=Math.min(high[p],z[p]+h);minus[p]=Math.max(low[p],z[p]-h);
     if(plus[p]===minus[p])return null;
     const a=residual(plus),b=residual(minus);
     if(!a||!b)return null;
     for(let i=0;i<n;i++)j[i][p]=(a.r[i]-b.r[i])/(plus[p]-minus[p]);
   }
   return j;
 }
 const objective=(z,gradient=false)=>{
   const base=residual(z);if(!base)return null;
   if(!gradient)return {cost:base.cost};
   const j=jac(z,base);if(!j)return null;
   const grad=Array(k).fill(0);
   for(let i=0;i<n;i++)for(let p=0;p<k;p++)grad[p]+=2*base.r[i]*j[i][p];
   return {cost:base.cost,grad};
 };

 // Estimate a physically meaningful rate from early transient data when
 // a resolvable fractional excursion exists. Avoid dependence on the
 // arbitrary final observation time.
 const qStart=data[0].y,peak=data.at(-1).y,excursion=peak-qStart;
 let rateEstimate=null;
 if(Math.abs(excursion)>1e-9*state.qScale){
   for(const d of data.slice(1)){
     const fraction=(d.y-qStart)/excursion,dt=d.time-state.origin;
     if(fraction>.03&&fraction<.9&&dt>0){
       rateEstimate=-Math.log1p(-fraction)/dt;
       if(rateEstimate>0&&Number.isFinite(rateEstimate))break;
     }
   }
 }
 const guessNormalized=name=>{
   if(name==="k1"||name==="kA"||name==="kLDF")return rateEstimate?rateEstimate*state.tScale:2;
   if(name==="k2")return rateEstimate?rateEstimate*state.tScale/Math.max(0.1,Math.abs(excursion)/state.qScale):2;
   return null;
 };
 let best=null,valid=0,converged=0,evaluations=0;
 for(let run=0;run<(optimizer==="de_lbfgs"?1:starts);run++){
   const z=model.params.map((p,i)=>{
     const base=guessNormalized(p.name);
     const guess=p.name==="q0"?clip(Math.max(1e-8,state.q0Fixed/state.qScale),p.low,p.high):(base??p.guess);
     return clip(Math.log(guess)+(run===0?0:(random()-.5)*6),low[i],high[i]);
   });
   if(optimizer==="lbfgs"||optimizer==="trls"||optimizer==="de_lbfgs"){
     const result=optimizer==="lbfgs"?
       minimizeProjectedLBFGS(objective,z,low,high,{maxIter,memory:7,gtol:1e-7}):
       optimizer==="trls"?
         minimizeBoundedTrustLS(residual,z,low,high,{maxIter,gtol:1e-7}):
         minimizeDELBFGS(objective,z,low,high,{seed:seed+41,maxIter,generations:options.deGenerations??55});
     evaluations+=result.evaluations??0;
     if(!Number.isFinite(result.cost))continue;
     valid++;if(result.converged)converged++;
     if(!best||result.cost<best.cost)best={...result};
     continue;
   }
   let base=residual(z),accepted=0,reason="no_descent";
   if(!base)continue;
   for(let it=0;it<maxIter;it++){
     const J=jac(z,base);if(!J)break;
     const H=Array.from({length:k},()=>Array(k).fill(0)),g=Array(k).fill(0);
     for(let i=0;i<n;i++)for(let p=0;p<k;p++){
       g[p]+=J[i][p]*base.r[i];
       for(let q=0;q<k;q++)H[p][q]+=J[i][p]*J[i][q];
     }
     if(Math.max(...g.map(Math.abs))<1e-8){reason="gradient_small";break;}
     let improvement=false;
     for(let trial=0;trial<12;trial++){
       const damp=Math.pow(4,trial)*.002;
       const mat=H.map((row,p)=>row.map((v,q)=>v+(p===q?damp*(H[p][p]+.001):0)));
       const step=normalEquations(mat,g.map(v=>-v));if(!step)continue;
       const next=z.map((v,p)=>clip(v+clip(step[p],-1.3,1.3),low[p],high[p]));
       const b=residual(next);
       if(b&&b.cost<base.cost-1e-14){z.splice(0,k,...next);base=b;accepted++;improvement=true;break;}
     }
     if(!improvement)break;
   }
   valid++;if(accepted>0)converged++;
   evaluations+=accepted;
   if(!best||base.cost<best.cost)best={z:z.slice(),cost:base.cost,accepted,reason,converged:null,projectedGradient:null,iterations:null};
 }
 if(!best)throw Error("All kinetic optimizations failed.");
 const params=decode(best.z),predicted=state.calculate(params,times);
 const mean=data.reduce((s,d)=>s+d.y,0)/n;
 const sse=data.reduce((s,d,i)=>s+sq(d.y-predicted[i]),0);
 const sumy=data.reduce((s,d)=>s+sq(d.y-mean),0);
 const rmse=Math.sqrt(sse/n),r2=sumy>0?1-sse/sumy:null;
 const aicc=!state.weighted&&n>k+1? n*Math.log(Math.max(sse/n,1e-28))+2*k+2*k*(k+1)/(n-k-1):null;
 const boundary=params.map((v,i)=>v<=model.params[i].low*1.002||v>=model.params[i].high*.998);
 const warnings=[];
 if(boundary.some(Boolean))warnings.push("One or more parameters reached optimization bounds.");
 if(optimizer!=="lm"&&best.converged===false)warnings.push("Best "+optimizer+" run not certified converged: "+best.reason);
 if(model.id==="diffusion")warnings.push("Weber–Morris sqrt(time) is a diagnostic, not a mass-transfer PDE or equilibrating kinetic mechanism.");
 if(model.id==="pso"&&options.branch==="desorption")warnings.push("PSO desorption uses an explicitly signed empirical extension.");
 if(model.id==="ldf"&&state.forcing)warnings.push("LDF uses "+(options.forcingInterpolation==="hold"?"zero-order hold":"linear")+" equilibrium uptake forcing; unresolved intersample pressure fluctuations are not represented.");
 if(model.id==="pfo")warnings.push("PFO and constant-equilibrium LDF are mathematically equivalent; do not count twice.");
 const result={id:model.id,label:model.label,kind:model.kind,formula:model.formula,
   paramNames:model.params.map(p=>p.name),params,physicalParameters:parameterPhysical(model.id,params,state.tScale,state.qScale),
   scale:{time:state.tScale,loading:state.qScale,origin:state.origin},initial:{q0:state.q0Fixed,fit:!!options.q0Fit},
   equilibrium:state.metadata,metrics:{n,k,rmse,r2,sse,aicc,weighted:state.weighted},
   convergence:{algorithm:optimizer,seed,starts:optimizer==="de_lbfgs"?1:starts,valid,converged,evaluations,accepted:best.accepted??null,
     reason:best.reason,projectedGradient:best.projectedGradient??null},
   observed:data.map((d,i)=>({time:d.time,y:d.y,predicted:predicted[i],residual:d.y-predicted[i]})),
   boundary,warnings,model,
   predict:(timesToPredict)=>state.calculate(params,timesToPredict),
   predictionAt:t=>state.calculate(params,[t])[0]
 };
 return result;
}
export function kineticCsv(fit){return "time,observed,model,residual\n"+fit.observed.map(r=>[r.time,r.y,r.predicted,r.residual].join(",")).join("\n")+"\n";}
