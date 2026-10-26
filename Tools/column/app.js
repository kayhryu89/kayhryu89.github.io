import {validateModelLink,summarizeIsotherm,summarizeKinetic} from "./model-link.js";
const $=id=>document.getElementById(id);
const ns="http://www.w3.org/2000/svg";
const fmt=(v,n=4)=>!Number.isFinite(Number(v))?"—":Number(v).toPrecision(n);
const solverMeshDefaults={globaloc2d:{nz:24,nr:6},fvbe2d:{nz:64,nr:12},
 globaloc1d:{nz:48,nr:1},fvbe1d:{nz:384,nr:1},fv:{nz:40,nr:8}};
const solverMeshLimits={globaloc2d:{nz:80,nr:16},fvbe2d:{nz:160,nr:32},
 globaloc1d:{nz:80,nr:1},fvbe1d:{nz:1024,nr:1},fv:{nz:160,nr:32}};
let activeSolverMesh="globaloc2d";
const solverMeshValues=Object.fromEntries(Object.entries(solverMeshDefaults).map(([k,v])=>[k,{...v}]));
let worker=null,result=null,isothermReport=null,kineticReport=null,active=false,lastProvenance=null,importedFiles={isotherm:null,kinetic:null};
const status=(message,error=false)=>{$("status").textContent=message;$("status").className="status"+(error?" error":"");};
const val=id=>Number($(id).value);
function updateModes(){
 const e=$("equilibriumMode").value,k=$("kineticMode").value;
 $("langmuirFields").classList.toggle("hidden",e!=="langmuir");
 $("henryFields").classList.toggle("hidden",e!=="henry");
 $("isothermFields").classList.toggle("hidden",e!=="imported");
 $("manualRateField").classList.toggle("hidden",k!=="manual");
 $("kineticFields").classList.toggle("hidden",k!=="imported");
 const thermal=$("thermalMode").value==="nonisothermal";
 $("thermalFields").classList.toggle("hidden",!thermal);
 $("solverMode").querySelector('option[value="fvbe1d"]').disabled=thermal;
 $("solverMode").querySelector('option[value="globaloc1d"]').disabled=thermal;
 $("solverMode").querySelector('option[value="globaloc2d"]').disabled=false;
 $("solverMode").querySelector('option[value="fvbe2d"]').disabled=thermal;
 if(thermal&&["ocfe1d","fvbe1d","globaloc1d","fvbe2d"].includes($("solverMode").value)){
  $("solverMode").value="fv";
  if($("nr").value==="1")$("nr").value="8";
  $("solverMode").dispatchEvent(new Event("change"));
 }
}
function resetOutput(){
 if(active)return;
 document.dispatchEvent(new Event("column:reset"));
 result=null;$("fieldPlot").textContent="Run the model to see the axisymmetric concentration field.";
 $("breakthroughPlot").textContent="Time history appears after simulation.";
 $("frameLabel").textContent="Not simulated";$("snapshotIndex").disabled=true;
 for(const k of ["exportTime","exportField","exportJSON"])$(k).disabled=true;
 for(const k of ["stepsMetric","massMetric","minMetric","outletMetric"])$(k).textContent="—";
 $("massDetails").textContent="No simulation yet.";
 $("energyDetails").textContent="";
 for(const id of ["tempMetric","energyMetric"])$(id).textContent="—";
 $("thermalResultPanel").style.display="none";
 $("temperaturePlot").textContent="";
 $("temperatureTrace").replaceChildren();
}
function rawConfigFromUI(){
 const mode=$("equilibriumMode").value;
 const equilibrium=mode==="henry"?{type:"henry",henry:val("henry")}:
   mode==="langmuir"?{type:"langmuir",qMax:val("qMax"),affinity:val("affinity")}:
   {type:"imported",report:isothermReport};
 if(mode==="imported"&&!isothermReport)throw Error("Import an Isotherm Studio equilibrium report first.");
 if($("kineticMode").value==="imported"&&!kineticReport)throw Error("Import a Kinetic Studio report with selected LDF first.");
 return {geometry:{length:val("length"),radius:val("radius")},
   bed:{porosity:val("porosity"),particleDensity:val("density")},
   flow:{superficialVelocity:val("velocity"),axialDispersion:val("dzDisp"),radialDispersion:val("drDisp"),
     inletAmplitude:val("inletAmp"),velocityAmplitude:val("velocityAmp")},
   gas:{direction:$("direction").value,feedConcentration:val("feed"),initialConcentration:val("initialC"),
     temperatureK:val("temperature"),totalPressurePa:val("pressure")},
   adsorption:{initialLoading:val("initialQ"),rateConstant:val("rate"),
     ...(kineticReport&&$("kineticMode").value==="imported"?{kineticReport}:{}),
     equilibrium},
   grid:{nz:val("nz"),nr:val("nr")},
   simulation:{endTime:val("endTime"),snapshots:val("snapshots"),cfl:.75,maxSteps:150000,
     beStepsPerOutput:val("beStepsPerOutput"),
     referenceHighResolution:$("solverMode").value==="fvbe1d"&&val("nz")>160},
   thermal:$("thermalMode").value==="nonisothermal"?{
    enabled:true,feedTemperatureK:val("heatFeedT"),initialTemperatureK:val("heatInitialT"),
    ambientTemperatureK:val("heatAmbientT"),referenceTemperatureK:val("temperature"),
    gasVolumetricHeatCapacityJm3K:val("heatCpGas"),
    solidHeatCapacityJkgK:val("heatCpSolid"),
    conductivityAxialWmK:val("heatLz"),conductivityRadialWmK:val("heatLr"),
    wallHeatTransferWm2K:val("heatWallH"),adsorptionHeatJmol:val("heatAdsH"),
    activationEnergyJmol:val("heatEa"),equilibriumTemperatureMode:$("heatEqMode").value
   }:{enabled:false}};
}
function linkOptions(){
 return {allowLegacy:$("linkLegacyAccept").checked,allowFixedTarget:$("linkFixedAccept").checked,
  allowTemperatureTransfer:$("linkTempAccept").checked};
}
function linkSummary(config=rawConfigFromUI()){
 const provenance=validateModelLink(config,linkOptions());
 const sources={isotherm:importedFiles.isotherm,kinetic:importedFiles.kinetic};
 return {...provenance,sourceFiles:sources};
}
function updateLinkStatus(){
 try{
  const s=linkSummary();
  lastProvenance=s;
  const parts=["Compatible sources"];
  if(s.equilibrium&&typeof s.equilibrium==="object")parts.push("Isotherm: "+s.equilibrium.model+" ("+s.equilibrium.xUnit+", "+s.equilibrium.qUnit+")");
  else parts.push("Isotherm: manual");
  if(s.kinetic)parts.push("Kinetic LDF: "+fmt(s.kinetic.rateConstant,5)+" s⁻¹ ("+s.kinetic.equilibriumType+")");
  else parts.push("Kinetic rate: manual");
  if(s.notes.length)parts.push("Cautions: "+s.notes.join(" "));
  $("linkStatus").textContent=parts.join(" · ");
  $("linkStatus").className="status";
 }catch(e){
  lastProvenance=null;$("linkStatus").textContent="Link validation required: "+e.message;
  $("linkStatus").className="status error";
 }
}
function configFromUI(){
 const config=rawConfigFromUI();
 lastProvenance=linkSummary(config);
 return config;
}

