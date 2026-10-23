import {resolveModel,makeHybrid,evaluate as evaluateIsotherm} from "../isotherm/models.js";

/* All kinetic coefficients are in normalized T=(t-t0)/tScale, Q=q/qScale.
   The first observed q is the fixed initial condition unless q0Fit is enabled.
   PFO and constant-target LDF are the SAME ODE, not independent candidates. */
const par=(name,guess,low=1e-7,high=1e4)=>({name,guess,low,high});
const basic={
 pfo:{id:"pfo",label:"Pseudo-first-order (PFO)",kind:"empirical",params:[par("qe",1,1e-5,100),par("k1",2,1e-5,300)],
 formula:"q=q_e+(q_0-q_e)exp(-k_1 t); identical to constant-target LDF"},
 pso:{id:"pso",label:"Pseudo-second-order (PSO)",kind:"empirical",params:[par("qe",1,1e-5,100),par("k2",2,1e-6,1000)],
 formula:"q=q_e-(q_e-q_0)/(1+k_2 |q_e-q_0|t); signed desorption extension"},
 elovich:{id:"elovich",label:"Elovich (adsorption only)",kind:"empirical",params:[par("alpha",1,.00001,10000),par("beta",2,.0001,500)],
 formula:"q=q_0+ln(1+alpha beta t)/beta; adsorption only"},
 avrami:{id:"avrami",label:"Avrami fractional-order",kind:"empirical",params:[par("qe",1,1e-5,100),par("kA",2,1e-5,300),par("nA",1,.2,5)],
 formula:"q=q_0+(q_e-q_0)(1-exp[-(k_A t)^n_A])"},
 diffusion:{id:"diffusion",label:"Weber–Morris (diagnostic)",kind:"diagnostic",params:[par("c",.1,1e-9,100),par("kID",1,1e-8,100)],
 formula:"q=c+k_ID sqrt(t); empirical uptake diagnostic, not a transport ODE"},
 ldf:{id:"ldf",label:"Linear driving force (LDF)",kind:"column",params:[par("kLDF",2,1e-5,300)],
 formula:"dq/dt=k_LDF(q*(P(t),T)-q); q* fixed or imported equilibrium"}
};
export const KINETIC_MODELS=Object.freeze(Object.values(basic));
export function kineticModel(id,{eqMode="free",q0Fit=false,branch="adsorption"}={}){
 const m=basic[id];if(!m)throw Error("Unknown kinetic model "+id);
 if(id==="ldf"&&eqMode==="free")throw Error("LDF needs a fixed q* or imported isotherm. With free q*, use PFO instead.");
 if(id==="elovich"&&branch==="desorption")throw Error("Elovich uptake model is adsorption-only.");
 if(id==="diffusion"&&branch==="desorption")throw Error("Weber–Morris uptake diagnostic is adsorption-only.");
 return {...m,params:[...m.params,...(q0Fit&&id!=="diffusion"?[par("q0",.3,1e-8,100)]:[])]};
}
export function readIsothermReport(json,{pressureUnit,loadingUnit}={}){
 const report=typeof json==="string"?JSON.parse(json):json;
 if(!report||!Array.isArray(report.runs)||!report.selected_model)throw Error("Invalid Isotherm Studio report.");
 const run=report.runs.find(r=>r.id===report.selected_model);
 if(!run)throw Error("Selected isotherm not found in report runs.");
 const components=run.components||report.selected_components||null;
 const model=components?.length?makeHybrid(components):resolveModel(run.id);
 const xScale=Number(run.xScale),yScale=Number(run.yScale);
 if(!(xScale>0&&yScale>0))throw Error("Invalid isotherm normalization scales.");
 if(pressureUnit!=null&&String(report.units?.x||"").trim().toLowerCase()!==String(pressureUnit).trim().toLowerCase())
   throw Error("Pressure units differ from isotherm report. Convert CSV pressure values first.");
 if(loadingUnit!=null&&String(report.units?.q||"").trim().toLowerCase()!==String(loadingUnit).trim().toLowerCase())
   throw Error("Loading units differ from isotherm report. Convert CSV uptake values first.");
 const p=model.params.map(param=>Number(run.params?.[param.name]));
 if(!p.every(v=>Number.isFinite(v)&&v>0))throw Error("Missing or nonpositive scaled isotherm parameters.");
 return {id:model.id,label:run.label||model.label,model,params:p,xScale,yScale,
   sourceUnits:{x:report.units?.x,q:report.units?.q},sourceModel:report.selected_model,
   branch:report.branch||null,
   predict(pressure){return evaluateIsotherm(model,pressure/xScale,p)*yScale;}};
}
export function interpolate(rows,time,key){
 if(time<=rows[0].time)return rows[0][key];
 if(time>=rows.at(-1).time)return rows.at(-1)[key];
 let lo=0,hi=rows.length-1;
 while(hi-lo>1){const mid=(lo+hi)>>1;if(rows[mid].time<=time)lo=mid;else hi=mid;}
 return rows[lo][key]+(rows[hi][key]-rows[lo][key])*(time-rows[lo].time)/(rows[hi].time-rows[lo].time);
}
/* Exact step response for equilibrium varying linearly between TWO forcing
   knots. For nonlinear q*(P), the input q* is interpolated, not evaluated on
   hidden subintervals; enough pressure/uptake samples are needed. */
