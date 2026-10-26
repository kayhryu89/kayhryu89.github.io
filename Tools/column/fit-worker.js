import {fitColumnBreakthrough} from "./breakthrough_fit.js";
self.onmessage=async event=>{
 const msg=event.data||{};
 if(msg.type!=="fit")return;
 try{
  const result=await fitColumnBreakthrough(msg.payload,{
   onProgress:p=>self.postMessage({type:"progress",...p}),
   yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0))});
  self.postMessage({type:"result",result});
 }catch(e){self.postMessage({type:"error",message:e?.message||String(e)});}
};