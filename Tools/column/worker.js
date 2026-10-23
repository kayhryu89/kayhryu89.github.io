import {simulateColumn} from "./solver.js";
let active=null;
self.onmessage=async event=>{
 const msg=event.data||{};
 if(msg.type==="cancel"){if(active)active.cancelled=true;return;}
 if(msg.type!=="run"||active){self.postMessage({type:"error",message:"A run is already active."});return;}
 const run={cancelled:false};active=run;
 try{
   const result=await simulateColumn(msg.config,{
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
