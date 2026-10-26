/* Versioned, deterministic evidence linkage between Isotherm, Kinetic and Column Studio.
   Signatures are canonical provenance identifiers, NOT cryptographic authenticity proofs. */
import {readIsothermReport} from "../kinetic/models.js";
import {createEquilibrium,extractKineticRate,RGAS} from "./constitutive.js";
const finite=(n)=>Number.isFinite(Number(n))?Number(n):null;
const norm=s=>String(s??"").toLowerCase().replace(/\s+/g,"").replace(/\^/g,"");
const stable=o=>o===null||typeof o!=="object"?JSON.stringify(o):Array.isArray(o)?"["+o.map(stable).join(",")+"]":
 "{"+Object.keys(o).sort().map(k=>JSON.stringify(k)+":"+stable(o[k])).join(",")+"}";
function selectedRun(report){
 if(!report||typeof report!=="object"||!Array.isArray(report.runs)||!report.selected_model)
  throw Error("Invalid Isotherm Studio JSON; selected model and runs are required.");
 const run=report.runs.find(r=>r.id===report.selected_model);
 if(!run)throw Error("Selected isotherm is missing from fitted runs.");
 readIsothermReport(report); // validate canonical parameters/model before provenance collection
 return run;
}
export function isothermSignature(report){
 const run=selectedRun(report);
 return "isotherm:selected:v1:"+stable({
   id:run.id,components:run.components||report.selected_components||null,
   params:run.params,xScale:Number(run.xScale),yScale:Number(run.yScale),
   branch:report.branch||null,domain:report.domain||"bulk",
   xUnit:norm(report.units?.x),qUnit:norm(report.units?.q)
 });
}
export function selectedIsothermSnapshot(report){
 const run=selectedRun(report);
 return {tool:"Adsorp Supporting Tool",schema_version:"0.1",
  domain:report.domain||"bulk",branch:report.branch||null,
  ...(finite(report.temperature_K)>0?{temperature_K:Number(report.temperature_K)}:{}),
  units:{x:report.units?.x,q:report.units?.q},
  selected_model:report.selected_model,
  selected_components:report.selected_components||null,
  runs:[{id:run.id,label:run.label,components:run.components||null,
    params:run.params,xScale:run.xScale,yScale:run.yScale}]};
}
export function summarizeIsotherm(report,{temperatureK,feedConcentration=0,branch="adsorption",pressurePa=101325}={}){
 const r=selectedRun(report);
 const domain=report.domain||"bulk";if(domain!=="bulk")throw Error("Relative-pressure isotherms cannot be inserted without saturation pressure p0.");
 if(report.branch&&report.branch!=="all"&&report.branch!==branch)
  throw Error("Isotherm branch "+report.branch+" differs from column "+branch+".");
 const maxC=Math.max(1,feedConcentration,pressurePa/(RGAS*temperatureK));
 const eq=createEquilibrium({type:"imported",report},temperatureK,{branch,maxConcentration:maxC});
 const sourceT=finite(report.temperature_K)>0?Number(report.temperature_K):null;
 const notes=[];
 if(sourceT===null)notes.push("Isotherm report has no calibration temperature. Temperature transferability has not been established.");
 else if(Math.abs(sourceT-temperatureK)>.5)
  notes.push("Isotherm calibration temperature "+sourceT+" K differs from column "+temperatureK+" K.");
 const observations=Array.isArray(report.selected_observations)?report.selected_observations:[];
 const px=norm(report.units?.x), scale=px==="pa"?1:px==="kpa"?1000:px==="bar"?1e5:null;
 if(scale&&observations.length>=2&&feedConcentration>0){
  const xs=observations.map(o=>finite(o.x??o.pressure)).filter(v=>v!==null&&v>=0);
  if(xs.length>=2){
   const target=feedConcentration*RGAS*temperatureK/scale;
   if(target>Math.max(...xs)*1.02)
    notes.push("Column feed partial pressure is above fitted isotherm measurement range; this is extrapolation.");
  }
 }
 return {model:report.selected_model,label:eq.label,signature:isothermSignature(report),branch:report.branch||null,
  temperatureK:sourceT,xUnit:report.units?.x,qUnit:report.units?.q,notes};
}
export function summarizeKinetic(report){
 const rate=extractKineticRate(report);
 if(report.branch&&!["adsorption","desorption","all"].includes(report.branch))
  throw Error("Invalid kinetic branch in imported report.");
 const eq=report.equilibrium||null;
 const embedded=report.linked_isotherm||null;
 if(embedded&&eq?.type!=="imported_isotherm")
  throw Error("Embedded isotherm is inconsistent with kinetic equilibrium metadata.");
 if(embedded&&eq?.model&&eq.model!==embedded.selected_model)
  throw Error("Kinetic equilibrium model metadata differs from embedded selected isotherm.");
 if(embedded&&eq?.sourceUnits){
  if(norm(eq.sourceUnits.x)&&norm(eq.sourceUnits.x)!==norm(embedded.units?.x))
   throw Error("Kinetic equilibrium pressure units differ from embedded selected isotherm.");
  if(norm(eq.sourceUnits.q)&&norm(eq.sourceUnits.q)!==norm(embedded.units?.q))
   throw Error("Kinetic equilibrium loading units differ from embedded selected isotherm.");
 }
 if(embedded&&report.linked_isotherm_signature&&report.linked_isotherm_signature!==isothermSignature(embedded))
  throw Error("Kinetic report embedded isotherm signature is inconsistent with its parameters.");
 const sourceT=finite(report.temperature_K)>0?Number(report.temperature_K):null;
 return {rateConstant:rate.rateConstant,model:"ldf",branch:report.branch||null,
  timeUnit:rate.sourceTimeUnit,loadingUnit:report.units?.loading,
  equilibriumType:eq?.type||"unspecified",equilibriumModel:eq?.model||null,
  signature:embedded?isothermSignature(embedded):report.linked_isotherm_signature||null,
  embeddedIsotherm:embedded,temperatureK:sourceT};
}
export function validateModelLink(config,{allowLegacy=false,allowFixedTarget=false,allowTemperatureTransfer=false}={}){
 const notes=[],hard=[],needsApproval=[];
 const equilibrium=config?.adsorption?.equilibrium;
 const iso=equilibrium?.type==="imported"?equilibrium.report:null;
 const kin=config?.adsorption?.kineticReport||null;
 let isoInfo=null,kinInfo=null;
 if(iso){
  isoInfo=summarizeIsotherm(iso,{temperatureK:config.gas.temperatureK,
    feedConcentration:config.gas.feedConcentration,branch:config.gas.direction,pressurePa:config.gas.totalPressurePa});
  notes.push(...isoInfo.notes);
  if(isoInfo.temperatureK!==null&&Math.abs(isoInfo.temperatureK-config.gas.temperatureK)>.5&&!allowTemperatureTransfer)
   needsApproval.push("Isotherm temperature differs from column temperature.");
 }
 if(kin){
  kinInfo=summarizeKinetic(kin);
  if(kinInfo.branch&&kinInfo.branch!=="all"&&kinInfo.branch!==config.gas.direction)
   hard.push("Kinetic adsorption/desorption branch differs from column.");
  if(kinInfo.temperatureK!==null&&Math.abs(kinInfo.temperatureK-config.gas.temperatureK)>.5){
   notes.push("Kinetic calibration temperature differs from column temperature.");
   if(!allowTemperatureTransfer)needsApproval.push("Kinetic temperature transfer requires explicit approval.");
  }else if(kinInfo.temperatureK===null)notes.push("Kinetic report has no calibration temperature.");
  if(kinInfo.equilibriumType==="imported_isotherm"){
   if(!isoInfo)hard.push("Kinetic LDF linked to an isotherm requires importing the same isotherm into Column Studio.");
   else if(kinInfo.signature){
    if(kinInfo.signature!==isoInfo.signature)hard.push("Kinetic linked-isotherm parameters/units do not match selected Column isotherm.");
   }else{
    const legacy=kin.equilibrium||{},units=legacy.sourceUnits||{};
    if(legacy.model&&legacy.model!==isoInfo.model)hard.push("Legacy kinetic equilibrium model differs from Column isotherm.");
    if(norm(units.x)&&norm(units.x)!==norm(isoInfo.xUnit))hard.push("Legacy kinetic pressure units differ from Column isotherm.");
    if(norm(units.q)&&norm(units.q)!==norm(isoInfo.qUnit))hard.push("Legacy kinetic loading units differ from Column isotherm.");
    if(!allowLegacy)needsApproval.push("Legacy Kinetic JSON does not identify the exact fitted isotherm coefficients.");
    notes.push("Legacy kinetic linkage checked by model/units only; original equilibrium coefficients are unverified.");
   }
  }else if(kinInfo.equilibriumType==="fixed_equilibrium"){
   if(!allowFixedTarget)needsApproval.push("Kinetic rate was calibrated with a fixed q*; dynamic column q*(C) is a new assumption.");
   notes.push("Fixed-target LDF rate transfer to a variable-equilibrium column is not independently validated.");
  }else{
   if(!allowLegacy)needsApproval.push("Kinetic LDF equilibrium provenance is absent.");
   notes.push("Kinetic equilibrium provenance was not supplied; compatibility cannot be confirmed.");
  }
 }
 if(hard.length)throw Error(hard.join(" "));
 if(needsApproval.length)throw Error(needsApproval.join(" ")+" Enable explicit transfer/legacy acceptance only if justified.");
 return {schemaVersion:1,equilibrium:isoInfo?{...isoInfo,notes:undefined}:equilibrium?.type||"manual",
  kinetic:kinInfo?{rateConstant:kinInfo.rateConstant,branch:kinInfo.branch,timeUnit:kinInfo.timeUnit,
    equilibriumType:kinInfo.equilibriumType,model:kinInfo.equilibriumModel,signature:kinInfo.signature}:null,
  notes,approvals:{allowLegacy,allowFixedTarget,allowTemperatureTransfer}};
}
