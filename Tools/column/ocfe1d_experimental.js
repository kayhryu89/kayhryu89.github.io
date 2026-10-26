/* EXPERIMENTAL: 1D quadratic Gauss–Lobatto OCFE, nodal lumped mass.
   Weak conservative axial transport; positivity/bound preservation uses a
   global (not element-local) mass-conserving projection. Validate grid
   and time-step convergence; do not assume high-order sharp-front accuracy. */
import {normalizeColumnConfig} from './solver.js';
import {createEquilibrium} from './constitutive.js';
import {comparisonTimeGrid} from './comparison-time.js';
const D=[[-3,4,-1],[-1,0,1],[1,-4,3]],w=[1/6,4/6,1/6];
function assemble(nz,length,u,eps,Dz){
 const n=2*nz+1,h=length/nz,weight=new Float64Array(n);
 const A={diag:new Float64Array(n),lower1:new Float64Array(n),lower2:new Float64Array(n),
   upper1:new Float64Array(n),upper2:new Float64Array(n)};
 for(let e=0;e<nz;e++){
  for(let i=0;i<3;i++)weight[2*e+i]+=h*w[i];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){
   let stiff=0;for(let k=0;k<3;k++)stiff+=w[k]*D[k][i]*D[k][j];
   const row=2*e+i,col=2*e+j,value=u*w[j]*D[j][i]-eps*Dz*stiff/h;
   const d=col-row;
   if(d===0)A.diag[row]+=value;
   else if(d===1)A.upper1[row]+=value;
   else if(d===2)A.upper2[row]+=value;
   else if(d===-1)A.lower1[row]+=value;
   else if(d===-2)A.lower2[row]+=value;
   else throw Error("OCFE bandwidth exceeded.");
  }
 }
 A.diag[n-1]-=u;
 return {n,h,weight,matrix:A};
}
/* Block-local quadratic assembly implies half-bandwidth 2.
   Precompute and reuse compact LU for every shared constant BE time step.
   No dense per-step cloning or repeated factorization. */
