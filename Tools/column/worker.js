import {simulateColumn} from "./solver.js";
import {simulateOcfe1D} from "./ocfe1d_experimental.js";
import {simulateThermalColumn} from "./thermal2d.js";
import {simulateFvBe1D} from "./fv1d_be.js";
import {simulateGlobalOc1D} from "./global_oc1d.js";
import {simulateGlobalOc2D} from "./global_oc2d.js";
import {simulateGlobalOcThermal2D} from "./global_oc_thermal2d.js";
import {simulateFvBe2D} from "./fv2d_be.js";
let active=null;
self.onmessage=async event=>{
 const msg=event.data||{};
 if(msg.type==="cancel"){if(active)active.cancelled=true;return;}
 if(msg.type!=="run"||active){self.postMessage({type:"error",message:"A run is already active."});return;}
 const run={cancelled:false};active=run;
 try{
   if(["ocfe1d","fvbe1d","globaloc1d","fvbe2d"].includes(msg.solverMode)&&msg.config?.thermal?.enabled)
    throw Error("Selected solver does not support nonisothermal mode; choose 2D Global OC or 2D FVM.");
   const solver=msg.solverMode==="globaloc2d"?(msg.config?.thermal?.enabled?simulateGlobalOcThermal2D:simulateGlobalOc2D):
     msg.solverMode==="fvbe2d"?simulateFvBe2D:
     msg.solverMode==="globaloc1d"?simulateGlobalOc1D:
     msg.solverMode==="ocfe1d"?simulateOcfe1D:
     msg.solverMode==="fvbe1d"?simulateFvBe1D:
     msg.config?.thermal?.enabled?simulateThermalColumn:simulateColumn;
   const result=await solver(msg.config,{
     onProgress:p=>self.postMessage({type:"progress",...p}),
     yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0)),
     shouldAbort:()=>run.cancelled});
   if(run.cancelled)self.postMessage({type:"cancelled"});
   else self.postMessage({type:"result",result});
 }catch(e){
   if(run.cancelled)self.postMessage({type:"cancelled"});
   else self.postMessage({type:"error",message:e?.message||String(e)});
 }finally{active=null;}
};
