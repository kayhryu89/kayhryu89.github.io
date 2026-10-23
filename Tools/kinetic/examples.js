import {ldfTrajectory} from "./models.js";
const perturb=(i)=>1+.008*Math.sin(i*2.15)+.004*Math.cos(i*.87);
const pfo=Array.from({length:43},(_,i)=>{const time=i*1.5;
  const y=3.1*(1-Math.exp(-.115*time));
  return {time,y:i===0?0:y*perturb(i),pressure:1,branch:"adsorption"};});
const pso=Array.from({length:41},(_,i)=>{const time=i*1.25,qe=2.6,k=.08;
  const y=qe-qe/(1+k*qe*time);return{time,y:i===0?0:y*perturb(i),pressure:1,branch:"adsorption"};});
const press=Array.from({length:61},(_,i)=>{
  const time=i*.5,pressure=time<8?.35:time<16?1.4:time<23?.65:1.9;
  return {time,pressure,equilibrium:2.9*1.6*pressure/(1+1.6*pressure)};
});
const qprofile=ldfTrajectory(press.map(d=>d.time),press,0,.23,0,"hold");
const forcing=press.map((r,i)=>({time:r.time,pressure:r.pressure,
  y:i===0?0:Math.max(0,qprofile[i]*perturb(i)),branch:"adsorption"}));
export const KINETIC_EXAMPLES=[
  {id:"synthetic_pfo",name:"PFO uptake (synthetic)",description:"Synthetic uptake, q_e=3.1, k=0.115 min^-1; fixed first q0=0, deterministic perturbation.",rows:pfo},
  {id:"synthetic_pso",name:"PSO uptake (synthetic)",description:"Synthetic PSO uptake, q_e=2.6, k2=0.08 (mmol/g)^-1 min^-1; small deterministic perturbation.",rows:pso},
  {id:"synthetic_ldf_pressure",name:"Pressure-step LDF (synthetic)",description:"Synthetic LDF transient with stepwise pressure input and Langmuir equilibrium. k=0.23 min^-1. Demo isotherm report automatically loaded; pressure transitions use zero-order hold (step changes).",rows:forcing,linked:true}
];
export const DEMO_ISOTHERM_REPORT={
  schema_version:"0.1",tool:"Adsorp Supporting Tool",selected_model:"langmuir",
  units:{x:"bar",q:"mmol/g"},runs:[{id:"langmuir",label:"Langmuir (synthetic reference)",params:{qm:2.9,b:1.6},xScale:1,yScale:1}]
};
export function kineticExampleCSV(ex){return "time,loading,pressure,branch\n"+ex.rows.map(r=>[r.time,r.y,r.pressure,r.branch].join(",")).join("\n");}
