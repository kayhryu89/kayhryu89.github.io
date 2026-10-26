/* 1D benchmark FV: cell-average conservative FV spatial discretization.
   Identical BE transport → BE local LDF time grid as experimental OCFE.
   Retains the existing explicit 1D/2D production FV solver unchanged. */
import {normalizeColumnConfig,localExchange} from "./solver.js";
import {createEquilibrium} from "./constitutive.js";
import {comparisonTimeGrid} from "./comparison-time.js";
function factorTransport(n,dt,eps,u,dz,disp){
 const lower=new Float64Array(n),diag=new Float64Array(n),upper=new Float64Array(n),mult=new Float64Array(n);
 for(let i=0;i<n;i++){
  const edges=n===1?0:(i===0||i===n-1?1:2);
  diag[i]=eps+dt*(u/dz+edges*disp);
  if(i>0)lower[i]=-dt*(u/dz+disp);
  if(i+1<n)upper[i]=-dt*disp;
 }
 for(let i=1;i<n;i++){
  mult[i]=lower[i]/diag[i-1];
  diag[i]-=mult[i]*upper[i-1];
  if(!(diag[i]>0)&&Number.isFinite(diag[i]))throw Error("FV 1D implicit BE factorization invalid.");
 }
 return rhs=>{
  const x=Float64Array.from(rhs);
  for(let i=1;i<n;i++)x[i]-=mult[i]*x[i-1];
  for(let i=n-1;i>=0;i--)x[i]=(x[i]-(i+1<n?upper[i]*x[i+1]:0))/diag[i];
  return x;
 };
}
export async function simulateFvBe1D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const requestedCells=Number(raw?.grid?.nz??40);
 if(!Number.isInteger(requestedCells)||requestedCells<4||requestedCells>1024)
   throw Error("FVM-BE 1D comparison must use 4–1024 axial cells.");
 if(requestedCells>160&&!raw?.simulation?.referenceHighResolution)
   throw Error("Above 160 FVM cells is restricted to explicit referenceHighResolution benchmark mode.");
 const source=requestedCells>160?{
   ...raw,grid:{...raw.grid,nz:160}
 }:raw;
 const cfg=normalizeColumnConfig(source);
 if(requestedCells>160)cfg.grid.nz=requestedCells;
 if(cfg.thermal.enabled)throw Error("The matched 1D BE comparison currently supports isothermal cases only.");
 if(cfg.grid.nr!==1||cfg.flow.inletAmplitude!==0||cfg.flow.velocityAmplitude!==0)
  throw Error("Matched 1D FV-BE requires nr=1 and uniform radial inlet/velocity.");
 const {nz:n}=cfg.grid,{length:L,radius:R}=cfg.geometry;
 const {porosity:eps,particleDensity:rho}=cfg.bed;
 const {superficialVelocity:u,axialDispersion:Dz}=cfg.flow;
 const {feedConcentration:cfeed,initialConcentration:cinit,direction,temperatureK:T}=cfg.gas;
 const {initialLoading:qinit,rateConstant:k,equilibrium}=cfg.adsorption;
 const alpha=(1-eps)*rho,dx=L/n,area=Math.PI*R*R,dvol=area*dx;
 const disp=eps*Dz/(dx*dx);
 const eq=createEquilibrium(equilibrium,T,{branch:direction,maxConcentration:Math.max(1,cfeed,cinit+alpha*qinit/eps)});
 const grid=comparisonTimeGrid(cfg),advance=factorTransport(n,grid.dt,eps,u,dx,disp);
 let c=new Float64Array(n).fill(cinit),q=new Float64Array(n).fill(qinit),steps=0,input=0,output=0;
 const initialInventory=dvol*c.reduce((v,cc,i)=>v+eps*cc+alpha*q[i],0),snapshots=[],samples=[];
 const total=(C,Q)=>dvol*C.reduce((v,cc,i)=>v+eps*cc+alpha*Q[i],0);
 function addSample(t,i){
  const inventory=total(c,q),res=inventory-initialInventory-input+output;
  const relativeMassResidual=res/Math.max(1e-12,Math.abs(initialInventory)+Math.abs(input)+Math.abs(output));
  samples.push({time:t,outlet:c[n-1],outletFraction:cfeed>0?c[n-1]/cfeed:0,inventory,
   relativeMassResidual,inletMoles:input,outletMoles:output});
  if(i%(grid.outputIntervals/cfg.simulation.snapshots)===0){
   snapshots.push({time:t,concentration:Array.from(c),loading:Array.from(q),
     axialMean:Array.from(c),radialOutlet:[c[n-1]]});
  }
 }
 addSample(0,0);
 for(let i=1;i<=grid.outputIntervals;i++){
  for(let j=0;j<grid.stepsPerOutput;j++){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   const b=Float64Array.from(c,(ci,index)=>eps*ci+(index===0?grid.dt*u*cfeed/dx:0));
   const gas=advance(b);
   const nextQ=new Float64Array(n);
   for(let ii=0;ii<n;ii++){
    if(gas[ii]< -1e-11||!Number.isFinite(gas[ii]))throw Error("Implicit FV gas transport positivity failure.");
    const [cc,qq]=localExchange(Math.max(0,gas[ii]),q[ii],grid.dt,eps,alpha,k,eq);
    gas[ii]=cc;nextQ[ii]=qq;
   }
   // Lie-split transport balance uses pre-sorption outlet, like OCFE.
   // Reconstruct it from transport-plus-sorption-local inventory exactly:
   const transportedOut=(eps*gas[n-1]+alpha*nextQ[n-1]-alpha*q[n-1])/eps;
   input+=grid.dt*u*cfeed*area;
   output+=grid.dt*u*transportedOut*area;
   c=gas;q=nextQ;steps++;
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time:steps*grid.dt,steps,percent:100*steps/grid.totalSteps});
  }
  addSample(i*grid.stepsPerOutput*grid.dt,i);
 }
 const inv=total(c,q),residual=inv-initialInventory-input+output;
 return {schemaVersion:"1.0",engine:"1D FVM implicit BE transport + implicit BE LDF (matched time grid)",
  config:cfg,
  grid:{nz:n,nr:1,length:L,radius:R,dz:dx,dx:1,volume:dvol,area,coordinate:"1D FV cell centers",
   zCenters:Array.from({length:n},(_,i)=>L*(i+.5)/n),rCenters:[0]},
  equilibrium:{label:eq.label,source:eq.source},
  statistics:{steps,dtCfl:grid.dt,dt:grid.dt,timeIntegrator:grid.description,initialMoles:initialInventory,
    finalMoles:inv,inletMoles:input,outletMoles:output,absoluteMassResidual:residual,
    relativeMassResidual:residual/Math.max(1e-12,Math.abs(initialInventory)+Math.abs(input)+Math.abs(output)),
    minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:u,
    maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual)))},
  samples,snapshots};
}
