import {createEquilibrium,extractKineticRate,RGAS} from "./constitutive.js";

/* Axisymmetric, isothermal, dilute species:
   eps dc/dt + (1-eps)*rho_s dq/dt + d(u*c)/dz
     = eps*Dz*d2c/dz2 + (4*eps*Dr/R^2)*d/dx(x*dc/dx), x=(r/R)^2.
   Equal-area x rings; finite-volume axial+radial fluxes; closed wall/axis.
   LDF exchange solved implicitly, locally conservative in eps*c+alpha*q.
   No PE, pressure drop, thermal effects, competition or hydrodynamics. */
const num=(x,name,lo=0,hi=Infinity,inclusive=true)=>{
 const n=Number(x);
 if(!Number.isFinite(n)||(inclusive?n<lo:n<=lo)||n>hi)throw Error(name+" must be in "+(inclusive?"[":"(")+lo+", "+hi+"].");
 return n;
};
const boundedInt=(x,name,lo,hi)=>{
 const n=num(x,name,lo,hi);
 if(!Number.isInteger(n))throw Error(name+" must be an integer.");return n;
};
const geometric=(nz,nr,length,radius)=>{
 const dz=length/nz,dx=1/nr,area=Math.PI*radius*radius,volume=area*length/(nz*nr);
 return {dz,dx,area,volume,length,radius,nz,nr};
};
export function normalizeColumnConfig(raw){
 const g=raw?.geometry||{},b=raw?.bed||{},f=raw?.flow||{},gas=raw?.gas||{},a=raw?.adsorption||{},grid=raw?.grid||{},t=raw?.simulation||{};
 const length=num(g.length,"Bed length",1e-4,500),radius=num(g.radius,"Bed radius",1e-4,100);
 const porosity=num(b.porosity,"Bed porosity",1e-4,0.9999);
 const particleDensity=num(b.particleDensity,"Solid skeletal density",1,50000);
 const superficialVelocity=num(f.superficialVelocity,"Superficial velocity",0,50);
 const axialDispersion=num(f.axialDispersion,"Axial dispersion",0,5);
 const radialDispersion=num(f.radialDispersion,"Radial dispersion",0,5);
 const inletAmplitude=num(f.inletAmplitude??0,"Radial inlet composition amplitude",-.95,.95);
 const velocityAmplitude=num(f.velocityAmplitude??0,"Radial velocity amplitude",-.95,.95);
 const feedConcentration=num(gas.feedConcentration,"Feed concentration",0,1e5);
 const initialConcentration=num(gas.initialConcentration??0,"Initial gas concentration",0,1e5);
 const direction=String(gas.direction||"adsorption").toLowerCase();
 if(!["adsorption","desorption"].includes(direction))throw Error("Direction must be adsorption or desorption.");
 const temperatureK=num(gas.temperatureK??298.15,"Temperature",150,1500);
 const totalPressurePa=num(gas.totalPressurePa??101325,"Total gas pressure",1000,1e9);
 const initialLoading=num(a.initialLoading??0,"Initial solid loading",0,1e6);
 const rateConstant=a.kineticReport?extractKineticRate(a.kineticReport).rateConstant:num(a.rateConstant,"LDF rate k",0,1e7);
 const nz=boundedInt(grid.nz??40,"Axial cells",4,160),nr=boundedInt(grid.nr??8,"Radial rings",1,32);
 const endTime=num(t.endTime,"Simulation end time",1e-7,1e9);
 const snapshots=boundedInt(t.snapshots??8,"Snapshot intervals",2,20);
 const cfl=num(t.cfl??.75,"Explicit transport CFL",.05,.9);
 const maxSteps=boundedInt(t.maxSteps??150000,"Step limit",100,500000);
 const cMax=totalPressurePa/(RGAS*temperatureK);
 if(Math.max(feedConcentration*(1+Math.abs(inletAmplitude)),initialConcentration)>cMax*(1+1e-12))
   throw Error("Tracer concentration exceeds ideal-gas total concentration P/(RT).");
 if(nz*nr>3500)throw Error("Grid exceeds 3500 cells (interactive browser safety limit).");
 if(!a.equilibrium)throw Error("Select an equilibrium model.");
 return {geometry:{length,radius},bed:{porosity,particleDensity},
   flow:{superficialVelocity,axialDispersion,radialDispersion,inletAmplitude,velocityAmplitude},
   gas:{feedConcentration,initialConcentration,temperatureK,totalPressurePa,direction},
   adsorption:{initialLoading,rateConstant,equilibrium:a.equilibrium},
   grid:{nz,nr},simulation:{endTime,snapshots,cfl,maxSteps}};
}
export function transportTimeStep(cfg){
 const {nz,nr}=cfg.grid,{length,radius}=cfg.geometry,{porosity:eps}=cfg.bed;
 const {superficialVelocity:u,velocityAmplitude:vamp,axialDispersion:Dz,radialDispersion:Dr}=cfg.flow;
 const dz=length/nz,dx=1/nr,umax=u*(1+Math.abs(vamp));
 const axial=umax/dz+2*eps*Dz/(dz*dz);
 const radial=nr===1?0:eps*4*Dr/(radius*radius*dx*dx)*(2-1/nr);
 const den=axial+radial;
 return den>0?cfg.simulation.cfl*eps/den:cfg.simulation.endTime;
}
function localExchange(c0,q0,dt,eps,alpha,k,eq){
 const kt=k*dt;
 if(kt===0||alpha===0)return [c0,q0];
 const beta=kt/(1+kt),inventory=eps*c0+alpha*q0;
 let lo=0,hi=inventory/eps;
 // Eq. eps*(c-c0)+alpha*beta*(q*(c)-q0)=0 is monotone for admissible q*.
 let c=Math.min(hi,Math.max(0,c0));
 const tol=2e-12*Math.max(1,inventory);
 for(let i=0;i<48;i++){
   const star=eq.qStar(c),f=eps*(c-c0)+alpha*beta*(star-q0);
   if(Math.abs(f)<=tol||hi-lo<2e-13*Math.max(1,hi)){
     const q=(inventory-eps*c)/alpha;
     if(q< -2e-11*Math.max(1,q0))throw Error("Negative solid loading in local implicit LDF solve.");
     return [c,Math.max(0,q)];
   }
   if(f>0)hi=c;else lo=c;
   const fp=eps+alpha*beta*eq.dqStar(c);
   const trial=c-f/fp;
   c=Number.isFinite(trial)&&trial>lo&&trial<hi?trial:(lo+hi)/2;
 }
 throw Error("Local implicit LDF solve did not converge; reduce time step or review equilibrium model.");
}
function edgeInput(cfeed,amp,x){return cfeed*(1+amp*(2*x-1));}
function averageOutlet(c,nz,nr,u){let s=0;for(let j=0;j<nr;j++)s+=u[j]*c[(nz-1)*nr+j]/nr;return s;}
function inventoryOf(c,q,volume,eps,alpha){
 let sum=0;for(let p=0;p<c.length;p++)sum+=(eps*c[p]+alpha*q[p])*volume;return sum;
}
export async function simulateColumn(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw),g=geometric(cfg.grid.nz,cfg.grid.nr,cfg.geometry.length,cfg.geometry.radius);
 const {nz,nr,dz,dx,area,volume,radius}=g,{porosity:eps,particleDensity:rho}=cfg.bed,alpha=(1-eps)*rho;
 const {superficialVelocity:u0,axialDispersion:Dz,radialDispersion:Dr,inletAmplitude:ain,velocityAmplitude:av}=cfg.flow;
 const {feedConcentration:cfeed,initialConcentration:cinit,temperatureK:T,direction}=cfg.gas;
 const {initialLoading:qinit,rateConstant:k,equilibrium:equilibriumSpec}=cfg.adsorption;
 const maxC=Math.max(cfeed*(1+Math.abs(ain)),cinit+(alpha/eps)*qinit,cfeed,1e-9);
 const eq=createEquilibrium(equilibriumSpec,T,{branch:direction,maxConcentration:maxC});
 const velocities=Float64Array.from({length:nr},(_,j)=>u0*(1+av*(2*(j+.5)/nr-1)));
 const inlets=Float64Array.from({length:nr},(_,j)=>edgeInput(cfeed,ain,(j+.5)/nr));
 let inputFlux=0,flowOut=0;
 for(let j=0;j<nr;j++){inputFlux+=velocities[j]*inlets[j]/nr;flowOut+=velocities[j]/nr;}
 let c=new Float64Array(nz*nr).fill(cinit),q=new Float64Array(nz*nr).fill(qinit);
 let input=0,output=0,time=0,steps=0;
 const mass0=inventoryOf(c,q,volume,eps,alpha);
 const dtCfl=transportTimeStep(cfg);
 const outputIntervals=cfg.simulation.snapshots*Math.max(8,Math.ceil(64/cfg.simulation.snapshots)),timeEnd=cfg.simulation.endTime;
 const samples=[],snapshots=[];
 const maxReportEvery=Math.max(1,Math.ceil(outputIntervals/24));
 const addSample=(index)=>{
   const inv=inventoryOf(c,q,volume,eps,alpha),balance=inv-mass0-input+output;
   const residual=balance/Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output));
   const outlet=averageOutlet(c,nz,nr,velocities);
   const fraction=flowOut>0?outlet/flowOut:0;
   const snapshot=index%(outputIntervals/cfg.simulation.snapshots)===0;
   samples.push({time,outlet:fraction,outletFraction:cfeed>0?fraction/cfeed:0,inventory:inv,
     relativeMassResidual:residual,inletMoles:input,outletMoles:output});
   if(snapshot){
     const mean=new Array(nz),radial=new Array(nr);
     for(let i=0;i<nz;i++){let sm=0;for(let j=0;j<nr;j++)sm+=c[i*nr+j];mean[i]=sm/nr;}
     for(let j=0;j<nr;j++)radial[j]=c[(nz-1)*nr+j];
     snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),axialMean:mean,radialOutlet:radial});
   }
 };
 addSample(0);
 // Conservative flux-divergence transport (first-order positivity preserving).
 let track=1;
 for(let targetIndex=1;targetIndex<=outputIntervals;targetIndex++){
   const target=timeEnd*targetIndex/outputIntervals;
   while(time<target-2e-14*Math.max(1,target)){
     if(shouldAbort?.())throw Error("Simulation cancelled.");
     if(++steps>cfg.simulation.maxSteps)throw Error("Step limit exceeded. Reduce grid, dispersion, duration or use a larger solver.");
     const dt=Math.min(dtCfl,target-time);
     if(!(dt>0))throw Error("Time step underflow.");
     const moved=new Float64Array(c.length);
     const radialCoeff=nr>1?4*Dr/(radius*radius*dx*dx):0;
     for(let i=0;i<nz;i++)for(let j=0;j<nr;j++){
       const idx=i*nr+j,ci=c[idx],uj=velocities[j];
       const left=i>0?c[idx-nr]:0,right=i+1<nz?c[idx+nr]:0;
       const fluxL=i===0?uj*inlets[j]:uj*left-eps*Dz*(ci-left)/dz;
       const fluxR=i===nz-1?uj*ci:uj*ci-eps*Dz*(right-ci)/dz;
       const radial=nr===1?0:radialCoeff*(
         (j+1<nr?(j+1)*dx*(c[idx+1]-ci):0)-
         (j>0?j*dx*(ci-c[idx-1]):0));
       const next=ci+dt*(-(fluxR-fluxL)/(eps*dz)+radial);
       if(!Number.isFinite(next)||next< -1e-11*Math.max(1,ci))
         throw Error("Transport positivity lost: review CFL and transport boundary conditions.");
       moved[idx]=Math.max(0,next);
     }
     const nextQ=new Float64Array(q.length);
     for(let idx=0;idx<moved.length;idx++){
       const [updatedC,updatedQ]=localExchange(moved[idx],q[idx],dt,eps,alpha,k,eq);
       moved[idx]=updatedC;nextQ[idx]=updatedQ;
     }
     input+=dt*area*inputFlux;
     output+=dt*area*averageOutlet(c,nz,nr,velocities);
     c=moved;q=nextQ;time+=dt;
     if(onProgress&&steps%Math.max(1,Math.round(200000/Math.max(1,nz*nr)))===0)onProgress({time,steps,percent:100*time/timeEnd});
     if(yieldTask&&steps%128===0)await yieldTask();
   }
   time=target;
   addSample(targetIndex);
 }
 const inv=inventoryOf(c,q,volume,eps,alpha),residual=inv-mass0-input+output;
 const relativeResidual=residual/Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output));
 const minGas=Math.min(...c),minLoading=Math.min(...q);
 return {schemaVersion:"1.0",engine:"Axisymmetric conservative FV + implicit local LDF",
   config:cfg,grid:{...g,coordinate:"x=(r/R)^2",rCenters:Array.from({length:nr},(_,j)=>radius*Math.sqrt((j+.5)/nr)),
     zCenters:Array.from({length:nz},(_,i)=>g.length*(i+.5)/nz)},
   equilibrium:{label:eq.label,source:eq.source},
   statistics:{steps,dtCfl,initialMoles:mass0,finalMoles:inv,inletMoles:input,outletMoles:output,
     absoluteMassResidual:residual,relativeMassResidual:relativeResidual,minConcentration:minGas,
     minLoading,meanVelocity:flowOut,maxRelativeMassResidual:Math.max(...samples.map(x=>Math.abs(x.relativeMassResidual)))},
   samples,snapshots};
}
