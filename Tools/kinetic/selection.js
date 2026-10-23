import {kineticModel} from "./models.js";
import {fitKinetic} from "./fitting.js";

/* Rolling-origin forward validation: train prefixes, test next samples.
   This is time-ordered within ONE experimental run and not external validation. */
export function forwardValidate(model,data,options={}){
 const n=data.length;if(n<16)return {rmse:null,folds:0,reason:"At least 16 observations required."};
 const fractions=[.55,.70,.85],errors=[],segments=[];
 for(let i=0;i<fractions.length;i++){
   const end=Math.floor(n*fractions[i]),limit=Math.min(n,Math.floor(n*(fractions[i]+.15)));
   const train=data.slice(0,end),valid=data.slice(end,limit);
   if(!valid.length||train.length<model.params.length+4)continue;
   try{
     const fit=fitKinetic(model,train,{...options,forcingRows:options.forcingRows||data,
       q0Fixed:options.q0Fixed??data[0].y,starts:Math.min(4,options.starts??4),seed:(options.seed??20261023)+i*911});
     const yh=fit.predict(valid.map(d=>d.time));
     const sse=valid.reduce((s,d,j)=>s+Math.pow(d.y-yh[j],2),0);
     if(!Number.isFinite(sse))throw Error("Nonfinite validation SSE");
     errors.push({sse,n:valid.length});
     segments.push({train:end,test:valid.length,rmse:Math.sqrt(sse/valid.length)});
   }catch(e){return {rmse:null,folds:segments.length,reason:"Validation split "+(i+1)+": "+e.message};}
 }
 if(!errors.length)return {rmse:null,folds:0,reason:"Not enough points for forward validation."};
 const sse=errors.reduce((s,x)=>s+x.sse,0),tested=errors.reduce((s,x)=>s+x.n,0);
 return {rmse:Math.sqrt(sse/tested),folds:errors.length,segments,reason:null};
}
export async function chooseKinetic(data,{branch="adsorption",eqMode="free",q0Fit=false,
  optimizer="trls",weighted=false,starts=8,seed=20261023,qEquilibrium=null,equilibriumModel=null,forcingInterpolation="linear",
  onProgress=null,yieldTask=null}={}){
 const ids=["pfo","pso","avrami",...(branch!=="desorption"?["elovich"]:[]),
   ...(eqMode!=="free"?["ldf"]:[])];
 const candidates=ids.map(id=>kineticModel(id,{eqMode,q0Fit,branch}));
 const scored=[],failed=[];
 for(let i=0;i<candidates.length;i++){
   const model=candidates[i];onProgress?.(i+1,candidates.length,model.label);
   if(yieldTask)await yieldTask();
   try{
     const opts={branch,eqMode,q0Fit,optimizer,weighted,starts,seed,
       qEquilibrium,equilibriumModel,forcingRows:data,forcingInterpolation};
     const fit=fitKinetic(model,data,opts);
     const cv=forwardValidate(model,data,opts);
     if(cv.rmse===null){failed.push(model.label+": "+cv.reason);continue;}
     scored.push({fit,cv});
   }catch(e){failed.push(model.label+": "+e.message);}
 }
 const sorted=scored.slice().sort((a,b)=>a.cv.rmse-b.cv.rmse||a.fit.metrics.k-b.fit.metrics.k);
 const best=sorted[0]||null;
 const near=best?sorted.filter(x=>x.cv.rmse<=best.cv.rmse*1.05+1e-9):[];
 const winner=near.sort((a,b)=>a.fit.metrics.k-b.fit.metrics.k||a.cv.rmse-b.cv.rmse)[0]||null;
 return {scored:sorted,failed,winner,candidates:ids.length,criterion:
   "3 forward-origin within-run validation splits (next 15% time samples); among models within 5% of minimum RMSE, prefer fewer coefficients. Not an independent experiment."};
}
