/* TRUE 2D tensor-product single-domain Global Legendre–GLL orthogonal collocation.
 * Spectral nodal weak form, axial z in [0,L], equal-area radial x=(r/R)^2 in [0,1].
 * Cylindrical radial diffusion: (4 Dr/R^2) d_x(x d_x c).
 * Conservative natural (no-flux) radial boundaries at x=0 and x=1.
 *
 * Backward Euler transport split axially then radially (both implicit),
 * followed by locally conservative implicit Backward Euler LDF.  This first-order
 * directional Lie splitting is shared with matched 2D FVM-BE comparator.
 * Each 1D factorization is cached; no finite elements anywhere.
 *
 * Sharp fronts may oscillate; boundedness projection preserves global quadrature
 * inventory and reports maximum correction. It is not a local positivity theorem.
 */
import {normalizeColumnConfig,localExchange} from "./solver.js";
import {globalLglNodes} from "./global_oc1d.js";
import {createEquilibrium} from "./constitutive.js";
import {comparisonTimeGrid} from "./comparison-time.js";
export function luFactor(M,n){
 const a=Float64Array.from(M),swaps=new Int32Array(n);
 for(let k=0;k<n;k++){
  let p=k,pivot=Math.abs(a[k*n+k]);
  for(let i=k+1;i<n;i++){const v=Math.abs(a[i*n+k]);if(v>pivot){pivot=v;p=i;}}
  if(!Number.isFinite(pivot)||pivot<1e-24)
    throw Error("Global 2D OC implicit transport matrix is singular/ill-conditioned; review order and timestep.");
  swaps[k]=p;
  if(p!==k)for(let j=0;j<n;j++){let tmp=a[k*n+j];a[k*n+j]=a[p*n+j];a[p*n+j]=tmp;}
  for(let i=k+1;i<n;i++){
   const factor=a[i*n+k]/a[k*n+k];a[i*n+k]=factor;
   for(let j=k+1;j<n;j++)a[i*n+j]-=factor*a[k*n+j];
  }
 }
 return rhs=>{
  const x=Float64Array.from(rhs);
  for(let k=0;k<n;k++){const j=swaps[k];if(k!==j){let t=x[k];x[k]=x[j];x[j]=t;}}
  for(let i=0;i<n;i++)for(let j=0;j<i;j++)x[i]-=a[i*n+j]*x[j];
  for(let i=n-1;i>=0;i--){
   for(let j=i+1;j<n;j++)x[i]-=a[i*n+j]*x[j];
   x[i]/=a[i*n+i];
   if(!Number.isFinite(x[i]))throw Error("Global 2D OC linear solve produced nonfinite concentration.");
  }
  return x;
 };
}
export function stiffness(nodes,coordinateWeight=null){
 const {D,weights:w}=nodes,n=w.length,S=new Float64Array(n*n);
 for(let k=0;k<n;k++){
  const wk=w[k]*(coordinateWeight?coordinateWeight[k]:1);
  if(wk===0)continue;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++)S[i*n+j]+=wk*D[k][i]*D[k][j];
 }
 return S;
}
export function buildGlobalOc2DOperators(cfg){
 const nz=cfg.grid.nz,nr=cfg.grid.nr;
 if(nz<4||nz>80||nr<4||nr>16||nz*nr>800)
  throw Error("2D Global OC requires 4–80 axial LGL nodes, 4–16 radial LGL nodes, and at most 800 tensor nodes.");
 const {length:L,radius:R}=cfg.geometry,{porosity:eps}=cfg.bed;
 const {superficialVelocity:u0,velocityAmplitude:av,inletAmplitude:ain,
   axialDispersion:Dz,radialDispersion:Dr}=cfg.flow;
 const cin=cfg.gas.feedConcentration,dt=comparisonTimeGrid(cfg).dt;
 const z=globalLglNodes(nz,L),x=globalLglNodes(nr,1);
 const sZ=stiffness(z),sX=stiffness(x,x.nodes);
 const velocities=Float64Array.from(x.nodes,r=>u0*(1+av*(2*r-1)));
 const inlet=Float64Array.from(x.nodes,r=>cin*(1+ain*(2*r-1)));
 const zSolvers=[];
 for(let r=0;r<nr;r++){
  const u=velocities[r],A=new Float64Array(nz*nz);
  for(let i=0;i<nz;i++)for(let j=0;j<nz;j++){
   const weakAdvection=u*z.weights[j]*z.D[j][i],
     weakDiffusion=-eps*Dz*sZ[i*nz+j];
   const outlet=(i===nz-1&&j===nz-1)?-u:0;
   const op=weakAdvection+weakDiffusion+outlet;
   A[i*nz+j]=(i===j?eps*z.weights[i]:0)-dt*op;
  }
  zSolvers.push(luFactor(A,nz));
 }
 const radialA=new Float64Array(nr*nr),radialScale=4*eps*Dr/(R*R);
 for(let i=0;i<nr;i++)for(let j=0;j<nr;j++)
  radialA[i*nr+j]=(i===j?eps*x.weights[i]:0)+dt*radialScale*sX[i*nr+j];
 const radialSolver=luFactor(radialA,nr);
 const inputFlux=x.weights.reduce((s,w,j)=>s+w*velocities[j]*inlet[j],0);
 const averageFlow=x.weights.reduce((s,w,j)=>s+w*velocities[j],0);
 return {nz,nr,z,x,velocities,inlet,zSolvers,radialSolver,inputFlux,averageFlow,dt,
  axialWeakIdentity:"BE weak advection+diffusion with Danckwerts total-flux inlet/outflow",
  radialWeakIdentity:"BE weak x-weighted cylindrical diffusion; zero-flux axis and wall"};
}
export function boundedConservative(raw,previous,weights,cap){
 let min=Infinity,max=-Infinity;
 for(const value of raw){if(!Number.isFinite(value))throw Error("Global 2D OC produced a nonfinite gas concentration.");min=Math.min(min,value);max=Math.max(max,value);}
 if(min>=0&&max<=cap)return {values:raw,maxCorrection:0,corrected:false};
 let target=0,sumW=0;
 for(let i=0;i<raw.length;i++){target+=weights[i]*raw[i];sumW+=weights[i];}
 if(target< -1e-10*Math.max(1,Math.abs(target))||target>cap*sumW+1e-10*Math.max(1,target))
  throw Error("Global 2D OC positivity correction cannot reconcile mass and physical bounds.");
 const clip=(v,d)=>Math.min(cap,Math.max(0,v+d));
 const residual=d=>{let val=0;for(let i=0;i<raw.length;i++)val+=weights[i]*clip(raw[i],d);return val-target;};
 let lo=-Math.max(max,cap)-cap,hi=cap-min+cap;
 for(let iteration=0;iteration<65;iteration++){
  const mid=(lo+hi)/2;
  if(residual(mid)>0)hi=mid;else lo=mid;
 }
 const shift=(lo+hi)/2,values=new Float64Array(raw.length);
 let maxCorrection=0;
 for(let i=0;i<raw.length;i++){values[i]=clip(raw[i],shift);maxCorrection=Math.max(maxCorrection,Math.abs(values[i]-raw[i]));}
 if(Math.abs(residual(shift))>3e-9*Math.max(1,Math.abs(target)))
  throw Error("Global 2D OC conservative boundedness correction residual too large.");
 return {values,maxCorrection,corrected:true};
}
export async function simulateGlobalOc2D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw);
 if(cfg.thermal.enabled)throw Error("2D Global OC currently supports isothermal adsorption only; use 2D thermal FVM.");
 const {nz,nr}=cfg.grid;
 const op=buildGlobalOc2DOperators(cfg),timeGrid=comparisonTimeGrid(cfg);
 const {geometry:{length:L,radius:R},bed:{porosity:eps,particleDensity:rho},
  gas:{feedConcentration:cin,initialConcentration:cinit,temperatureK:T,direction},
  adsorption:{initialLoading:qinit,rateConstant:k,equilibrium:spec}}=cfg;
 const area=Math.PI*R*R,alpha=(1-eps)*rho,N=nz*nr,dt=op.dt;
 const maxC=Math.max(1,cin*(1+Math.abs(cfg.flow.inletAmplitude)),cinit+alpha*qinit/eps);
 const eq=createEquilibrium(spec,T,{branch:direction,maxConcentration:maxC});
 const weights=new Float64Array(N);
 for(let iz=0;iz<nz;iz++)for(let ir=0;ir<nr;ir++)
  weights[iz*nr+ir]=op.z.weights[iz]*op.x.weights[ir];
 const massOf=(cc,qq)=>{let s=0;for(let p=0;p<N;p++)s+=weights[p]*(eps*cc[p]+alpha*qq[p]);return area*s;};
 const averageOutlet=cc=>{
  let s=0;for(let ir=0;ir<nr;ir++)s+=op.x.weights[ir]*op.velocities[ir]*cc[(nz-1)*nr+ir];
  return op.averageFlow>0?s/op.averageFlow:0;
 };
 let c=new Float64Array(N).fill(cinit),q=new Float64Array(N).fill(qinit);
 let input=0,output=0,steps=0,time=0,correctedSteps=0,maxLimiterCorrection=0;
 const initialMoles=massOf(c,q),samples=[],snapshots=[];
 const snapshotStride=timeGrid.outputIntervals/cfg.simulation.snapshots;
 const addSample=i=>{
  const inventory=massOf(c,q),residual=inventory-initialMoles-input+output;
  const outlet=averageOutlet(c);
  samples.push({time,outlet,outletFraction:cin>0?outlet/cin:0,inventory,
    relativeMassResidual:residual/Math.max(1e-12,Math.abs(initialMoles)+Math.abs(input)+Math.abs(output)),
    inletMoles:input,outletMoles:output});
  if(i%snapshotStride===0){
   const axialMean=new Array(nz),radialOutlet=new Array(nr);
   for(let iz=0;iz<nz;iz++){
    let mean=0;for(let ir=0;ir<nr;ir++)mean+=op.x.weights[ir]*c[iz*nr+ir];
    axialMean[iz]=mean;
   }
   for(let ir=0;ir<nr;ir++)radialOutlet[ir]=c[(nz-1)*nr+ir];
   snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),axialMean,radialOutlet});
  }
 };
 addSample(0);
 const bufZ=new Float64Array(N),bufR=new Float64Array(N);
 const zRhs=new Float64Array(nz),rRhs=new Float64Array(nr);
 for(let tindex=1;tindex<=timeGrid.outputIntervals;tindex++){
  for(let sub=0;sub<timeGrid.stepsPerOutput;sub++){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   if(++steps>cfg.simulation.maxSteps)throw Error("2D Global OC step limit exceeded.");
   // BE axial per radial LGL node, with independent u(x) and cin(x).
   let outletFluxZ=0;
   for(let ir=0;ir<nr;ir++){
    for(let iz=0;iz<nz;iz++)zRhs[iz]=eps*op.z.weights[iz]*c[iz*nr+ir]+
      (iz===0?dt*op.velocities[ir]*op.inlet[ir]:0);
    const line=op.zSolvers[ir](zRhs);
    for(let iz=0;iz<nz;iz++)bufZ[iz*nr+ir]=line[iz];
    outletFluxZ+=op.x.weights[ir]*op.velocities[ir]*line[nz-1];
   }
   // BE radial independently per axial node; radial diffusion conserves weighted mass.
   for(let iz=0;iz<nz;iz++){
    for(let ir=0;ir<nr;ir++)rRhs[ir]=eps*op.x.weights[ir]*bufZ[iz*nr+ir];
    const line=op.radialSolver(rRhs);
    for(let ir=0;ir<nr;ir++)bufR[iz*nr+ir]=line[ir];
   }
   const cap=Math.max(1e-12,...op.inlet,...c);
   const bounded=boundedConservative(bufR,c,weights,cap);
   if(bounded.corrected){correctedSteps++;maxLimiterCorrection=Math.max(maxLimiterCorrection,bounded.maxCorrection);}
   const moved=bounded.values,nextQ=new Float64Array(N);
   for(let p=0;p<N;p++){
    const [cc,qq]=localExchange(moved[p],q[p],dt,eps,alpha,k,eq);
    moved[p]=cc;nextQ[p]=qq;
   }
   input+=dt*area*op.inputFlux;
   output+=dt*area*outletFluxZ;
   c=moved;q=nextQ;time=steps*dt;
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time,steps,percent:100*steps/timeGrid.totalSteps});
  }
  time=tindex*timeGrid.stepsPerOutput*dt;addSample(tindex);
 }
 const inv=massOf(c,q),residual=inv-initialMoles-input+output;
 return {schemaVersion:"1.0",engine:"2D GLOBAL tensor-product Legendre–GLL orthogonal collocation (z, x=(r/R)^2), BE directional transport + implicit LDF",
  config:cfg,grid:{nz,nr,length:L,radius:R,coordinate:"2D Global Legendre-GLL tensor nodes, z and x=(r/R)^2",
   zCenters:op.z.nodes,rCenters:op.x.nodes.map(x=>R*Math.sqrt(x)),
   xNodes:op.x.nodes,globalOc:true,globalOc2D:true,
   degreeZ:nz-1,degreeRadial:nr-1},
  equilibrium:{label:eq.label,source:eq.source},
  statistics:{steps,dt,timeIntegrator:"BE axial → BE radial → BE local LDF, first-order directional Lie split",
    initialMoles,finalMoles:inv,inletMoles:input,outletMoles:output,absoluteMassResidual:residual,
    relativeMassResidual:residual/Math.max(1e-12,Math.abs(initialMoles)+Math.abs(input)+Math.abs(output)),
    minConcentration:Math.min(...c),minLoading:Math.min(...q),
    meanVelocity:op.averageFlow,
    maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual))),
    limiterSteps:correctedSteps,limiterFraction:correctedSteps/Math.max(1,steps),
    maxLimiterCorrection,gridNodes:N},
  samples,snapshots};
}
