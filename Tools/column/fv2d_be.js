/* Conservative 2D axisymmetric FVM-BE comparator for true tensor 2D Global OC.
 * Same BE directional split: implicit axial convection/dispersion -> implicit
 * radial dispersion -> implicit cell-local LDF, with common time grid.
 * Uniform z FV cells and equal-area x=(r/R)^2 FV annular rings; no OC nodes.
 * Both linear tridiagonal systems are factorized once, then reused.
 * Production 2D FVM remains the original CFL-limited solver, unchanged.
 */
import {normalizeColumnConfig,localExchange} from "./solver.js";
import {createEquilibrium} from "./constitutive.js";
import {comparisonTimeGrid} from "./comparison-time.js";
function triFactor(lower,diag,upper){
 const n=diag.length,d=Float64Array.from(diag),l=Float64Array.from(lower),u=Float64Array.from(upper);
 for(let i=1;i<n;i++){l[i]/=d[i-1];d[i]-=l[i]*u[i-1];}
 for(const x of d)if(!(x>0&&Number.isFinite(x)))throw Error("2D FVM-BE factorization invalid.");
 return rhs=>{
  const x=Float64Array.from(rhs);
  for(let i=1;i<n;i++)x[i]-=l[i]*x[i-1];
  for(let i=n-1;i>=0;i--)x[i]=(x[i]-(i+1<n?u[i]*x[i+1]:0))/d[i];
  return x;
 };
}
export function buildFv2DBeOperators(cfg){
 const {grid:{nz,nr},geometry:{length:L,radius:R},bed:{porosity:eps},
  flow:{superficialVelocity:u0,velocityAmplitude:av,axialDispersion:Dz,radialDispersion:Dr,inletAmplitude:ain},
  gas:{feedConcentration:cin}}=cfg;
 const dz=L/nz,dx=1/nr,dt=comparisonTimeGrid(cfg).dt;
 const velocities=Float64Array.from({length:nr},(_,j)=>u0*(1+av*(2*(j+.5)/nr-1)));
 const inlet=Float64Array.from({length:nr},(_,j)=>cin*(1+ain*(2*(j+.5)/nr-1)));
 const zSolvers=[];
 const dispersion=eps*Dz/(dz*dz);
 for(let ir=0;ir<nr;ir++){
  const u=velocities[ir],lower=new Float64Array(nz),upper=new Float64Array(nz),diag=new Float64Array(nz);
  for(let iz=0;iz<nz;iz++){
   diag[iz]=eps+dt*(u/dz+(iz>0?dispersion:0)+(iz+1<nz?dispersion:0));
   if(iz>0)lower[iz]=-dt*(u/dz+dispersion);
   if(iz+1<nz)upper[iz]=-dt*dispersion;
  }
  zSolvers.push(triFactor(lower,diag,upper));
 }
 const radialCoeff=4*eps*Dr/(R*R*dx*dx);
 const rLower=new Float64Array(nr),rUpper=new Float64Array(nr),rDiag=new Float64Array(nr);
 for(let ir=0;ir<nr;ir++){
  // Equal-area x=(r/R)^2 ring faces are x_left=j*dx and x_right=(j+1)*dx.
  const left=ir>0?ir*dx:0,right=ir+1<nr?(ir+1)*dx:0;
  rDiag[ir]=eps+dt*radialCoeff*(left+right);
  if(ir>0)rLower[ir]=-dt*radialCoeff*left;
  if(ir+1<nr)rUpper[ir]=-dt*radialCoeff*right;
 }
 return {nz,nr,zSolvers,radialSolver:triFactor(rLower,rDiag,rUpper),velocities,inlet,
   inputFlux:velocities.reduce((s,v,j)=>s+v*inlet[j]/nr,0),averageFlow:velocities.reduce((s,v)=>s+v/nr,0),
   dz,dx,dt};
}
export async function simulateFvBe2D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const nx=Number(raw?.grid?.nz??40),ny=Number(raw?.grid?.nr??8);
 const reference=raw?.simulation?.referenceHighResolution===true;
 if(reference&&(!Number.isInteger(nx)||!Number.isInteger(ny)||nx<4||ny<1||nx>384||ny>48||nx*ny>12000))
  throw Error("2D FVM-BE reference mesh exceeds 384×48 or 12000 cells.");
 const validated=reference?{...raw,grid:{...raw.grid,nz:Math.min(100,nx),nr:Math.min(20,ny)}}:raw;
 const cfg=normalizeColumnConfig(validated);
 if(reference)cfg.grid={nz:nx,nr:ny};
 if(cfg.thermal.enabled)throw Error("Matched 2D FV-BE comparison is isothermal only; use 2D nonisothermal FVM.");
 const {geometry:{length:L,radius:R},bed:{porosity:eps,particleDensity:rho},
  gas:{feedConcentration:cin,initialConcentration:cinit,temperatureK:T,direction},
  adsorption:{initialLoading:qinit,rateConstant:k,equilibrium:spec},grid:{nz,nr}}=cfg;
 const alpha=(1-eps)*rho,area=Math.PI*R*R,dvol=area*L/(nz*nr),N=nz*nr;
 const op=buildFv2DBeOperators(cfg),timeGrid=comparisonTimeGrid(cfg),dt=op.dt;
 const eq=createEquilibrium(spec,T,{branch:direction,
  maxConcentration:Math.max(1,cin*(1+Math.abs(cfg.flow.inletAmplitude)),cinit+alpha*qinit/eps)});
 let c=new Float64Array(N).fill(cinit),q=new Float64Array(N).fill(qinit);
 let input=0,output=0,steps=0,time=0;
 const massOf=(C,Q)=>{let s=0;for(let p=0;p<N;p++)s+=eps*C[p]+alpha*Q[p];return s*dvol;};
 const initialMoles=massOf(c,q),samples=[],snapshots=[];
 const averageOutlet=C=>{
  let s=0;for(let j=0;j<nr;j++)s+=op.velocities[j]*C[(nz-1)*nr+j]/nr;
  return op.averageFlow>0?s/op.averageFlow:0;
 };
 const snapStep=timeGrid.outputIntervals/cfg.simulation.snapshots;
 const add=i=>{
  const inventory=massOf(c,q),res=inventory-initialMoles-input+output,outlet=averageOutlet(c);
  samples.push({time,outlet,outletFraction:cin>0?outlet/cin:0,inventory,
   relativeMassResidual:res/Math.max(1e-12,Math.abs(initialMoles)+Math.abs(input)+Math.abs(output)),
   inletMoles:input,outletMoles:output});
  if(i%snapStep===0){
   const axialMean=[],radialOutlet=[];
   for(let iz=0;iz<nz;iz++){let v=0;for(let ir=0;ir<nr;ir++)v+=c[iz*nr+ir]/nr;axialMean.push(v);}
   for(let ir=0;ir<nr;ir++)radialOutlet.push(c[(nz-1)*nr+ir]);
   snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),axialMean,radialOutlet});
  }
 };
 add(0);
 const zBuffer=new Float64Array(N),rBuffer=new Float64Array(N);
 const zRhs=new Float64Array(nz),rRhs=new Float64Array(nr);
 for(let i=1;i<=timeGrid.outputIntervals;i++){
  for(let sub=0;sub<timeGrid.stepsPerOutput;sub++){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   if(++steps>cfg.simulation.maxSteps)throw Error("Matched 2D FV-BE step limit exceeded.");
   let outletTransportFlux=0;
   for(let ir=0;ir<nr;ir++){
    const u=op.velocities[ir];
    for(let iz=0;iz<nz;iz++)
     zRhs[iz]=eps*c[iz*nr+ir]+(iz===0?dt*u*op.inlet[ir]/op.dz:0);
    const line=op.zSolvers[ir](zRhs);
    for(let iz=0;iz<nz;iz++)zBuffer[iz*nr+ir]=line[iz];
    outletTransportFlux+=u*line[nz-1]/nr;
   }
   for(let iz=0;iz<nz;iz++){
    for(let ir=0;ir<nr;ir++)rRhs[ir]=eps*zBuffer[iz*nr+ir];
    const line=op.radialSolver(rRhs);
    for(let ir=0;ir<nr;ir++)rBuffer[iz*nr+ir]=line[ir];
   }
   const nextQ=new Float64Array(N);
   for(let p=0;p<N;p++){
    if(!Number.isFinite(rBuffer[p])||rBuffer[p]<-1e-10)
     throw Error("2D implicit FV lost positivity unexpectedly.");
    const [cc,qq]=localExchange(Math.max(0,rBuffer[p]),q[p],dt,eps,alpha,k,eq);
    rBuffer[p]=cc;nextQ[p]=qq;
   }
   input+=dt*area*op.inputFlux;output+=dt*area*outletTransportFlux;
   c=Float64Array.from(rBuffer);q=nextQ;time=steps*dt;
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time,steps,percent:100*steps/timeGrid.totalSteps});
  }
  time=i*timeGrid.stepsPerOutput*dt;add(i);
 }
 const finalMoles=massOf(c,q),res=finalMoles-initialMoles-input+output;
 return {schemaVersion:"1.0",engine:"2D conservative FVM-BE (axial/radial implicit directional split + LDF)",
  config:cfg,grid:{nz,nr,length:L,radius:R,dx:op.dx,dz:op.dz,volume:dvol,area,
   coordinate:"2D FVM uniform z, equal-area x=(r/R)^2 rings",
   zCenters:Array.from({length:nz},(_,i)=>L*(i+.5)/nz),
   rCenters:Array.from({length:nr},(_,j)=>R*Math.sqrt((j+.5)/nr))},
  equilibrium:{label:eq.label,source:eq.source},
  statistics:{steps,dt,timeIntegrator:"BE axial → BE radial → BE local LDF, first-order directional Lie split",
   initialMoles,finalMoles,inletMoles:input,outletMoles:output,
   absoluteMassResidual:res,
   relativeMassResidual:res/Math.max(1e-12,Math.abs(initialMoles)+Math.abs(input)+Math.abs(output)),
   maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual))),
   minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:op.averageFlow,gridCells:N},
  samples,snapshots};
}
