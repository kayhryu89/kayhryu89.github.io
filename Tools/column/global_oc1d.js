/* One-domain Legendre–Gauss–Lobatto GLOBAL orthogonal collocation.
 * No finite elements. Spectral nodal weak/SBP formulation of 1D convection
 * and diffusion, conservative Danckwerts total-flux inlet/outflow.
 * Transport backward Euler with pivoted dense LU cached for uniform time grid.
 * Local LDF backward Euler, identical time stepping to FV-BE comparator.
 *
 * Sharp adsorption fronts may not be spectrally resolved and may require
 * conservative global bounds correction. Always check correction diagnostics,
 * spatial refinement and timestep refinement; spectral speed is not assumed.
 */
import {normalizeColumnConfig,localExchange} from "./solver.js";
import {createEquilibrium} from "./constitutive.js";
import {comparisonTimeGrid} from "./comparison-time.js";
function legendre(n,x){
 if(n===0)return 1;
 let a=1,b=x;
 for(let k=2;k<=n;k++){const c=((2*k-1)*x*b-(k-1)*a)/k;a=b;b=c;}
 return b;
}
export function globalLglNodes(n,length=1){
 if(!Number.isInteger(n)||n<4||n>80)
  throw Error("Global OC requires 4–80 nodes. Check spatial convergence of sharp fronts.");
 if(!(Number.isFinite(length)&&length>0))throw Error("Global OC length must be positive.");
 const m=n-1,x=new Float64Array(n),p=new Float64Array(n),
   w=new Float64Array(n),D=Array.from({length:n},()=>new Float64Array(n));
 x[0]=-1;x[m]=1;
 for(let j=1;j<m;j++){
  let node=-Math.cos(Math.PI*j/m),converged=false;
  for(let iter=0;iter<100;iter++){
   const pm=legendre(m,node),pm1=legendre(m-1,node);
   const der=m*(node*pm-pm1)/(node*node-1);
   const der2=(2*node*der-m*(m+1)*pm)/(1-node*node);
   const shift=der/der2;
   node-=shift;
   if(Math.abs(shift)<5e-14){converged=true;break;}
  }
  if(!converged||!(node>x[j-1]&&node<1))
   throw Error("Global LGL polynomial root failed to converge monotonically.");
  x[j]=node;
 }
 for(let i=0;i<n;i++){
  p[i]=legendre(m,x[i]);w[i]=length/(m*(m+1)*p[i]*p[i]);
  if(!(Number.isFinite(w[i])&&w[i]>0))throw Error("Invalid global LGL quadrature weight.");
 }
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){
  if(i===j)D[i][j]=i===0?-m*(m+1)/(2*length):
   i===m?m*(m+1)/(2*length):0;
  else D[i][j]=2/length*p[i]/(p[j]*(x[i]-x[j]));
 }
 return {nodes:Array.from(x,xi=>length*(xi+1)/2),weights:w,D,domain:[0,length],degree:m};
}
function assemble(n,L,eps,u,disp){
 const lgl=globalLglNodes(n,L),{weights:w,D}=lgl,mat=new Float64Array(n*n);
 // SBP weak conservative form: + integral u*c*v_z - integral eps*Dz*c_z*v_z
 // inlet boundary + u*Cin*v(0), convective outlet -u*Cout*v(L)
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){
  let diffusion=0;
  for(let k=0;k<n;k++)diffusion+=w[k]*D[k][i]*D[k][j];
  mat[i*n+j]=u*w[j]*D[j][i]-eps*disp*diffusion;
 }
 mat[(n-1)*n+n-1]-=u;
 return {...lgl,n,mat};
}
function factorizeTransport(asm,eps,dt){
 const {n,weights:w,mat:A}=asm,M=new Float64Array(n*n);
 for(let i=0;i<n;i++)for(let j=0;j<n;j++)
  M[i*n+j]=(i===j?eps*w[i]:0)-dt*A[i*n+j];
 const swaps=new Int32Array(n);
 for(let k=0;k<n;k++){
  let row=k,largest=Math.abs(M[k*n+k]);
  for(let r=k+1;r<n;r++){const v=Math.abs(M[r*n+k]);if(v>largest){row=r;largest=v;}}
  if(!Number.isFinite(largest)||largest<1e-24)
   throw Error("Global OC transport matrix ill-conditioned: reduce polynomial degree / refine time step.");
  swaps[k]=row;
  if(row!==k)for(let j=0;j<n;j++){
   const old=M[k*n+j];M[k*n+j]=M[row*n+j];M[row*n+j]=old;
  }
  for(let i=k+1;i<n;i++){
   const f=M[i*n+k]/M[k*n+k];M[i*n+k]=f;
   for(let j=k+1;j<n;j++)M[i*n+j]-=f*M[k*n+j];
  }
 }
 return rhs=>{
  const x=Float64Array.from(rhs);
  for(let k=0;k<n;k++){
   const j=swaps[k];if(k!==j){const temp=x[k];x[k]=x[j];x[j]=temp;}
  }
  for(let i=0;i<n;i++)for(let j=0;j<i;j++)x[i]-=M[i*n+j]*x[j];
  for(let i=n-1;i>=0;i--){
   for(let j=i+1;j<n;j++)x[i]-=M[i*n+j]*x[j];
   x[i]/=M[i*n+i];
  }
  return x;
 };
}
function correctBounds(raw,oldC,asm,eps,u,dt,cin){
 const {n,weights:w}=asm,cap=Math.max(0,cin,...oldC);
 const target=eps*oldC.reduce((a,v,j)=>a+w[j]*v,0)+dt*u*cin;
 const mass=(arr)=>eps*arr.reduce((a,v,j)=>a+w[j]*v,0)+dt*u*arr[n-1];
 const scale=Math.max(1,Math.abs(target));
 const residual=mass(raw)-target;
 if(raw.every(v=>Number.isFinite(v)&&v>=0&&v<=cap)&&Math.abs(residual)<1e-10*scale)
  return {c:raw,limited:false,maximumCorrection:0};
 if(raw.some(v=>!Number.isFinite(v)))throw Error("Global OC unbounded transport produced nonfinite concentration.");
 const clip=(v,shift)=>Math.min(cap,Math.max(0,v+shift));
 const f=shift=>{
  let sm=0;for(let i=0;i<n;i++)sm+=w[i]*clip(raw[i],shift);
  return eps*sm+dt*u*clip(raw[n-1],shift)-target;
 };
 let lo=-Math.max(...raw)-cap,hi=cap-Math.min(...raw);
 if(f(lo)>1e-9*scale||f(hi)<-1e-9*scale)
  throw Error("Global OC mass-preserving limiter cannot satisfy flux balance.");
 for(let i=0;i<64;i++){
  const mid=(lo+hi)/2;if(f(mid)>0)hi=mid;else lo=mid;
 }
 const shift=(lo+hi)/2,c=Float64Array.from(raw,v=>clip(v,shift));
 let maximumCorrection=0;
 for(let i=0;i<n;i++)maximumCorrection=Math.max(maximumCorrection,Math.abs(raw[i]-c[i]));
 if(Math.abs(mass(c)-target)>3e-9*scale)
  throw Error("Global OC positivity limiter residual exceeds tolerance.");
 return {c,limited:true,maximumCorrection};
}
export async function simulateGlobalOc1D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw);
 if(cfg.thermal.enabled)throw Error("Global 1D OC supports isothermal adsorption only; select 2D FV for heat transfer.");
 if(cfg.grid.nr!==1||cfg.flow.inletAmplitude!==0||cfg.flow.velocityAmplitude!==0)
  throw Error("Global 1D OC requires nr=1 and uniform radial inlet/velocity.");
 const {nz:n}=cfg.grid,{length:L,radius:R}=cfg.geometry;
 if(n>80)throw Error("Global OC supports at most 80 spatial nodes.");
 const {porosity:eps,particleDensity:rho}=cfg.bed;
 const {superficialVelocity:u,axialDispersion:Dz}=cfg.flow;
 const {feedConcentration:cin,initialConcentration:cinit,temperatureK:T,direction}=cfg.gas;
 const {initialLoading:qinit,rateConstant:k,equilibrium}=cfg.adsorption;
 const alpha=(1-eps)*rho,area=Math.PI*R*R;
 const grid=comparisonTimeGrid(cfg),asm=assemble(n,L,eps,u,Dz),advance=factorizeTransport(asm,eps,grid.dt);
 const eq=createEquilibrium(equilibrium,T,{branch:direction,maxConcentration:Math.max(1,cin,cinit+alpha*qinit/eps)});
 let c=new Float64Array(n).fill(cinit),q=new Float64Array(n).fill(qinit);
 let time=0,input=0,output=0,steps=0,limitedSteps=0,maxCorrection=0;
 const massOf=(C,Q)=>area*C.reduce((a,v,i)=>a+asm.weights[i]*(eps*v+alpha*Q[i]),0);
 const mass0=massOf(c,q),samples=[],snapshots=[];
 const addSample=index=>{
  const inventory=massOf(c,q),res=inventory-mass0-input+output;
  samples.push({time,outlet:c[n-1],outletFraction:cin>0?c[n-1]/cin:0,inventory,
   relativeMassResidual:res/Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output)),
   inletMoles:input,outletMoles:output});
  if(index%(grid.outputIntervals/cfg.simulation.snapshots)===0)
   snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),
    axialMean:Array.from(c),radialOutlet:[c[n-1]]});
 };
 addSample(0);
 for(let i=1;i<=grid.outputIntervals;i++){
  for(let sub=0;sub<grid.stepsPerOutput;sub++){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   if(++steps>cfg.simulation.maxSteps)throw Error("Global OC step limit exceeded.");
   const rhs=Float64Array.from(c,(ci,j)=>eps*asm.weights[j]*ci+(j===0?grid.dt*u*cin:0));
   const rawC=advance(rhs),transport=correctBounds(rawC,c,asm,eps,u,grid.dt,cin);
   if(transport.limited){limitedSteps++;maxCorrection=Math.max(maxCorrection,transport.maximumCorrection);}
   const gas=transport.c,outletTransport=gas[n-1],newQ=new Float64Array(n);
   for(let j=0;j<n;j++){
    const [cc,qq]=localExchange(gas[j],q[j],grid.dt,eps,alpha,k,eq);
    gas[j]=cc;newQ[j]=qq;
   }
   input+=grid.dt*u*cin*area;
   output+=grid.dt*u*outletTransport*area;
   c=gas;q=newQ;time=steps*grid.dt;
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time,steps,percent:100*steps/grid.totalSteps});
  }
  time=i*grid.stepsPerOutput*grid.dt;addSample(i);
 }
 const inventory=massOf(c,q),res=inventory-mass0-input+output;
 return {schemaVersion:"1.0",engine:"1D GLOBAL LGL orthogonal collocation + BE transport/LDF (no finite elements)",
  config:cfg,
  grid:{nz:n,nr:1,length:L,radius:R,zCenters:asm.nodes,rCenters:[0],
   coordinate:"Global LGL nonuniform nodes",degree:asm.degree,globalOc:true},
  equilibrium:{label:eq.label,source:eq.source},
  statistics:{steps,dt:grid.dt,timeIntegrator:grid.description,
   initialMoles:mass0,finalMoles:inventory,inletMoles:input,outletMoles:output,
   absoluteMassResidual:res,relativeMassResidual:res/Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output)),
   maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual))),
   minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:u,
   limiterSteps:limitedSteps,limiterFraction:steps?limitedSteps/steps:0,
   maxLimiterCorrection:maxCorrection},samples,snapshots};
}