function svgElement(tag,props={},text=null){
 const e=document.createElementNS(ns,tag);
 for(const [k,v] of Object.entries(props))e.setAttribute(k,String(v));
 if(text!==null)e.textContent=String(text);
 return e;
}
function heatColor(v){
 const x=Math.max(0,Math.min(1.2,v))/1.2;
 const hue=197-13*x,light=95-58*x;
 return "hsl("+hue.toFixed(1)+",75%,"+light.toFixed(1)+"%)";
}
function plotField(index){
 if(!result)return;
 const snap=result.snapshots[index],{nz,nr,length,radius}=result.grid;
 const feed=result.config.gas.feedConcentration,initial=result.config.gas.initialConcentration;
 const scale=Math.max(1e-8,feed,initial,...snap.concentration)*1.001;
 const svg=svgElement("svg",{viewBox:"0 0 820 370",role:"img","aria-label":"2D gas concentration at "+fmt(snap.time)+" seconds"});
 const plot={left:70,top:28,w:650,h:260};
 svg.append(svgElement("rect",{x:plot.left,y:plot.top,width:plot.w,height:plot.h,fill:"#eff6fa"}));
 const cw=plot.w/nz;
 const global=result.grid.globalOc===true;
 const zcoords=result.grid.zCenters||[],xcoords=result.grid.xNodes||[];
 for(let i=0;i<nz;i++)for(let j=0;j<nr;j++){
   const idx=i*nr+j;
   const x0=result.grid.globalOc2D?(j===0?0:(xcoords[j-1]+xcoords[j])*.5):j/nr;
   const x1=result.grid.globalOc2D?(j===nr-1?1:(xcoords[j]+xcoords[j+1])*.5):(j+1)/nr;
   const r0=Math.sqrt(x0),r1=Math.sqrt(x1);
   const y=plot.top+plot.h*(1-r1),hh=plot.h*(r1-r0);
   const c=snap.concentration[idx],v=c/scale;
   const zLeft=global?(i===0?0:(zcoords[i-1]+zcoords[i])*.5):i*length/nz;
   const zRight=global?(i===nz-1?length:(zcoords[i]+zcoords[i+1])*.5):(i+1)*length/nz;
   const xLeft=plot.left+plot.w*zLeft/length,cellWidth=plot.w*(zRight-zLeft)/length;
   const rect=svgElement("rect",{class:"heatcell",x:xLeft,y,width:cellWidth+.3,height:hh+.3,fill:heatColor(v)});
   rect.append(svgElement("title",{},'z='+fmt(result.grid.zCenters?.[i]??((i+.5)*length/nz),5)+' m · r≈'+fmt(result.grid.rCenters?.[j]??radius*Math.sqrt((j+.5)/nr),5)+' m · c='+fmt(c,5)+' mol/m³ · q='+fmt(snap.loading[idx],5)+' mol/kg'));
   svg.append(rect);
 }
 svg.append(svgElement("rect",{x:plot.left,y:plot.top,width:plot.w,height:plot.h,fill:"none",stroke:"#64748b"}));
 for(let k=0;k<=5;k++){
   const x=plot.left+plot.w*k/5;
   svg.append(svgElement("line",{x1:x,x2:x,y1:plot.top+plot.h,y2:plot.top+plot.h+6,class:"tick"}));
   svg.append(svgElement("text",{x,y:plot.top+plot.h+22,"text-anchor":"middle",class:"axis"},fmt(length*k/5,3)));
 }
 svg.append(svgElement("text",{x:plot.left+plot.w/2,y:plot.top+plot.h+48,"text-anchor":"middle",class:"axis"},"Axial position z (m)"));
 for(let k=0;k<=4;k++){
   const rr=k/4,y=plot.top+plot.h*(1-rr);
   svg.append(svgElement("text",{x:plot.left-9,y:y+4,"text-anchor":"end",class:"axis"},fmt(rr,2)));
 }
 svg.append(svgElement("text",{x:17,y:plot.top+plot.h/2,"text-anchor":"middle",transform:"rotate(-90 17 "+(plot.top+plot.h/2)+")",class:"axis"},"Radius r/R"));
 const legendX=735,legendY=plot.top,legendH=plot.h/14;
 for(let i=0;i<14;i++)svg.append(svgElement("rect",{x:legendX,y:legendY+i*legendH,width:24,height:legendH+1,
   fill:heatColor((13-i)/13)}));
 svg.append(svgElement("text",{x:762,y:legendY+11,class:"axis"},fmt(scale)));
 svg.append(svgElement("text",{x:762,y:legendY+plot.h,class:"axis"},"0"));
 $("fieldPlot").replaceChildren(svg);
 $("frameLabel").textContent="t = "+fmt(snap.time,5)+" s";
 plotTemperature(index);
 $("fieldNote").textContent="Color scale: 0 to "+fmt(scale,5)+" mol/m³. "+(global?"Global OC nodes use nonuniform z and, for 2D, radial x spacing. Plot colors use midpoint interpolation for visualization only, not FV cell averages.":"FVM cells represent physical z and equal-area radial rings.")+" Snapshot "+(index+1)+"/"+result.snapshots.length+".";
}
function plotTemperature(index){
 if(!result?.snapshots[index]?.temperatureK){$("thermalResultPanel").style.display="none";return;}
 $("thermalResultPanel").style.display="block";
 const snap=result.snapshots[index],{nz,nr,length,radius}=result.grid;
 const values=snap.temperatureK,tmin=Math.min(...values),tmax=Math.max(...values);
 const delta=Math.max(1e-8,tmax-tmin);
 const svg=svgElement("svg",{viewBox:"0 0 820 370",role:"img","aria-label":"2D temperature field at "+fmt(snap.time)+" seconds"});
 const plot={left:70,top:28,w:650,h:260},cw=plot.w/nz;
 const global=result.grid.globalOc2D===true,zz=result.grid.zCenters||[],xx=result.grid.xNodes||[];
 for(let i=0;i<nz;i++)for(let j=0;j<nr;j++){
  const idx=i*nr+j,x0=global?(j===0?0:(xx[j-1]+xx[j])/2):j/nr,
   x1=global?(j===nr-1?1:(xx[j]+xx[j+1])/2):(j+1)/nr;
  const r0=Math.sqrt(x0),r1=Math.sqrt(x1);
  const z0=global?(i===0?0:(zz[i-1]+zz[i])/2):length*i/nz,
   z1=global?(i===nz-1?length:(zz[i]+zz[i+1])/2):length*(i+1)/nz;
  const y=plot.top+plot.h*(1-r1),height=plot.h*(r1-r0);
  const value=values[idx],norm=(value-tmin)/delta;
  const rect=svgElement("rect",{class:"heatcell",x:plot.left+plot.w*z0/length,y,
   width:plot.w*(z1-z0)/length+.3,height:height+.3,fill:heatColor(norm)});
  rect.append(svgElement("title",{},"z="+fmt(result.grid.zCenters[i],4)+" m · r="+
    fmt(radius*Math.sqrt((j+.5)/nr),4)+" m · T="+fmt(value,7)+" K"));
  svg.append(rect);
 }
 svg.append(svgElement("rect",{x:plot.left,y:plot.top,width:plot.w,height:plot.h,fill:"none",stroke:"#64748b"}));
 for(let k=0;k<=4;k++){
  const x=plot.left+plot.w*k/4;
  svg.append(svgElement("text",{x,y:plot.top+plot.h+24,"text-anchor":"middle",class:"axis"},fmt(length*k/4,3)));
  const y=plot.top+plot.h*(1-k/4);
  svg.append(svgElement("text",{x:plot.left-9,y:y+4,"text-anchor":"end",class:"axis"},fmt(k/4,2)));
 }
 svg.append(svgElement("text",{x:plot.left+plot.w/2,y:plot.top+plot.h+48,"text-anchor":"middle",class:"axis"},"Axial position z (m)"));
 const h=plot.h/14;
 for(let i=0;i<14;i++)svg.append(svgElement("rect",{x:735,y:plot.top+i*h,width:24,height:h+1,fill:heatColor((13-i)/13)}));
 svg.append(svgElement("text",{x:762,y:plot.top+11,class:"axis"},fmt(tmax,6)));
 svg.append(svgElement("text",{x:762,y:plot.top+plot.h,class:"axis"},fmt(tmin,6)));
 $("temperaturePlot").replaceChildren(svg);
 $("temperatureNote").textContent="LTE gas/solid temperature, time = "+fmt(snap.time,5)+" s. Colormap normalized to this snapshot ["+
 fmt(tmin,6)+", "+fmt(tmax,6)+"] K; compare absolute values across snapshots, not colors.";
}
function plotTemperatureTrace(){
 if(!result?.samples?.[0]?.outletTemperatureK)return;
 const data=result.samples,end=result.config.simulation.endTime;
 const ymin=Math.min(...data.flatMap(p=>[p.outletTemperatureK,p.peakTemperatureK]))-.05;
 const ymax=Math.max(...data.flatMap(p=>[p.outletTemperatureK,p.peakTemperatureK]))+.05;
 const x=t=>65+650*t/end,y=T=>24+250*(1-(T-ymin)/Math.max(1e-12,ymax-ymin));
 const svg=svgElement("svg",{viewBox:"0 0 760 330",class:"column-breakthrough",role:"img",
    "aria-label":"Outlet and maximum bed temperature over time"});
 for(let i=0;i<=4;i++){
  const yy=ymin+(ymax-ymin)*i/4,xx=end*i/4;
  svg.append(svgElement("line",{x1:65,x2:715,y1:y(yy),y2:y(yy),class:"tick"}));
  svg.append(svgElement("text",{x:58,y:y(yy)+4,"text-anchor":"end",class:"axis"},fmt(yy,5)));
  svg.append(svgElement("text",{x:x(xx),y:297,"text-anchor":"middle",class:"axis"},fmt(xx,3)));
 }
 for(const [field,color] of [["outletTemperatureK","#0284c7"],["peakTemperatureK","#c2410c"]]){
  svg.append(svgElement("polyline",{points:data.map(p=>x(p.time).toFixed(2)+","+y(p[field]).toFixed(2)).join(" "),
   fill:"none",stroke:color,"stroke-width":2.7}));
 }
 svg.append(svgElement("text",{x:380,y:321,"text-anchor":"middle",class:"axis"},"Time (s)"));
 $("temperatureTrace").replaceChildren(svg);
 $("temperatureTraceNote").textContent="Outlet temperature: blue; maximum bed temperature: orange. Kinetic/thermal property coefficients are constant except optional Arrhenius k.";
}
function plotBreakthrough(){
 const host=$("breakthroughPlot");
 if(!result)return;
 const samples=result.samples,end=result.config.simulation.endTime,feed=result.config.gas.feedConcentration;
 const normalized=feed>0,points=samples.map(s=>[s.time,normalized?s.outletFraction:s.outlet]);
 const yMax=Math.max(normalized?1:.01,...points.map(p=>p[1]))*1.08;
 const box={left:68,top:24,width:642,height:250};
 const X=x=>box.left+box.width*x/Math.max(end,1e-12);
 const Y=y=>box.top+box.height*(1-y/yMax);
 const svg=svgElement("svg",{viewBox:"0 0 760 330",class:"column-breakthrough",role:"img","aria-label":"Flux-weighted outlet concentration versus time"});
 for(let i=0;i<=4;i++){
   const yy=yMax*i/4,y=Y(yy),xx=end*i/4,x=X(xx);
   svg.append(svgElement("line",{x1:box.left,x2:box.left+box.width,y1:y,y2:y,class:"tick"}));
   svg.append(svgElement("text",{x:box.left-10,y:y+4,"text-anchor":"end",class:"axis"},fmt(yy,3)));
   svg.append(svgElement("line",{x1:x,x2:x,y1:box.top+box.height,y2:box.top+box.height+5,class:"tick"}));
   svg.append(svgElement("text",{x,y:box.top+box.height+22,"text-anchor":"middle",class:"axis"},fmt(xx,3)));
 }
 svg.append(svgElement("polyline",{points:points.map(p=>X(p[0]).toFixed(2)+","+Y(p[1]).toFixed(2)).join(" "),class:"trace"}));
 svg.append(svgElement("text",{x:box.left+box.width/2,y:box.top+box.height+45,"text-anchor":"middle",class:"axis"},"Time (s)"));
 svg.append(svgElement("text",{x:14,y:box.top+box.height/2,"text-anchor":"middle",transform:"rotate(-90 14 "+(box.top+box.height/2)+")",class:"axis"},normalized?"Cout/Cfeed":"Cout (mol/m³)"));
 host.replaceChildren(svg);
 $("breakthroughNote").textContent=normalized?"Area/flow-weighted outlet gas concentration divided by uniform nominal feed concentration. Radial inlet maldistribution changes actual inlet flux.":"Flux-weighted absolute outlet gas concentration (feed is zero, desorption/flush case).";
}
function render(){
 if(!result)return;
 $("snapshotIndex").min="0";$("snapshotIndex").max=String(result.snapshots.length-1);
 $("snapshotIndex").value=$("snapshotIndex").max;$("snapshotIndex").disabled=false;
 plotField(result.snapshots.length-1);plotBreakthrough();plotTemperature(result.snapshots.length-1);plotTemperatureTrace();
 const d=result.statistics;
 $("stepsMetric").textContent=d.steps.toLocaleString();
 $("massMetric").textContent=d.relativeMassResidual.toExponential(2);
 $("minMetric").textContent=fmt(d.minConcentration,4);
 $("outletMetric").textContent=fmt(result.samples.at(-1).outlet,4);
 $("tempMetric").textContent=Number.isFinite(d.peakTemperatureK)?fmt(d.peakTemperatureK,6):"—";
 $("energyMetric").textContent=Number.isFinite(d.relativeEnergyResidual)?d.relativeEnergyResidual.toExponential(2):"—";
 $("energyDetails").textContent=Number.isFinite(d.relativeEnergyResidual)?
  "Reduced total energy balance [sensible heat − adsorption binding energy]: initial "+fmt(d.initialEnergyJ,6)+" J + inlet "+
  fmt(d.inletSensibleEnergyJ,6)+" J − outlet "+fmt(d.outletSensibleEnergyJ,6)+" J − net wall heat "+
  fmt(d.wallEnergyJ,6)+" J = final "+fmt(d.finalEnergyJ,6)+" J; residual "+
  d.absoluteEnergyResidualJ.toExponential(3)+" J.":"Isothermal model: no energy equation solved.";
 $("massDetails").textContent="Species inventory [gas εC + adsorbent (1−ε)ρs q]: initial "+fmt(d.initialMoles,7)+
   " mol + inlet "+fmt(d.inletMoles,7)+" mol − outlet "+fmt(d.outletMoles,7)+
   " mol = final "+fmt(d.finalMoles,7)+" mol; residual "+d.absoluteMassResidual.toExponential(3)+
   " mol; "+(result.engine.includes("GLOBAL")?"Global OC "+(result.grid.globalOc2D?"tensor 2D":"1D")+": BE dt "+fmt(d.dt,5)+" s; bound correction "+fmt(d.limiterFraction*100,4)+"% of steps (max "+fmt(d.maxLimiterCorrection,5)+" mol/m³).":result.engine.includes("OCFE")?"Experimental quadratic GLL OCFE.":Number.isFinite(d.dt)?"FVM-BE dt = "+fmt(d.dt,5)+" s.":"FV CFL dt ≤ "+fmt(d.dtCfl,5)+" s.");
 for(const id of ["exportTime","exportField","exportJSON"])$(id).disabled=false;
 document.dispatchEvent(new CustomEvent("column:result",{detail:result}));
}
function ensureWorker(){
 if(typeof Worker==="undefined")throw Error("This browser does not support web workers.");
 if(worker)return;
 worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module"});
 worker.onmessage=event=>{
   const msg=event.data||{};
   if(msg.type==="progress"){status("Computing 2D transport, LDF"+($("thermalMode").value==="nonisothermal"?" and heat":"")+": "+fmt(msg.percent,3)+"% · "+msg.steps+" steps");return;}
   if(msg.type==="result"){
     result=msg.result;active=false;$("runBtn").disabled=false;$("cancelBtn").disabled=true;
     render();status(msg.result.engine.includes("GLOBAL")?"Global OC completed. Check limiter and mesh/time convergence.":msg.result.engine.includes("OCFE")?"Experimental 1D OCFE completed.":"2D run completed. Check mass balance and mesh convergence."+
 (msg.result.config?.thermal?.enabled?" Also check thermal energy residual and temperature range.":""));
   }else if(msg.type==="cancelled"){
     active=false;$("runBtn").disabled=false;$("cancelBtn").disabled=true;status("Simulation cancelled.");
   }else if(msg.type==="error"){
     active=false;$("runBtn").disabled=false;$("cancelBtn").disabled=true;status("Simulation failed: "+msg.message,true);
   }
 };
 worker.onerror=e=>{
   active=false;$("runBtn").disabled=false;$("cancelBtn").disabled=true;
   status("Worker error: "+(e.message||"Failed to load model modules."),true);
 };
}
function run(){
 if(active)return;
 let config;
 try{config=configFromUI();ensureWorker();}
 catch(e){status(e.message,true);return;}
 resetOutput();active=true;$("runBtn").disabled=true;$("cancelBtn").disabled=false;
 status($("solverMode").value==="globaloc2d"?(config.thermal.enabled?"Starting nonisothermal 2D Global OC (LTE)…":"Starting Global OC tensor 2D…"):$("solverMode").value==="fvbe2d"?"Starting conservative 2D FVM-BE comparison…":$("solverMode").value==="globaloc1d"?"Starting Global OC (single domain, 1D)…":$("solverMode").value==="ocfe1d"?"Starting archived 1D OCFE-BE run…":$("solverMode").value==="fvbe1d"?"Starting matched 1D FVM-BE run…":config.thermal.enabled?"Starting 2D nonisothermal conservative FVM…":"Starting 2D FVM simulation…");
 worker.postMessage({type:"run",config,solverMode:$("solverMode").value});
}
function exportFile(name,body,mime){
 const url=URL.createObjectURL(new Blob([body],{type:mime}));
 const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),2000);
}
async function importJson(input,which){
 const file=input.files?.[0];if(!file)return;
 try{
  if(file.size>2000000)throw Error("JSON import exceeds 2 MB.");
  const parsed=JSON.parse(await file.text());
  const probe={gas:{temperatureK:val("temperature"),feedConcentration:val("feed"),
   direction:$("direction").value,totalPressurePa:val("pressure")}};
  if(which==="isotherm"){
    const info=summarizeIsotherm(parsed,{temperatureK:probe.gas.temperatureK,
      feedConcentration:probe.gas.feedConcentration,branch:probe.gas.direction,
      pressurePa:probe.gas.totalPressurePa});
    // A mismatched fully signed kinetic link is never silently overwritten.
    if(kineticReport&&$("kineticMode").value==="imported"){
      const kin=summarizeKinetic(kineticReport);
      if(kin.signature&&kin.signature!==info.signature)
       throw Error("Selected isotherm coefficients differ from the linked Kinetic model. Import the matching isotherm.");
    }
    isothermReport=parsed;importedFiles.isotherm=file.name;
    $("equilibriumMode").value="imported";updateModes();
    $("isothermInfo").textContent="Loaded "+info.model+" · "+info.xUnit+" → mol/m³ gas via p=C RT · q "+info.qUnit+
      (info.temperatureK?" · fitted at "+info.temperatureK+" K":" · temperature not reported");
  }else{
    const info=summarizeKinetic(parsed);
    if(info.branch&&info.branch!=="all"&&info.branch!==probe.gas.direction)
      throw Error("Kinetic report branch does not match current column direction.");
    let linked=null;
    if(info.embeddedIsotherm){
      const newInfo=summarizeIsotherm(info.embeddedIsotherm,{temperatureK:probe.gas.temperatureK,
        feedConcentration:probe.gas.feedConcentration,branch:probe.gas.direction,
        pressurePa:probe.gas.totalPressurePa});
      if(isothermReport&&$("equilibriumMode").value==="imported"){
        const oldInfo=summarizeIsotherm(isothermReport,{temperatureK:probe.gas.temperatureK,
          feedConcentration:probe.gas.feedConcentration,branch:probe.gas.direction,
          pressurePa:probe.gas.totalPressurePa});
        if(oldInfo.signature!==newInfo.signature)
          throw Error("Imported kinetic LDF was fitted with different equilibrium coefficients. Select the matching Isotherm.");
      }else linked=info.embeddedIsotherm;
    }
    if(linked){
      isothermReport=linked;importedFiles.isotherm=file.name+" (embedded isotherm)";
      $("equilibriumMode").value="imported";updateModes();
      $("isothermInfo").textContent="Restored "+linked.selected_model+" directly from linked Kinetic report.";
    }
    kineticReport=parsed;importedFiles.kinetic=file.name;
    $("kineticMode").value="imported";updateModes();
    $("kineticInfo").textContent="LDF k = "+fmt(info.rateConstant,6)+" s⁻¹ (converted from "+info.timeUnit+")"+
      " · q* source: "+info.equilibriumType;
  }
  resetOutput();updateLinkStatus();
  status("Imported and checked "+file.name+". Review model-link status.");
 }catch(e){status("Import error: "+e.message,true);updateLinkStatus();}
 finally{input.value="";}
}
function snapshotCSV(){
 const snap=result.snapshots[Number($("snapshotIndex").value)],g=result.grid;
 const hot=Array.isArray(snap.temperatureK);
 const lines=["time_s,z_m,r_m,concentration_mol_m3,loading_mol_kg"+(hot?",temperature_K":"")];
 for(let i=0;i<g.nz;i++)for(let j=0;j<g.nr;j++){
  const k=i*g.nr+j;
  lines.push([snap.time,g.zCenters[i],g.rCenters[j],snap.concentration[k],snap.loading[k],
    ...(hot?[snap.temperatureK[k]]:[])].join(","));
 }
 return lines.join("\n");
}
function seriesCSV(){
 const hot=Number.isFinite(result.samples[0].outletTemperatureK);
 return ["time_s,outlet_mol_m3,outlet_fraction_of_feed,inventory_mol,relative_mass_residual,inlet_mol,outlet_mol"+
 (hot?",outlet_temperature_K,peak_temperature_K,energy_residual,wall_energy_J":""),
 ...result.samples.map(s=>[s.time,s.outlet,s.outletFraction,s.inventory,s.relativeMassResidual,s.inletMoles,s.outletMoles,
 ...(hot?[s.outletTemperatureK,s.peakTemperatureK,s.relativeEnergyResidual,s.heatWallJ]:[])].join(","))].join("\n");
}
document.addEventListener("column:fit-config-request",event=>{
 try{
  if(active)throw Error("Stop the forward simulation before fitting experimental breakthrough.");
  event.detail.config=configFromUI();
  event.detail.lineage=lastProvenance;
 }catch(e){event.detail.error=e.message||String(e);}
});
document.addEventListener("column:fit-apply",event=>{
 if(active){event.detail.error="Stop the active forward simulation before applying fitted parameters.";return;}
 const p=event.detail.fitted||{};
 if(p.k!==undefined){
  // Explicit manual fitted k supersedes (does not mutate) the upstream Kinetic fit.
  $("kineticMode").value="manual";
  $("rate").value=String(p.k);
 }
 if(p.dz!==undefined)$("dzDisp").value=String(p.dz);
 updateModes();
 resetOutput();
 status("Fitted parameter(s) applied. Imported kinetic fit retained as upstream provenance only; forward k is now manual/refined.");
 updateLinkStatus();
 event.detail.applied=true;
});
$("equilibriumMode").addEventListener("change",updateModes);
$("kineticMode").addEventListener("change",updateModes);
$("thermalMode").addEventListener("change",updateModes);
$("solverMode").addEventListener("change",()=>{
 const next=$("solverMode").value;
 solverMeshValues[activeSolverMesh]={nz:val("nz"),nr:val("nr")};
 const limits=solverMeshLimits[next]||solverMeshLimits.fv;
 const saved=solverMeshValues[next]||solverMeshDefaults[next]||solverMeshDefaults.fv;
 $("nz").max=String(limits.nz);$("nr").max=String(limits.nr);
 $("nz").value=String(Math.min(limits.nz,saved.nz));
 $("nr").value=String(Math.min(limits.nr,saved.nr));
 activeSolverMesh=next;
 if(["fvbe1d","globaloc1d"].includes(next)){
  $("nr").value="1";$("inletAmp").value="0";$("velocityAmp").value="0";
  status("1D collocation uses a whole-column polynomial; FVM-BE has an independently refined uniform grid. BE time integration is identical.");
 }else if(["fvbe2d","globaloc2d"].includes(next)){
  status("2D comparison: Global OC uses nonuniform tensor LGL nodes (default 24×6); 2D FVM-BE uses equal-area FV cells (default 64×12). Identical directional BE time splitting.");
 }else status("2D FVM production mode; CFL-limited explicit transport and optional heat transfer.");
 resetOutput();
});
$("runBtn").addEventListener("click",run);
$("cancelBtn").addEventListener("click",()=>{if(active){worker.postMessage({type:"cancel"});status("Cancellation requested…");}});
$("snapshotIndex").addEventListener("input",()=>plotField(Number($("snapshotIndex").value)));
$("isothermFile").addEventListener("change",e=>void importJson(e.target,"isotherm"));
$("kineticFile").addEventListener("change",e=>void importJson(e.target,"kinetic"));
$("linkValidate").addEventListener("click",updateLinkStatus);
for(const name of ["linkLegacyAccept","linkFixedAccept","linkTempAccept"])$(name).addEventListener("change",()=>{resetOutput();updateLinkStatus();});
$("linkFitBounds").addEventListener("click",()=>{
 try{
  if(!kineticReport||$("kineticMode").value!=="imported")throw Error("Import and select a Kinetic Studio LDF fit.");
  const k=summarizeKinetic(kineticReport).rateConstant;
  $("fitKMin").value=String(Math.max(1e-8,k/10));
  $("fitKMax").value=String(Math.min(1e4,k*10));
  $("fitMode").value="k";
  $("fitKMin").dispatchEvent(new Event("change"));
  status("kLDF PE bounds initialized around the imported kinetic rate. Fitting will refine it; Dz-only mode fixes it.");
 }catch(e){status(e.message,true);}
});
$("exportTime").addEventListener("click",()=>result&&exportFile("column_breakthrough.csv",seriesCSV(),"text/csv"));
$("exportField").addEventListener("click",()=>result&&exportFile("column_spatial_snapshot.csv",snapshotCSV(),"text/csv"));
$("exportJSON").addEventListener("click",()=>result&&exportFile("column_forward_run.json",JSON.stringify({...result,modelProvenance:lastProvenance},null,2),"application/json"));
for(const el of document.querySelectorAll("input:not([type=file]):not(#snapshotIndex),select")){
 if(el.closest("#experimentPanel"))continue;
 el.addEventListener("change",()=>{
  if(!active&&result){resetOutput();status("Inputs changed. Rerun the forward model.");}
  if(!active)updateLinkStatus();
 });
}
updateModes();
$("nz").max="80";$("nr").max="16";
updateLinkStatus();
