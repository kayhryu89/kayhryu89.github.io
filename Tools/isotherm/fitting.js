import {evaluate,resolveModel,makeHybrid} from "./models.js";
import {minimizeProjectedLBFGS} from "./lbfgs.js";

/** Pure-JS bounded projected L-BFGS with legacy LM benchmark.
 * Coefficients are defined for normalized X=x/xScale and Y=q/yScale. */
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sq=x=>x*x;
export function datasetScales(data,relative=false) {
  const xmax=Math.max(...data.map(d=>d.x)), ymax=Math.max(...data.map(d=>d.y));
  if(!(xmax>0&&ymax>0))throw new Error("Input needs positive x and at least one positive q.");
  return {xScale:relative?1:xmax,yScale:ymax};
}
export function normalEquations(A,b) {
  const n=b.length;
  if(!n)return [];
  const m=A.map((row,i)=>[...row,b[i]]);
  for(let k=0;k<n;k++) {
    let pivot=k;
    for(let i=k+1;i<n;i++)if(Math.abs(m[i][k])>Math.abs(m[pivot][k]))pivot=i;
    if(Math.abs(m[pivot][k])<1e-20||!Number.isFinite(m[pivot][k]))return null;
    [m[k],m[pivot]]=[m[pivot],m[k]];
    const div=m[k][k];
    for(let j=k;j<=n;j++)m[k][j]/=div;
    for(let i=0;i<n;i++)if(i!==k){const v=m[i][k];for(let j=k;j<=n;j++)m[i][j]-=v*m[k][j];}
  }
  return m.map(row=>row[n]);
}
const rng=(seed)=>{let s=(seed>>>0)||1;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;}};
export function getModel(id,hybridIds) {
  return id==="hybrid"?makeHybrid(hybridIds):resolveModel(id);
}

export function physicalParameters(model,p,scale) {
  if(model.components){
    let start=0;
    return model.components.flatMap(id=>{
      const part=resolveModel(id),n=part.params.length,ans=physicalParameters(part,p.slice(start,start+n),scale);
      start+=n;return ans;
    });
  }
  const X=scale.xScale,Y=scale.yScale,as=p.slice();
  const byX=(i,power=1)=>{as[i]/=Math.pow(X,power);},byY=i=>{as[i]*=Y;};
  switch(model.id){
    case "henry":as[0]*=Y/X;break;
    case "langmuir":case "jovanovic":byY(0);byX(1);break;
    case "dual_langmuir":case "triple_langmuir":
      for(let i=0;i<p.length;i+=2){byY(i);byX(i+1);}break;
    case "freundlich":as[0]*=Y/Math.pow(X,p[1]);break;
    case "sips":case "toth":case "brouers_sotolongo":case "brouers_gaspard":
      byY(0);byX(1);break;
    case "temkin":byY(0);byX(1);break;
    case "quadratic":byY(0);byX(1);byX(2,2);break;
    case "unilan":byY(0);byX(1);break;
    case "redlich_peterson":case "radke_prausnitz":
      as[0]*=Y/X;byX(1,p[2]);break;
    case "koble_corrigan":
      as[0]*=Y/Math.pow(X,p[2]);byX(1,p[2]);break;
    case "khan":byY(0);byX(1);break;
    case "fritz_schlunder":
      as[0]*=Y/Math.pow(X,p[2]);byX(1,p[3]);break;
    case "jensen_seaton":
      as[0]*=Y/X;byY(1);byX(2);break;
    case "bet":case "gab":case "dubinin_radushkevich":case "dubinin_astakhov":
      byY(0);break;
    case "halsey":as[0]*=Math.pow(Y,p[1]);break;
    case "harkins_jura":as[0]*=Y*Y;break;
    default:throw Error("Physical conversion not defined for "+model.id);
  }
  return as;
}