export function integrateLdfLinear(q,k,dt,qa,qb){
 if(dt<0||!(k>=0))throw Error("Invalid LDF step.");
 const u=k*dt;
 if(u===0)return q;
 const oneMinus=-Math.expm1(-u),e=Math.exp(-u);
 const weight=u<1e-4?u/2-u*u/6+u*u*u/24:1-oneMinus/u;
 return e*q+oneMinus*qa+weight*(qb-qa);
}
export function ldfTrajectory(times,forcing,q0,k,tOrigin,interpolation="linear"){
 if(!["linear","hold"].includes(interpolation))throw Error("Forcing interpolation must be linear or hold.");
 if(!times.length)return [];
 const path=forcing.slice().sort((a,b)=>a.time-b.time);
 if(!path.length||path[0].time>tOrigin+1e-10)throw Error("Forcing must include initial time.");
 if(times.some((v,i)=>!Number.isFinite(v)||(i>0&&v<times[i-1]-1e-12)))
   throw Error("LDF prediction times must be finite and sorted in nondecreasing order.");
 if(path.some((r,i)=>!Number.isFinite(r.time)||!Number.isFinite(r.equilibrium)||r.equilibrium<0||(i>0&&r.time<=path[i-1].time)))
   throw Error("LDF forcing timestamps must be strictly increasing with nonnegative equilibrium.");
 const out=[];let t=tOrigin,q=q0,index=0;
 function forcingAt(x){
   if(interpolation==="linear")return interpolate(path,x,"equilibrium");
   let l=0,r=path.length-1;
   while(l<r){const mid=Math.ceil((l+r)/2);if(path[mid].time<=x+1e-12)l=mid;else r=mid-1;}
   return path[l].equilibrium;
 }
 for(const time of times){
   if(time<tOrigin-1e-9)throw Error("Prediction before calibration start is unsupported.");
   while(index+1<path.length&&path[index+1].time<=time+1e-10){
     const next=path[++index];if(next.time>t){const a=forcingAt(t);q=integrateLdfLinear(q,k,next.time-t,a,interpolation==="hold"?a:next.equilibrium);t=next.time;}
   }
   if(time>t){q=integrateLdfLinear(q,k,time-t,forcingAt(t),interpolation==="hold"?forcingAt(t):forcingAt(time));t=time;}
   out.push(q);
 }
 return out;
}
export function evaluateKinetic(id,params,t,q0,{equilibrium=null}={}){
 if(t<0)throw Error("Negative elapsed time.");
 if(id==="ldf")return equilibrium+(q0-equilibrium)*Math.exp(-params[0]*t);
 if(id==="pfo"){const [qe,k]=params;return qe+(q0-qe)*Math.exp(-k*t);}
 if(id==="pso"){const [qe,k]=params,delta=qe-q0;return qe-delta/(1+k*Math.abs(delta)*t);}
 if(id==="elovich"){const [a,b]=params;return q0+Math.log1p(a*b*t)/b;}
 if(id==="avrami"){const [qe,k,n]=params;return q0+(qe-q0)*(-Math.expm1(-Math.pow(k*t,n)));}
 if(id==="diffusion"){const [c,k]=params;return c+k*Math.sqrt(t);}
 throw Error("Unknown kinetic formula "+id);
}
export function parameterPhysical(id,params,tScale,qScale){
 return params.map((v,i)=>{
  const name=basic[id].params[i]?.name||"q0";
  if(name==="qe"||name==="c"||name==="q0")return v*qScale;
  if(name==="k1"||name==="kA"||name==="kLDF")return v/tScale;
  if(name==="k2")return v/(qScale*tScale);
  if(name==="alpha")return v*qScale/tScale;
  if(name==="beta")return v/qScale;
  if(name==="kID")return v*qScale/Math.sqrt(tScale);
  return v;
 });
}
