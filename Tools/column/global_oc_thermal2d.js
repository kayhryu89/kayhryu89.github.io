/* Single-domain tensor Global Legendre GLL OC with shared LTE gas/solid temperature.
 * Isothermal Global OC is unchanged; this optional nonisothermal extension solves
 * an energy equation using the same weak, nonuniform axial/radial nodes.
 *
 * Consistent directional BE splitting:
 *   gas: axial BE, radial BE, conservative positivity correction;
 *   sensible energy: axial BE, radial BE incl wall flux;
 *   thermal+gas+solid: local implicit LDF conserving both species and
 *       reduced energy Ce(T-Tinit)-alpha*H(q-qinit).
 * Thermal axial and radial transport commute only in restricted constant
 * coefficient cases. First-order split, not fully coupled global Newton/BDF.
 */
import {normalizeColumnConfig} from "./solver.js";
import {buildGlobalOc2DOperators,luFactor,stiffness,boundedConservative} from "./global_oc2d.js";
import {thermalEquilibrium,thermalLocalExchange} from "./thermal2d.js";
import {comparisonTimeGrid} from "./comparison-time.js";
import {RGAS} from "./constitutive.js";

export function buildGlobalOc2DThermalOperators(cfg,oc=null){
 if(!cfg.thermal?.enabled)throw Error("Enable nonisothermal mode for thermal Global OC.");
 const op=oc||buildGlobalOc2DOperators(cfg),{nz,nr,z,x,dt}=op;
 const {geometry:{radius:R},thermal:h,bed:{porosity:eps,particleDensity:rho}}=cfg;
 const alpha=(1-eps)*rho,Ce=eps*h.gasVolumetricHeatCapacityJm3K+alpha*h.solidHeatCapacityJkgK;
 const Cvg=h.gasVolumetricHeatCapacityJm3K;
 const sz=stiffness(z),sx=stiffness(x,x.nodes);
 const axial=[];
 for(let ir=0;ir<nr;ir++){
  const u=op.velocities[ir],M=new Float64Array(nz*nz);
  for(let i=0;i<nz;i++)for(let j=0;j<nz;j++){
   const adv=Cvg*u*z.weights[j]*z.D[j][i];
   const weak=adv-h.conductivityAxialWmK*sz[i*nz+j]-(i===nz-1&&j===nz-1?Cvg*u:0);
   M[i*nz+j]=(i===j?Ce*z.weights[i]:0)-dt*weak;
  }
  axial.push(luFactor(M,nz));
 }
 const radial=new Float64Array(nr*nr),coeff=4*h.conductivityRadialWmK/(R*R);
 const wall=2*h.wallHeatTransferWm2K/R;
 for(let i=0;i<nr;i++)for(let j=0;j<nr;j++){
  const weak=coeff*sx[i*nr+j]+(i===nr-1&&j===nr-1?wall:0);
  radial[i*nr+j]=(i===j?Ce*x.weights[i]:0)+dt*weak;
 }
 return {...op,Ce,Cvg,alpha,thermalAxial:axial,thermalRadial:luFactor(radial,nr),wallCoefficient:wall};
}
export async function simulateGlobalOcThermal2D(raw,{onProgress=null,yieldTask=null,shouldAbort=null}={}){
 const cfg=normalizeColumnConfig(raw);
 if(!cfg.thermal.enabled)throw Error("Nonisothermal Global OC requires thermal.enabled=true.");
 const op=buildGlobalOc2DThermalOperators(cfg),timing=comparisonTimeGrid(cfg);
 const {nz,nr,z,x,dt,Ce,Cvg,alpha}=op,N=nz*nr,{thermal:h}=cfg;
 const {geometry:{length:L,radius:R},bed:{porosity:eps},
  gas:{feedConcentration:cin,initialConcentration:cinit,temperatureK:Tr,direction,totalPressurePa:P},
  adsorption:{initialLoading:qinit,rateConstant:k,equilibrium:spec}}=cfg;
 const {feedTemperatureK:Tfeed,initialTemperatureK:Tinit,ambientTemperatureK:Tamb,adsorptionHeatJmol:H}=h;
 const area=Math.PI*R*R,weights=new Float64Array(N);
 for(let iz=0;iz<nz;iz++)for(let ir=0;ir<nr;ir++)
  weights[iz*nr+ir]=z.weights[iz]*x.weights[ir];
 const eq=thermalEquilibrium(spec,h,direction,Math.max(1,cin*(1+Math.abs(cfg.flow.inletAmplitude)),cinit+alpha*qinit/eps));
 const amount=(gas,load)=>{
  let v=0;for(let i=0;i<N;i++)v+=weights[i]*(eps*gas[i]+alpha*load[i]);return area*v;
 };
 const energy=(temp,load)=>{
  let v=0;for(let i=0;i<N;i++)
   v+=weights[i]*(Ce*(temp[i]-Tinit)-alpha*H*(load[i]-qinit));
  return area*v;
 };
 const outMean=array=>{
  let numerator=0;
  for(let j=0;j<nr;j++)numerator+=x.weights[j]*op.velocities[j]*array[(nz-1)*nr+j];
  return op.averageFlow>0?numerator/op.averageFlow:array[(nz-1)*nr];
 };
 let c=new Float64Array(N).fill(cinit),q=new Float64Array(N).fill(qinit),
  T=new Float64Array(N).fill(Tinit);
 let time=0,steps=0,input=0,output=0,heatInput=0,heatOutput=0,wallEnergy=0,
  correctedSteps=0,maxCorrection=0,minTemperatureK=Tinit,peakTemperatureK=Tinit;
 const mass0=amount(c,q),energy0=energy(T,q),samples=[],snapshots=[];
 const stride=timing.outputIntervals/cfg.simulation.snapshots;
 const append=index=>{
  const inv=amount(c,q),en=energy(T,q),mr=inv-mass0-input+output,
   er=en-energy0-heatInput+heatOutput+wallEnergy;
  const energyScale=Math.max(1,Math.abs(heatInput)+Math.abs(heatOutput)+Math.abs(wallEnergy)+
   Math.abs(en)+Math.abs(alpha*H*qinit*area*L));
  const gasOut=outMean(c);
  samples.push({time,outlet:gasOut,outletFraction:cin>0?gasOut/cin:0,
   outletTemperatureK:outMean(T),peakTemperatureK:Math.max(...T),minimumTemperatureK:Math.min(...T),
   inventory:inv,relativeMassResidual:mr/Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output)),
   energyJ:en,relativeEnergyResidual:er/energyScale,heatWallJ:wallEnergy,
   inletMoles:input,outletMoles:output});
  if(index%stride===0){
   const axialMean=[],radialOutlet=[],temperatureAxialMean=[];
   for(let iz=0;iz<nz;iz++){
    let cc=0,tt=0;for(let ir=0;ir<nr;ir++){
     cc+=x.weights[ir]*c[iz*nr+ir];tt+=x.weights[ir]*T[iz*nr+ir];
    }
    axialMean.push(cc);temperatureAxialMean.push(tt);
   }
   for(let ir=0;ir<nr;ir++)radialOutlet.push(c[(nz-1)*nr+ir]);
   snapshots.push({time,concentration:Array.from(c),loading:Array.from(q),
    temperatureK:Array.from(T),axialMean,radialOutlet,temperatureAxialMean});
  }
 };
 append(0);
 const bufZ=new Float64Array(N),bufR=new Float64Array(N),
  tempZ=new Float64Array(N),tempR=new Float64Array(N),zRhs=new Float64Array(nz),rRhs=new Float64Array(nr);
 for(let interval=1;interval<=timing.outputIntervals;interval++){
  for(let sub=0;sub<timing.stepsPerOutput;sub++){
   if(shouldAbort?.())throw Error("Simulation cancelled.");
   if(++steps>cfg.simulation.maxSteps)throw Error("Thermal Global OC step limit exceeded.");
   let axialOutMass=0,axialOutEnergy=0;
   // Gas axial BE, uses same 2D Global OC flux-balanced species discretization.
   for(let ir=0;ir<nr;ir++){
    const u=op.velocities[ir];
    for(let iz=0;iz<nz;iz++)zRhs[iz]=eps*z.weights[iz]*c[iz*nr+ir]+
     (iz===0?dt*u*op.inlet[ir]:0);
    const line=op.zSolvers[ir](zRhs);
    for(let iz=0;iz<nz;iz++)bufZ[iz*nr+ir]=line[iz];
    axialOutMass+=x.weights[ir]*u*line[nz-1];
   }
   for(let iz=0;iz<nz;iz++){
    for(let ir=0;ir<nr;ir++)rRhs[ir]=eps*x.weights[ir]*bufZ[iz*nr+ir];
    const line=op.radialSolver(rRhs);
    for(let ir=0;ir<nr;ir++)bufR[iz*nr+ir]=line[ir];
   }
   const cap=Math.max(1e-12,...op.inlet,...c);
   const bounded=boundedConservative(bufR,c,weights,cap);
   if(bounded.corrected){correctedSteps++;maxCorrection=Math.max(maxCorrection,bounded.maxCorrection);}
   // Temperature axial BE, using total sensible enthalpy reference Tinit.
   for(let ir=0;ir<nr;ir++){
    const u=op.velocities[ir];
    for(let iz=0;iz<nz;iz++)
     zRhs[iz]=Ce*z.weights[iz]*(T[iz*nr+ir]-Tinit)+
      (iz===0?dt*Cvg*u*(Tfeed-Tinit):0);
    const line=op.thermalAxial[ir](zRhs);
    for(let iz=0;iz<nz;iz++)tempZ[iz*nr+ir]=line[iz]+Tinit;
    axialOutEnergy+=x.weights[ir]*Cvg*u*line[nz-1];
   }
   // Temperature radial BE, including actual wall-to-ambient heat flux.
   // Use temperature relative to Tinit in RHS; ambient similarly relative.
   let wallFluxIntegral=0;
   for(let iz=0;iz<nz;iz++){
    for(let ir=0;ir<nr;ir++)rRhs[ir]=Ce*x.weights[ir]*(tempZ[iz*nr+ir]-Tinit)+
     (ir===nr-1?dt*op.wallCoefficient*(Tamb-Tinit):0);
    const line=op.thermalRadial(rRhs);
    for(let ir=0;ir<nr;ir++)tempR[iz*nr+ir]=line[ir]+Tinit;
    wallFluxIntegral+=z.weights[iz]*(tempR[iz*nr+nr-1]-Tamb);
   }
   const move=bounded.values,nextQ=new Float64Array(N);
   for(let p=0;p<N;p++){
    const t=tempR[p];
    if(!(Number.isFinite(t)&&t>=150&&t<=1500))
     throw Error("Global OC thermal transport exceeds admissible temperature [150,1500] K; refine or reduce thermal forcing.");
    const [cc,qq,tt]=thermalLocalExchange(move[p],q[p],t,dt,eps,alpha,k,Ce,h,eq);
    if(!(cc>=0&&qq>=0&&tt>=150&&tt<=1500&&cc*RGAS*tt<=P*(1+1e-9)))
     throw Error("Global OC local thermal exchange yielded an inadmissible gas/solid state.");
    move[p]=cc;nextQ[p]=qq;tempR[p]=tt;
   }
   input+=dt*area*op.inputFlux;
   output+=dt*area*axialOutMass;
   heatInput+=dt*area*op.averageFlow*Cvg*(Tfeed-Tinit);
   heatOutput+=dt*area*axialOutEnergy;
   wallEnergy+=dt*area*op.wallCoefficient*wallFluxIntegral;
   c=move;q=nextQ;T=Float64Array.from(tempR);time=steps*dt;
   minTemperatureK=Math.min(minTemperatureK,...T);
   peakTemperatureK=Math.max(peakTemperatureK,...T);
   if(yieldTask&&steps%128===0)await yieldTask();
   if(onProgress&&steps%128===0)onProgress({time,steps,percent:100*steps/timing.totalSteps});
  }
  time=interval*timing.stepsPerOutput*dt;append(interval);
 }
 const inv=amount(c,q),en=energy(T,q),
  massResidual=inv-mass0-input+output,
  energyResidual=en-energy0-heatInput+heatOutput+wallEnergy;
 const massDen=Math.max(1e-12,Math.abs(mass0)+Math.abs(input)+Math.abs(output)),
  energyDen=Math.max(1,Math.abs(heatInput)+Math.abs(heatOutput)+Math.abs(wallEnergy)+
   Math.abs(en)+Math.abs(alpha*H*qinit*area*L));
 return {schemaVersion:"1.2",engine:"2D nonisothermal GLOBAL tensor Legendre GLL OC (LTE, directional BE + local implicit thermal LDF)",
  config:cfg,grid:{nz,nr,length:L,radius:R,coordinate:"2D global Legendre GLL in z and x=(r/R)^2",
   zCenters:z.nodes,rCenters:x.nodes.map(v=>R*Math.sqrt(v)),xNodes:x.nodes,
   globalOc:true,globalOc2D:true,degreeZ:nz-1,degreeRadial:nr-1},
  equilibrium:{label:eq.label,source:eq.source,temperatureMode:h.equilibriumTemperatureMode},
  statistics:{steps,dt,timeIntegrator:"BE gas axial→radial; BE heat axial→radial+wall; implicit local thermal LDF",
   initialMoles:mass0,finalMoles:inv,inletMoles:input,outletMoles:output,
   absoluteMassResidual:massResidual,relativeMassResidual:massResidual/massDen,
   maxRelativeMassResidual:Math.max(...samples.map(s=>Math.abs(s.relativeMassResidual))),
   minConcentration:Math.min(...c),minLoading:Math.min(...q),meanVelocity:op.averageFlow,
   initialEnergyJ:energy0,finalEnergyJ:en,inletSensibleEnergyJ:heatInput,
   outletSensibleEnergyJ:heatOutput,wallEnergyJ:wallEnergy,
   absoluteEnergyResidualJ:energyResidual,relativeEnergyResidual:energyResidual/energyDen,
   maxRelativeEnergyResidual:Math.max(...samples.map(s=>Math.abs(s.relativeEnergyResidual))),
   minTemperatureK,maxTemperatureK:Math.max(...T),
   peakTemperatureK,outletTemperatureK:outMean(T),
   limiterSteps:correctedSteps,limiterFraction:correctedSteps/Math.max(1,steps),
   maxLimiterCorrection:maxCorrection},
  samples,snapshots};
}