function factorTransport(asm,dt,eps){
 const {n,weight,matrix:A}=asm,lower1=new Float64Array(n),lower2=new Float64Array(n),
   diag=new Float64Array(n),upper1=new Float64Array(n),upper2=new Float64Array(n);
 for(let i=0;i<n;i++){
  diag[i]=eps*weight[i]-dt*A.diag[i];
  if(i>0)lower1[i]=-dt*A.lower1[i];
  if(i>1)lower2[i]=-dt*A.lower2[i];
  if(i+1<n)upper1[i]=-dt*A.upper1[i];
  if(i+2<n)upper2[i]=-dt*A.upper2[i];
 }
 for(let k=0;k<n;k++){
  const pivot=diag[k];
  if(!Number.isFinite(pivot)||Math.abs(pivot)<1e-26)
    throw Error("OCFE banded BE matrix singular; refine mesh or review coefficients.");
  if(k+1<n){
   const factor=lower1[k+1]/pivot;lower1[k+1]=factor;
   diag[k+1]-=factor*upper1[k];
   upper1[k+1]-=factor*upper2[k];
  }
  if(k+2<n){
   const factor=lower2[k+2]/pivot;lower2[k+2]=factor;
   lower1[k+2]-=factor*upper1[k];
   diag[k+2]-=factor*upper2[k];
  }
 }
 return rhs=>{
  const x=Float64Array.from(rhs);
  for(let i=0;i<n;i++){
    if(i>0)x[i]-=lower1[i]*x[i-1];
    if(i>1)x[i]-=lower2[i]*x[i-2];
  }
  for(let i=n-1;i>=0;i--){
   if(i+1<n)x[i]-=upper1[i]*x[i+1];
   if(i+2<n)x[i]-=upper2[i]*x[i+2];
   x[i]/=diag[i];
  }
  return x;
 };
}
function localExchange(c0,q0,dt,eps,alpha,k,eq){
 const kt=k*dt;if(kt===0)return [c0,q0];
 const beta=kt/(1+kt),mass=eps*c0+alpha*q0;
 let lo=0,hi=mass/eps,c=Math.max(0,Math.min(hi,c0));
 for(let i=0;i<65;i++){
  const f=eps*(c-c0)+alpha*beta*(eq.qStar(c)-q0);
  if(Math.abs(f)<1e-14*Math.max(1e-7,mass)||hi-lo<1e-13*Math.max(1e-6,hi))
    return [c,(mass-eps*c)/alpha];
  if(f>0)hi=c;else lo=c;
  const slope=eps+alpha*beta*eq.dqStar(c),trial=c-f/slope;
  c=Number.isFinite(trial)&&trial>lo&&trial<hi?trial:(lo+hi)/2;
 }
 throw Error('OCFE LDF local nonlinear solve failed.');
}
function solveStep(oldC,oldQ,dt,eps,alpha,k,eq,asm,u,cfeed,advance){
 const {n,weight}=asm;
 const rhs=Float64Array.from(oldC,(c,i)=>weight[i]*eps*c+(i===0?dt*u*cfeed:0));
 const cTransport=advance(rhs);
 if(cTransport.some(x=>!Number.isFinite(x)))throw Error('Nonfinite OCFE transport solution.');
 // Bound-preserving globally conservative mass projection; NOT locally conservative at element interfaces.
 const cap=Math.max(cfeed,...oldC);
 const raw=Float64Array.from(cTransport),target=eps*weight.reduce((s,w,i)=>s+w*oldC[i],0)+dt*u*cfeed;
 const clip=(c)=>Math.min(cap,Math.max(0,c));
 const balance=(shift)=>eps*weight.reduce((s,w,i)=>s+w*clip(raw[i]+shift),0)+dt*u*clip(raw[n-1]+shift)-target;
 let lo=-Math.max(...raw)-cap,hi=cap-Math.min(...raw);
 for(let step=0;step<64;step++){
    const mid=(lo+hi)/2;
    if(balance(mid)>0)hi=mid;else lo=mid;
 }
 const shift=(lo+hi)/2;
 const limited=raw.some(x=>x<0||x>cap);
 for(let i=0;i<n;i++)cTransport[i]=clip(raw[i]+shift);
 const out=Float64Array.from(cTransport),nextQ=new Float64Array(n);
 for(let i=0;i<n;i++){
   const [cc,qq]=localExchange(cTransport[i],oldQ[i],dt,eps,alpha,k,eq);
   out[i]=cc;nextQ[i]=qq;
 }
 return {c:out,q:nextQ,outletTransport:cTransport[n-1],limited};
}
export async function simulateOcfe1D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw);
 if(cfg.thermal.enabled)throw Error("Non-isothermal OCFE is not implemented; use 2D thermal FVM.");
 if(cfg.grid.nr!==1||cfg.flow.inletAmplitude!==0||cfg.flow.velocityAmplitude!==0)
  throw Error('1D OCFE requires nr=1 and uniform inlet/velocity (radial amplitudes zero).');
 const nz=cfg.grid.nz,eps=cfg.bed.porosity,alpha=(1-eps)*cfg.bed.particleDensity,
   length=cfg.geometry.length,radius=cfg.geometry.radius,area=Math.PI*radius*radius;
 const u=cfg.flow.superficialVelocity,Dz=cfg.flow.axialDispersion,
   cfeed=cfg.gas.feedConcentration,cinit=cfg.gas.initialConcentration,
   qinit=cfg.adsorption.initialLoading,k=cfg.adsorption.rateConstant;
 const asm=assemble(nz,length,u,eps,Dz),n=asm.n;
 const eq=createEquilibrium(cfg.adsorption.equilibrium,cfg.gas.temperatureK,{branch:cfg.gas.direction,
   maxConcentration:Math.max(1,cfeed,cinit+alpha*qinit/eps)});
 let c=new Float64Array(n).fill(cinit),q=new Float64Array(n).fill(qinit),t=0,input=0,output=0,steps=0;
 const total=(c,q)=>area*asm.weight.reduce((s,v,i)=>s+v*(eps*c[i]+alpha*q[i]),0);
 const init=total(c,q),samples=[],snapshots=[];
 const {outputIntervals:intervalCount,totalSteps,stepsPerOutput,dt,description}=comparisonTimeGrid(cfg);
 const advance=factorTransport(asm,dt,eps),end=cfg.simulation.endTime;
 const add=(idx)=>{
  const inv=total(c,q),r=(inv-init-input+output)/Math.max(1e-12,Math.abs(init)+Math.abs(input)+Math.abs(output));
  samples.push({time:t,outlet:c[n-1],outletFraction:cfeed>0?c[n-1]/cfeed:0,inventory:inv,
     relativeMassResidual:r,inletMoles:input,outletMoles:output});
  if(idx%(intervalCount/cfg.simulation.snapshots)===0)snapshots.push({time:t,
      concentration:Array.from(c),loading:Array.from(q),axialMean:Array.from(c),radialOutlet:[c[n-1]]});
 };
 add(0);
 for(let idx=1;idx<=intervalCount;idx++){
  for(let sub=0;sub<stepsPerOutput;sub++){
   if(shouldAbort?.())throw Error('Simulation cancelled.');
   if(++steps>cfg.simulation.maxSteps)throw Error('OCFE step limit exceeded.');
   const trial=solveStep(c,q,dt,eps,alpha,k,eq,asm,u,cfeed,advance);
   if(trial.c.some(x=>!(Number.isFinite(x)&&x>=0))||trial.q.some(x=>!(Number.isFinite(x)&&x>=0)))
     throw Error('OCFE positivity violation.');
   input+=dt*u*cfeed*area;
   output+=dt*u*trial.outletTransport*area;
   c=trial.c;q=trial.q;
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time:steps*dt,steps,percent:100*steps/totalSteps});
  }
  t=idx*stepsPerOutput*dt;add(idx);
 }
 const final=total(c,q),absoluteMassResidual=final-init-input+output;
 return {schemaVersion:'1.0',engine:'1D quadratic GLL OCFE + conservative positivity-corrected splitting (experimental)',config:cfg,
   grid:{nz:n,nr:1,length,radius,zCenters:Array.from({length:n},(_,i)=>length*i/(n-1)),rCenters:[0],
     coordinate:'OCFE shared quadratic GLL nodes',elements:nz,degree:2},equilibrium:{label:eq.label,source:eq.source},
   statistics:{steps,dt,timeIntegrator:description,initialMoles:init,finalMoles:final,inletMoles:input,outletMoles:output,absoluteMassResidual,
     relativeMassResidual:absoluteMassResidual/Math.max(1e-12,Math.abs(init)+Math.abs(input)+Math.abs(output)),
     minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:u,
     maxRelativeMassResidual:Math.max(...samples.map(x=>Math.abs(x.relativeMassResidual)))},samples,snapshots};
}