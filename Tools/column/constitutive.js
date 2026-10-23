import {readIsothermReport} from "../kinetic/models.js";
const RGAS=8.31446261815324;
const finite=(x)=>Number.isFinite(Number(x))?Number(x):NaN;
const positive=(v,name,allowZero=false)=>{
 const n=finite(v);
 if(!Number.isFinite(n)||(allowZero?n<0:n<=0))throw Error(name+" must be "+(allowZero?"nonnegative":"positive")+" and finite.");
 return n;
};
export function extractKineticRate(report){
 const obj=typeof report==="string"?JSON.parse(report):report;
 if(!obj||obj.tool!=="Adsorp Kinetic Studio"||obj.selected_model!=="ldf"||!Array.isArray(obj.runs))
   throw Error("Import a Kinetic Studio report with selected LDF; empirical PFO/PSO cannot be inserted as a general column rate law.");
 const run=obj.runs.find(r=>r.id==="ldf");
 const rate=positive(run?.parameters?.kLDF,"Imported LDF rate kLDF");
 const unit=String(obj.units?.time||"").trim().toLowerCase();
 const factor={"s":1,"sec":1,"second":1,"seconds":1,"min":60,"minute":60,"minutes":60,"h":3600,"hour":3600,"hours":3600}[unit];
 if(!factor)throw Error("Kinetic time unit must be s, min or h for explicit conversion to s^-1.");
 const qUnit=String(obj.units?.loading||"").trim().toLowerCase().replace(/\s+/g,"");
 if(!["mol/kg","mmol/g"].includes(qUnit))throw Error("Kinetic loading unit must be mol/kg or mmol/g (numerically equal) for this column.");
 return {rateConstant:rate/factor,sourceTimeUnit:unit,sourceModel:"ldf"};
}
export function createEquilibrium(spec,temperatureK,{branch="adsorption",maxConcentration=1}={}){
 if(!spec||typeof spec!=="object")throw Error("Specify a forward equilibrium model.");
 const T=positive(temperatureK,"Temperature");
 let label,q,derivative,source="manual";
 if(spec.type==="henry"){
   const K=positive(spec.henry,"Henry constant",true);
   label="Henry";q=c=>K*c;derivative=()=>K;
 }else if(spec.type==="langmuir"){
   const qm=positive(spec.qMax,"Langmuir maximum loading",true),b=positive(spec.affinity,"Langmuir affinity",true);
   label="Langmuir";q=c=>qm*(b*c)/(1+b*c);derivative=c=>qm*b/(1+b*c)**2;
 }else if(spec.type==="imported"){
   const imported=readIsothermReport(spec.report);
   if(imported.branch&&imported.branch!=="all"&&imported.branch!==branch)
     throw Error("Imported isotherm branch differs from column direction; hysteretic branch switching is unsupported.");
   const pUnit=String(imported.sourceUnits.x||"").trim().toLowerCase().replace(/\s+/g,"");
   const qUnit=String(imported.sourceUnits.q||"").trim().toLowerCase().replace(/\s+/g,"");
   if(!["pa","kpa","bar","mol/m3","mol/m^3"].includes(pUnit))
     throw Error("Imported isotherm x must be Pa, kPa, bar or mol/m3. Convert its input units explicitly.");
   if(!["mol/kg","mmol/g"].includes(qUnit))
     throw Error("Imported q must be mol/kg or mmol/g (numerically equal).");
   const convert=pUnit==="pa"?RGAS*T:pUnit==="kpa"?RGAS*T/1000:pUnit==="bar"?RGAS*T/1e5:1;
   label="Imported "+imported.label;source="isotherm_report";
   q=c=>imported.predict(c*convert);
   derivative=c=>{
     const h=Math.max(1e-8,1e-5*Math.max(c,maxConcentration*0.02));
     return (q(c+h)-q(Math.max(0,c-h)))/(c+h-Math.max(0,c-h));
   };
 }else throw Error("Equilibrium type must be henry, langmuir or imported.");
 const top=positive(maxConcentration,"Equilibrium concentration range",true);
 let prev=0;
 const q0=q(0);
 if(!Number.isFinite(q0)||Math.abs(q0)>1e-8*Math.max(1,q(top)))
   throw Error("Equilibrium must have q*(0)=0 and nonnegative uptake.");
 for(let i=0;i<=64;i++){
   const c=top*i/64,v=q(c);
   if(!Number.isFinite(v)||v< -1e-10||v+1e-10*Math.max(1,prev)<prev)
     throw Error("Equilibrium is negative, nonmonotone or nonfinite over the simulated concentration domain.");
   prev=v;
 }
 return {label,source,qStar(c){
   if(!(c>=0&&Number.isFinite(c)))throw Error("Equilibrium evaluated at invalid gas concentration.");
   const v=q(c);
   if(!Number.isFinite(v)||v< -1e-12)throw Error("Equilibrium evaluated outside physically valid domain.");
   return Math.max(0,v);
 },dqStar(c){const v=derivative(c);if(!Number.isFinite(v)||v< -1e-10)throw Error("Equilibrium slope is nonmonotone/invalid.");return Math.max(0,v);}};
}
export {RGAS};