export function fitOne(model,data,options={}) {
  const count=model.params.length;
  if(data.length<count+1)throw new Error(model.label+": needs at least "+(count+1)+" observations.");
  if(model.relative&&data.some(d=>d.x<0||d.x>model.maxX))throw new Error(model.label+": x must be within [0, "+model.maxX+"].");
  const scale=datasetScales(data,model.relative);
  const xs=data.map(d=>d.x/scale.xScale),ys=data.map(d=>d.y/scale.yScale);
  const weighted=options.weighted===true;
  if(weighted&&data.some(d=>!(d.sigma>0)))throw new Error("Weighted fit requires sigma>0 for every observation.");
  const ws=data.map(d=>weighted?scale.yScale/d.sigma:1);
  const seed=options.seed??20261023;
  const rand=rng(seed+(model.id.length*97));
  const starts=clamp(Math.floor(options.starts??8),1,40);
  const optimizer=options.optimizer??"lbfgs";
  if(!["lbfgs","lm"].includes(optimizer))throw Error("Unsupported optimizer: "+optimizer);
  const maxIter=clamp(Math.floor(options.maxIter??(optimizer==="lbfgs"?230:140)),25,600);
  const ps=model.params, lows=ps.map(p=>Math.log(p.low)), highs=ps.map(p=>Math.log(p.high));
  const decode=z=>z.map((v,i)=>Math.exp(clamp(v,lows[i],highs[i])));
  function residual(z) {
    const p=decode(z),r=new Array(data.length);let total=0;
    for(let i=0;i<r.length;i++) {
      const val=evaluate(model,xs[i],p);
      if(!Number.isFinite(val)||val>1e10)return null;
      const e=(val-ys[i])*ws[i];
      if(!Number.isFinite(e))return null;
      r[i]=e;total+=e*e;
    }
    return {r,cost:total};
  }
  function jacobian(z,base) {
    const J=Array.from({length:base.r.length},()=>Array(count).fill(0));
    for(let j=0;j<count;j++){
      const trial=z.slice(),dz=1e-4;
      trial[j]=clamp(z[j]+dz,lows[j],highs[j]);
      if(trial[j]===z[j])trial[j]=clamp(z[j]-dz,lows[j],highs[j]);
      const h=trial[j]-z[j];
      if(!h)continue;
      const next=residual(trial);
      if(!next)return null;
      for(let i=0;i<base.r.length;i++)J[i][j]=(next.r[i]-base.r[i])/h;
    }
    const H=Array.from({length:count},()=>Array(count).fill(0));
    const g=Array(count).fill(0);
    for(let i=0;i<J.length;i++)for(let j=0;j<count;j++){
      g[j]+=J[i][j]*base.r[i];
      for(let k=0;k<=j;k++)H[j][k]+=J[i][j]*J[i][k];
    }
    for(let j=0;j<count;j++)for(let k=0;k<j;k++)H[k][j]=H[j][k];
    return {H,g};
  }

  function objective(z,withGradient=false) {
    const curr=residual(z);
    if(!curr)return null;
    if(!withGradient)return {cost:curr.cost};
    const grad=Array(count).fill(0);
    for(let j=0;j<count;j++){
      const step=2e-5*Math.max(1,Math.abs(z[j]));
      const plus=z.slice(),minus=z.slice();
      plus[j]=Math.min(highs[j],z[j]+step);
      minus[j]=Math.max(lows[j],z[j]-step);
      const rp=plus[j]===z[j]?null:residual(plus);
      const rm=minus[j]===z[j]?null:residual(minus);
      if(rp&&rm){
        const delta=plus[j]-minus[j];
        for(let i=0;i<curr.r.length;i++)grad[j]+=2*curr.r[i]*(rp.r[i]-rm.r[i])/delta;
      }else if(rp){
        const delta=plus[j]-z[j];
        for(let i=0;i<curr.r.length;i++)grad[j]+=2*curr.r[i]*(rp.r[i]-curr.r[i])/delta;
      }else if(rm){
        const delta=z[j]-minus[j];
        for(let i=0;i<curr.r.length;i++)grad[j]+=2*curr.r[i]*(curr.r[i]-rm.r[i])/delta;
      }else return null;
    }
    return {cost:curr.cost,grad};
  }
  let best=null, attempts=0, successCount=0, convergedCount=0;
  for(let start=0;start<starts;start++){
    const z=ps.map((p,i)=>clamp(start===0?Math.log(p.guess):Math.log(p.guess)+(rand()-.5)*7,lows[i],highs[i]));
    if(optimizer==="lbfgs"){
      const run=minimizeProjectedLBFGS(objective,z,lows,highs,{
        maxIter,memory:options.lbfgsMemory??7,gtol:options.gtol??1e-7});
      if(!Number.isFinite(run.cost))continue;
      attempts++;
      if(run.accepted>0)successCount++;
      if(run.converged)convergedCount++;
      if(!best||run.cost<best.cost)best={...run,z:run.z.slice()};
      continue;
    }
    // Legacy damped Levenberg-Marquardt retained for numerical comparison.
    let curr=residual(z),lambda=0.01,accepted=0;
    if(!curr)continue;
    attempts++;
    for(let it=0;it<maxIter;it++){
      const j=jacobian(z,curr);if(!j)break;
      const {H,g}=j;
      if(Math.max(...g.map(Math.abs))<1e-9)break;
      let improved=false;
      for(let trial=0;trial<13;trial++){
        const mat=H.map((row,i)=>row.map((v,k)=>i===k?v+lambda*(H[i][i]+1e-3):v));
        const step=normalEquations(mat,g.map(v=>-v));
        if(!step)break;
        const nextZ=z.map((v,i)=>clamp(v+clamp(step[i],-1.7,1.7),lows[i],highs[i]));
        const next=residual(nextZ);
        if(next&&next.cost<curr.cost-1e-13){
          const delta=curr.cost-next.cost;
          z.splice(0,z.length,...nextZ);
          curr=next;lambda=Math.max(1e-9,lambda*.35);
          accepted++;improved=true;
          if(delta<1e-12*(1+curr.cost))it=maxIter;
          break;
        }
        lambda*=5;
      }
      if(!improved)break;
    }
    if(accepted>0)successCount++;
    if(curr&&(!best||curr.cost<best.cost))best={z:z.slice(),cost:curr.cost,accepted,converged:null,
      reason:"legacy_lm_no_convergence_certificate"};
  }
  if(!best)throw new Error("Optimization returned no valid finite parameters.");
  const coeffs=decode(best.z),physical=physicalParameters(model,coeffs,scale),yhat=xs.map(x=>evaluate(model,x,coeffs)*scale.yScale);
  if(yhat.some(v=>!Number.isFinite(v)))throw new Error("Nonfinite model predictions.");
  let sse=0,sst=0;
  const mean=data.reduce((a,d)=>a+d.y,0)/data.length;
  data.forEach((d,i)=>{sse+=sq(d.y-yhat[i]);sst+=sq(d.y-mean);});
  const n=data.length,k=count;
  const aic=n*Math.log(Math.max(sse/n,1e-24))+2*k;
  const aicc=n>k+1?aic+(2*k*(k+1))/(n-k-1):null;
  const bic=n*Math.log(Math.max(sse/n,1e-24))+k*Math.log(n);
  const lastJac=jacobian(best.z,residual(best.z));
  const diag=lastJac?lastJac.H.map((row,i)=>row[i]):[];
  const positive=diag.filter(v=>v>1e-16);
  const diagRatio=positive.length===k?Math.max(...positive)/Math.min(...positive):Infinity;
  const warnings=[];
  if(diagRatio>1e9)warnings.push("Jacobian may be ill-conditioned; coefficient uncertainty is not reliable.");
  if(optimizer==="lbfgs"&&!best.converged)warnings.push("Lowest-cost L-BFGS start did not meet projected-gradient convergence; reason: "+best.reason+".");
  coeffs.forEach((v,i)=>{if(v<=ps[i].low*1.001||v>=ps[i].high*.999)warnings.push(ps[i].name+" reached a parameter bound.");});
  if(model.caution)warnings.push(model.caution);
  if(model.alias)warnings.push(model.alias);
  if(weighted)warnings.push("AICc/BIC not reported for weighted fits using the unweighted SSE formula.");
  if(n<=k+1)warnings.push("Insufficient residual degrees of freedom for AICc.");
  return {
    id:model.id,label:model.label,params:coeffs,physicalParameters:physical,paramNames:ps.map(p=>p.name),
    scale,relative:model.relative,modelComponents:model.components||null,
    observed:data.map((d,i)=>({...d,pred:yhat[i],residual:d.y-yhat[i]})),
    metrics:{n,k,rmse:Math.sqrt(sse/n),r2:sst>0?1-sse/sst:null,
      aicc:weighted?null:aicc,bic:weighted?null:bic,sse,weighted},
    convergence:{algorithm:optimizer==="lbfgs"?"projected_l_bfgs":"legacy_lm",attempts,successCount,convergedCount,accepted:best.accepted,seed,starts,reason:best.reason,converged:best.converged,projectedGradient:best.projectedGradient??null,iterations:best.iterations??null,evaluations:best.evaluations??null},
    diagRatio,warnings,
    predict(x){return evaluate(model,x/scale.xScale,coeffs)*scale.yScale;}
  };
}
function tokenizeCSVLine(line,delimiter) {
  const result=[];let field="",quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){if(quoted&&line[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===delimiter&&!quoted){result.push(field.trim());field="";}
    else field+=c;
  }
  result.push(field.trim());return result;
}
export function parseTable(text,branch="adsorption") {
  const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith("#"));
  if(!lines.length)throw Error("Paste or upload CSV data first.");
  const first=lines[0];
  const counts=[",",";","\t"].map(d=>({d,n:tokenizeCSVLine(first,d).length}));
  counts.sort((a,b)=>b.n-a.n);
  const delimiter=counts[0].n>1?counts[0].d:",";
  const rows=lines.map(x=>tokenizeCSVLine(x,delimiter));
  const hasHeader=rows[0].slice(0,2).some(v=>!Number.isFinite(Number(v)));
  const header=(hasHeader?rows.shift():["x","q"]).map(x=>x.toLowerCase().trim());
  const column=(choices,fallback)=>{const i=header.findIndex(h=>choices.some(t=>h===t||(t.length>=3&&h.includes(t))));return i>=0?i:fallback;};
  const xi=column(["pressure","p/p0","concentration","relative_p","activity","x","p"],0);
  const yi=column(["loading","uptake","adsorbed","capacity","q","qe"],1);
  const si=column(["sigma","stddev","std_error","uncertainty"],-1);
  const bi=column(["branch","direction"],-1);
  let rejected=0,wrongBranch=0;
  const data=[];
  for(const row of rows){
    if(row.length<2)continue;
    const b=bi>=0?(row[bi]||"adsorption").toLowerCase().trim():"adsorption";
    if(branch!=="all"&&b&&b!=="all"&&!(branch==="adsorption"?["adsorption","ads","a"].includes(b):["desorption","des","d"].includes(b))){wrongBranch++;continue;}
    const x=Number(row[xi]),y=Number(row[yi]);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0){rejected++;continue;}
    const sigma=si>=0&&row[si]!==""?Number(row[si]):undefined;
    if(si>=0&&row[si]!==""&&!(sigma>0)){rejected++;continue;}
    data.push({x,y,...(sigma===undefined?{}:{sigma})});
  }
  if(data.length<3)throw Error("At least three valid rows required for the selected adsorption/desorption branch.");
  data.sort((a,b)=>a.x-b.x);
  if(Math.max(...data.map(d=>d.x))<=0||Math.max(...data.map(d=>d.y))<=0)throw Error("Need positive x and q values.");
  return {data,columns:{x:header[xi],y:header[yi]},skipped:rejected,otherBranch:wrongBranch};
}
export function csvExport(result) {
  return "x,q_observed,q_predicted,residual\n"+result.observed.map(d=>
    [d.x,d.y,d.pred,d.residual].map(x=>Number(x).toPrecision(12)).join(",")).join("\n")+"\n";
}
