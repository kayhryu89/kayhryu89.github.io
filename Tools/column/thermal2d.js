/* 2D (z,x=(r/R)^2) conservative axisymmetric non-isothermal FVM.
   Local thermal equilibrium gas+solid; dilute inert carrier, prescribed constant u,P.
   Gas solute transport and sensible energy transport are explicit conservative FV;
   local exothermic LDF exchange is implicit and conserves species and reduced energy.
   Heat source = (1-eps)*rho_s*H_positive*dq/dt.
   No separate gas/solid temperatures, pressure drop, momentum or variable density.
*/
import {normalizeColumnConfig,transportTimeStep} from "./solver.js";
import {createEquilibrium,RGAS} from "./constitutive.js";

const pi=Math.PI;
const safe=(x,name)=>{if(!Number.isFinite(x))throw Error("Nonfinite "+name);return x;};
const ratio=(a,b)=>a/Math.max(1e-12,b);
export function thermalEquilibrium(spec,thermal,direction,maxC=10){
 const {referenceTemperatureK:reference,adsorptionHeatJmol:H,equilibriumTemperatureMode:mode}=thermal;
 const referenceEq=createEquilibrium(spec,reference,{branch:direction,maxConcentration:maxC});
 const star=(c,T)=>{
  if(!(c>=0&&Number.isFinite(c)&&T>=150&&T<=1500&&Number.isFinite(T)))
    throw Error("Temperature-dependent equilibrium evaluated outside nonnegative C / 150–1500 K range.");
  // Convert dynamic partial pressure p=c*R*T into reference-temperature equivalent concentration.
  // van't Hoff: ln(Kp(T)/Kp(Tref))=(H/R)*(1/T-1/Tref), H = -DeltaH >0.
  const exponent=mode==="vanthoff"?H/RGAS*(1/T-1/reference):0;
  if(exponent>80||exponent< -80)throw Error("Temperature equilibrium correction exponent outside stable range.");
  const cref=c*(T/reference)*Math.exp(exponent);
  return referenceEq.qStar(cref);
 };
 return {label:referenceEq.label,source:referenceEq.source,star};
}
export function thermalLocalExchange(c0,q0,T0,dt,eps,alpha,k0,Ce,thermal,eq){
 const {adsorptionHeatJmol:H,activationEnergyJmol:E,referenceTemperatureK:Tr}=thermal;
 if(k0===0)return [c0,q0,T0];
 const k=k0*Math.exp(-E/RGAS*(1/T0-1/Tr));
 if(!Number.isFinite(k))throw Error("Invalid temperature-corrected LDF rate.");
 const kt=dt*k,beta=kt/(1+kt);
 const mass=eps*c0+alpha*q0,hi=mass/alpha;
 // Enforce the admissible temperature interval without exploring physically
 // impossible q during the bracket search (important for strong desorption).
 const dTdq=alpha*H/Ce;
 const lowerBound=dTdq>0?Math.max(0,q0+(150-T0)/dTdq):0;
 const upperBound=dTdq>0?Math.min(hi,q0+(1500-T0)/dTdq):hi;
 if(lowerBound>upperBound)throw Error("No thermally admissible local adsorption state.");
 const phase=q=>{
  const c=Math.max(0,(mass-alpha*q)/eps);
  const T=T0+alpha*H*(q-q0)/Ce;
  if(T<150||T>1500)throw Error("Thermal LDF state outside 150–1500 K; reduce temperature rise or review heat capacity.");
  const f=q-q0-beta*(eq.star(c,T)-q0);
  return {c,T,f};
 };
 // Monotone for exothermic van't-Hoff adsorption with q*(p,T) decreasing in T at fixed partial pressure.
 let lo=lowerBound,upper=upperBound;
 const fLow=phase(lo).f,fUpper=phase(upper).f;
 if(fLow>1e-11||fUpper< -1e-11)
   throw Error("Implicit thermal LDF solution was not bracketed.");
 let q=Math.min(upper,Math.max(lo,q0));
 for(let i=0;i<62;i++){
  const at=phase(q);
  if(Math.abs(at.f)<2e-12*Math.max(1,hi)||upper-lo<1e-12*Math.max(1,hi)){
   return [at.c,q,at.T];
  }
  if(at.f>0)upper=q;else lo=q;
  q=(lo+upper)*.5;
 }
 throw Error("Thermal LDF implicit local solve failed.");
}
export function thermalTimeStep(raw){
 const cfg=normalizeColumnConfig(raw);
 if(!cfg.thermal.enabled)throw Error("Enable non-isothermal model to calculate thermal CFL.");
 const {thermal:h,bed,geometry,flow,grid,simulation}=cfg;
 const alpha=(1-bed.porosity)*bed.particleDensity;
 const Ce=bed.porosity*h.gasVolumetricHeatCapacityJm3K+alpha*h.solidHeatCapacityJkgK;
 const dz=geometry.length/grid.nz,dx=1/grid.nr,radius=geometry.radius;
 const adv=h.gasVolumetricHeatCapacityJm3K*flow.superficialVelocity*(1+Math.abs(flow.velocityAmplitude))/dz;
 const axial=2*h.conductivityAxialWmK/dz**2;
 const radial=grid.nr>1?4*h.conductivityRadialWmK/(radius**2*dx**2)*(2-1/grid.nr):0;
 const wall=2*h.wallHeatTransferWm2K/(radius*dx);
 const dT=adv+axial+radial+wall>0?simulation.cfl*Ce/(adv+axial+radial+wall):simulation.endTime;
 return Math.min(dT,transportTimeStep(cfg));
}
export async function simulateThermalColumn(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw);
 if(!cfg.thermal.enabled)throw Error("Thermal 2D FVM requires thermal.enabled=true.");
 const {geometry,bed,flow,gas,adsorption,grid,simulation,thermal:h}=cfg;
 const {nz,nr}=grid,{length:L,radius:R}=geometry,{porosity:eps,particleDensity:rho}=bed;
 const {superficialVelocity:u0,axialDispersion:Dz,radialDispersion:Dr,inletAmplitude:ain,velocityAmplitude:av}=flow;
 const {feedConcentration:cfeed,initialConcentration:cinit,temperatureK:Treference,direction}=gas;
 const {initialLoading:qinit,rateConstant:k,equilibrium:spec}=adsorption;
 const {initialTemperatureK:Tinit,feedTemperatureK:Tfeed,ambientTemperatureK:Tamb,
   gasVolumetricHeatCapacityJm3K:Cvg,solidHeatCapacityJkgK:Cps,
   conductivityAxialWmK:Lz,conductivityRadialWmK:Lr,wallHeatTransferWm2K:hw,
   adsorptionHeatJmol:H}=h;
 const alpha=(1-eps)*rho,Ce=eps*Cvg+alpha*Cps;
 const area=pi*R*R,dx=1/nr,dz=L/nz,volume=area*L/(nz*nr),numCells=nz*nr;
 const maxC=Math.max(1,cfeed*(1+Math.abs(ain)),cinit+alpha*qinit/eps,
   gas.totalPressurePa/(RGAS*150));
 const eq=thermalEquilibrium(spec,h,direction,maxC);
 const velocities=Float64Array.from({length:nr},(_,j)=>u0*(1+av*(2*(j+.5)/nr-1)));
 const inlets=Float64Array.from({length:nr},(_,j)=>cfeed*(1+ain*(2*(j+.5)/nr-1)));
 let inputFlux=0,flowOut=0;
 for(let j=0;j<nr;j++){inputFlux+=velocities[j]*inlets[j]/nr;flowOut+=velocities[j]/nr;}
 const wallH=hw>0?(nr===1||Lr===0?hw:1/(1/hw+(R-R*Math.sqrt((nr-.5)/nr))/Lr)):0;
 const wallCoeff=2*wallH/(R*dx),radialSpecies=nr>1?4*Dr/(R*R*dx*dx):0;
 const radialHeat=nr>1?4*Lr/(R*R*dx*dx):0;
 let c=new Float64Array(numCells).fill(cinit),q=new Float64Array(numCells).fill(qinit),
   T=new Float64Array(numCells).fill(Tinit);
 let input=0,output=0,energyInput=0,energyOutput=0,wallEnergy=0,time=0,steps=0;
 const massOf=(cc,qq)=>{let s=0;for(let i=0;i<numCells;i++)s+=eps*cc[i]+alpha*qq[i];return s*volume;};
 // Reduced energy uses initial bed T and initial q as reference: J = Ce*(T-Tinit)-alpha*H*(q-qinit).
 const energyOf=(tt,qq)=>{let s=0;for(let i=0;i<numCells;i++)s+=Ce*(tt[i]-Tinit)-alpha*H*(qq[i]-qinit);return s*volume;};
 const mass0=massOf(c,q),energy0=energyOf(T,q);
 const dtCfl=thermalTimeStep(cfg);
 const intervalCount=simulation.snapshots*Math.max(8,Math.ceil(64/simulation.snapshots)),end=simulation.endTime;
 const samples=[],snapshots=[];
 const averageOutlet=array=>{let s=0;for(let j=0;j<nr;j++)s+=velocities[j]*array[(nz-1)*nr+j]/nr;return flowOut>0?s/flowOut:s;};
 const snapshotInterval=intervalCount/simulation.snapshots;
 const sample=index=>{
  const inv=massOf(c,q),en=energyOf(T,q),o=averageOutlet(c),outletT=averageOutlet(T);
  const mr=inv-mass0-input+output,er=en-energy0-energyInput+energyOutput+wallEnergy;
  samples.push({time,outlet:o,outletFraction:cfeed>0?o/cfeed:0,
   outletTemperatureK:outletT,peakTemperatureK:Math.max(...T),minimumTemperatureK:Math.min(...T),
   inventory:inv,relativeMassResidual:ratio(mr,Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output))),
   energyJ:en,relativeEnergyResidual:ratio(er,Math.max(1,Math.abs(energyInput)+Math.abs(energyOutput)+Math.abs(wallEnergy)+
    Math.abs(alpha*H*(qinit)*volume))),
   heatWallJ:wallEnergy,inletMoles:input,outletMoles:output});
  if(index%snapshotInterval===0){
   const means=[],thermMeans=[],radial=[];
   for(let i=0;i<nz;i++){let cm=0,tm=0;for(let j=0;j<nr;j++){cm+=c[i*nr+j];tm+=T[i*nr+j];}
     means.push(cm/nr);thermMeans.push(tm/nr);}
   for(let j=0;j<nr;j++)radial.push(c[(nz-1)*nr+j]);
   snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),temperatureK:Array.from(T),
      axialMean:means,temperatureAxialMean:thermMeans,radialOutlet:radial});
  }
 };
 sample(0);
 for(let ti=1;ti<=intervalCount;ti++){
  const target=end*ti/intervalCount;
  while(time<target-2e-14*Math.max(1,target)){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   if(++steps>simulation.maxSteps)throw Error("Nonisothermal 2D FVM step limit exceeded.");
   const dt=Math.min(dtCfl,target-time);
   if(!(dt>0))throw Error("Nonisothermal time step underflow.");
   const moved=new Float64Array(numCells),thermalMove=new Float64Array(numCells);
   let thisWallPower=0;
   for(let i=0;i<nz;i++)for(let j=0;j<nr;j++){
    const idx=i*nr+j,ci=c[idx],temp=T[idx],uj=velocities[j];
    const cleft=i>0?c[idx-nr]:0,cright=i+1<nz?c[idx+nr]:0;
    const fLeft=i===0?uj*inlets[j]:uj*cleft-eps*Dz*(ci-cleft)/dz;
    const fRight=i===nz-1?uj*ci:uj*ci-eps*Dz*(cright-ci)/dz;
    const rMass=radialSpecies*((j+1<nr?(j+1)*dx*(c[idx+1]-ci):0)-
      (j>0?j*dx*(ci-c[idx-1]):0));
    const nextC=ci+dt*(-(fRight-fLeft)/(eps*dz)+rMass);
    if(!Number.isFinite(nextC)||nextC< -1e-10*Math.max(1,ci))
     throw Error("Nonisothermal gas FV positivity lost; check transport CFL.");
    moved[idx]=Math.max(0,nextC);
    const Tleft=i>0?T[idx-nr]:0,Tright=i+1<nz?T[idx+nr]:0;
    const heatLeft=i===0?uj*Cvg*Tfeed:uj*Cvg*Tleft-Lz*(temp-Tleft)/dz;
    const heatRight=i===nz-1?uj*Cvg*temp:uj*Cvg*temp-Lz*(Tright-temp)/dz;
    const rHeat=radialHeat*((j+1<nr?(j+1)*dx*(T[idx+1]-temp):0)-
      (j>0?j*dx*(temp-T[idx-1]):0));
    const wallSink=j===nr-1?wallCoeff*(temp-Tamb):0;
    thisWallPower+=wallSink*volume;
    const nextT=temp+dt*(-(heatRight-heatLeft)/dz+rHeat-wallSink)/Ce;
    if(!Number.isFinite(nextT)||nextT<150||nextT>1500)
     throw Error("Nonisothermal transport temperature outside 150–1500 K.");
    thermalMove[idx]=nextT;
   }
   const nextQ=new Float64Array(numCells);
   for(let idx=0;idx<numCells;idx++){
    const [cc,qq,tt]=thermalLocalExchange(moved[idx],q[idx],thermalMove[idx],dt,eps,alpha,k,Ce,h,eq);
    moved[idx]=cc;nextQ[idx]=qq;thermalMove[idx]=tt;
    if(cc< -1e-10||qq< -1e-10||tt<150||tt>1500)throw Error("Unphysical nonisothermal LDF state.");
    if(cc*RGAS*tt>gas.totalPressurePa*(1+1e-9))throw Error("Gas solute exceeds total ideal-gas concentration at heated state.");
   }
   input+=dt*area*inputFlux;
   let outMolFlux=0,heatOutFlux=0;
   for(let j=0;j<nr;j++){
     outMolFlux+=velocities[j]*c[(nz-1)*nr+j]/nr;
     heatOutFlux+=velocities[j]*Cvg*(T[(nz-1)*nr+j]-Tinit)/nr;
   }
   output+=dt*area*outMolFlux;
   energyInput+=dt*area*flowOut*Cvg*(Tfeed-Tinit);
   energyOutput+=dt*area*heatOutFlux;
   wallEnergy+=dt*thisWallPower;
   c=moved;q=nextQ;T=thermalMove;time+=dt;
   if(onProgress&&steps%Math.max(1,Math.round(200000/Math.max(1,numCells)))===0)
    onProgress({time,steps,percent:100*time/end});
   if(yieldTask&&steps%128===0)await yieldTask();
  }
  time=target;sample(ti);
 }
 const finalMoles=massOf(c,q),finalEnergy=energyOf(T,q);
 const massResidual=finalMoles-mass0-input+output;
 const energyResidual=finalEnergy-energy0-energyInput+energyOutput+wallEnergy;
 const massDen=Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output));
 const energyDen=Math.max(1,Math.abs(energyInput)+Math.abs(energyOutput)+Math.abs(wallEnergy)+
    Math.abs(alpha*H*qinit*volume));
 return {schemaVersion:"1.1",engine:"Axisymmetric 2D nonisothermal conservative FV (LTE thermal + local implicit LDF)",
  config:cfg,grid:{nz,nr,length:L,radius:R,dx,dz,volume,area,coordinate:"x=(r/R)^2",
   rCenters:Array.from({length:nr},(_,j)=>R*Math.sqrt((j+.5)/nr)),
   zCenters:Array.from({length:nz},(_,i)=>L*(i+.5)/nz)},
  equilibrium:{label:eq.label,source:eq.source,temperatureMode:h.equilibriumTemperatureMode},
  statistics:{steps,dtCfl,initialMoles:mass0,finalMoles,inletMoles:input,outletMoles:output,
   absoluteMassResidual:massResidual,relativeMassResidual:massResidual/massDen,
   minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:flowOut,
   maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual))),
   initialEnergyJ:energy0,finalEnergyJ:finalEnergy,inletSensibleEnergyJ:energyInput,
   outletSensibleEnergyJ:energyOutput,wallEnergyJ:wallEnergy,
   absoluteEnergyResidualJ:energyResidual,relativeEnergyResidual:energyResidual/energyDen,
   maxRelativeEnergyResidual:Math.max(...samples.map(s=>Math.abs(s.relativeEnergyResidual))),
   minTemperatureK:Math.min(...T),maxTemperatureK:Math.max(...T),
   peakTemperatureK:Math.max(...samples.map(s=>s.peakTemperatureK)),outletTemperatureK:averageOutlet(T)},
  samples,snapshots};
}
