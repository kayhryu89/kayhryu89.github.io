const $=id=>document.getElementById(id);
const ns="http://www.w3.org/2000/svg";
const fmt=(v,n=4)=>!Number.isFinite(Number(v))?"—":Number(v).toPrecision(n);
let worker=null,result=null,isothermReport=null,kineticReport=null,active=false;
const status=(message,error=false)=>{$("status").textContent=message;$("status").className="status"+(error?" error":"");};
const val=id=>Number($(id).value);
function updateModes(){
 const e=$("equilibriumMode").value,k=$("kineticMode").value;
 $("langmuirFields").classList.toggle("hidden",e!=="langmuir");
 $("henryFields").classList.toggle("hidden",e!=="henry");
 $("isothermFields").classList.toggle("hidden",e!=="imported");
 $("manualRateField").classList.toggle("hidden",k!=="manual");
 $("kineticFields").classList.toggle("hidden",k!=="imported");
}
function resetOutput(){
 if(active)return;
 result=null;$("fieldPlot").textContent="Run the model to see the axisymmetric concentration field.";
 $("breakthroughPlot").textContent="Time history appears after simulation.";
 $("frameLabel").textContent="Not simulated";$("snapshotIndex").disabled=true;
 for(const k of ["exportTime","exportField","exportJSON"])$(k).disabled=true;
 for(const k of ["stepsMetric","massMetric","minMetric","outletMetric"])$(k).textContent="—";
 $("massDetails").textContent="No simulation yet.";
}
function configFromUI(){
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
   simulation:{endTime:val("endTime"),snapshots:val("snapshots"),cfl:.75,maxSteps:150000}};
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
 for(let i=0;i<nz;i++)for(let j=0;j<nr;j++){
   const idx=i*nr+j,r0=Math.sqrt(j/nr),r1=Math.sqrt((j+1)/nr);
   const y=plot.top+plot.h*(1-r1),hh=plot.h*(r1-r0);
   const c=snap.concentration[idx],v=c/scale;
   const rect=svgElement("rect",{class:"heatcell",x:plot.left+i*cw,y,width:cw+.3,height:hh+.3,fill:heatColor(v)});
   rect.append(svgElement("title",{},'z='+fmt((i+.5)*length/nz,5)+' m · r≈'+fmt(radius*Math.sqrt((j+.5)/nr),5)+' m · c='+fmt(c,5)+' mol/m³ · q='+fmt(snap.loading[idx],5)+' mol/kg'));
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
 $("fieldNote").textContent="Color scale: 0 to "+fmt(scale,5)+" mol/m³. Cell width corresponds to z, cell height to physical radius (equal-area rings). Snapshot "+(index+1)+"/"+result.snapshots.length+".";
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
 plotField(result.snapshots.length-1);plotBreakthrough();
 const d=result.statistics;
 $("stepsMetric").textContent=d.steps.toLocaleString();
 $("massMetric").textContent=d.relativeMassResidual.toExponential(2);
 $("minMetric").textContent=fmt(d.minConcentration,4);
 $("outletMetric").textContent=fmt(result.samples.at(-1).outlet,4);
 $("massDetails").textContent="Species inventory [gas εC + adsorbent (1−ε)ρs q]: initial "+fmt(d.initialMoles,7)+
   " mol + inlet "+fmt(d.inletMoles,7)+" mol − outlet "+fmt(d.outletMoles,7)+
   " mol = final "+fmt(d.finalMoles,7)+" mol; residual "+d.absoluteMassResidual.toExponential(3)+
   " mol; CFL-limited dt ≤ "+fmt(d.dtCfl,5)+" s.";
 for(const id of ["exportTime","exportField","exportJSON"])$(id).disabled=false;
}
function ensureWorker(){
 if(typeof Worker==="undefined")throw Error("This browser does not support web workers.");
 if(worker)return;
 worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module"});
 worker.onmessage=event=>{
   const msg=event.data||{};
   if(msg.type==="progress"){status("Computing 2D transport and LDF: "+fmt(msg.percent,3)+"% · "+msg.steps+" steps");return;}
   if(msg.type==="result"){
     result=msg.result;active=false;$("runBtn").disabled=false;$("cancelBtn").disabled=true;
     render();status("2D run completed. Check mass balance and mesh convergence.");
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
 status("Starting 2D simulation…");
 worker.postMessage({type:"run",config});
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
   if(which==="isotherm"){
     if(!parsed.selected_model||!Array.isArray(parsed.runs))throw Error("Not an Isotherm Studio report.");
     isothermReport=parsed;
     $("isothermInfo").textContent="Loaded selected isotherm: "+parsed.selected_model+" (branch: "+(parsed.branch||"unspecified")+")";
   }else{
     if(parsed.tool!=="Adsorp Kinetic Studio"||parsed.selected_model!=="ldf")
       throw Error("Select an LDF Kinetic Studio report.");
     kineticReport=parsed;$("kineticInfo").textContent="Loaded Kinetic LDF (units "+(parsed.units?.time||"unknown")+")";
   }
   resetOutput();status("Imported "+file.name+".");
 }catch(e){status("Import error: "+e.message,true);}
 finally{input.value="";}
}
function snapshotCSV(){
 const snap=result.snapshots[Number($("snapshotIndex").value)],g=result.grid;
 const lines=["time_s,z_m,r_m,concentration_mol_m3,loading_mol_kg"];
 for(let i=0;i<g.nz;i++)for(let j=0;j<g.nr;j++){
   const k=i*g.nr+j;lines.push([snap.time,g.zCenters[i],g.rCenters[j],snap.concentration[k],snap.loading[k]].join(","));
 }
 return lines.join("\n");
}
function seriesCSV(){
 return ["time_s,outlet_mol_m3,outlet_fraction_of_feed,inventory_mol,relative_mass_residual,inlet_mol,outlet_mol",
 ...result.samples.map(s=>[s.time,s.outlet,s.outletFraction,s.inventory,s.relativeMassResidual,s.inletMoles,s.outletMoles].join(","))].join("\n");
}
$("equilibriumMode").addEventListener("change",updateModes);
$("kineticMode").addEventListener("change",updateModes);
$("runBtn").addEventListener("click",run);
$("cancelBtn").addEventListener("click",()=>{if(active){worker.postMessage({type:"cancel"});status("Cancellation requested…");}});
$("snapshotIndex").addEventListener("input",()=>plotField(Number($("snapshotIndex").value)));
$("isothermFile").addEventListener("change",e=>void importJson(e.target,"isotherm"));
$("kineticFile").addEventListener("change",e=>void importJson(e.target,"kinetic"));
$("exportTime").addEventListener("click",()=>result&&exportFile("column_breakthrough.csv",seriesCSV(),"text/csv"));
$("exportField").addEventListener("click",()=>result&&exportFile("column_spatial_snapshot.csv",snapshotCSV(),"text/csv"));
$("exportJSON").addEventListener("click",()=>result&&exportFile("column_forward_run.json",JSON.stringify(result,null,2),"application/json"));
for(const el of document.querySelectorAll("input:not([type=file]):not(#snapshotIndex),select")){
 el.addEventListener("change",()=>{if(!active&&result){resetOutput();status("Inputs changed. Rerun the forward model.");}});
}
updateModes();
