import {resolveModel,makeHybrid,evaluate} from "./models.js";
import {physicalParameters} from "./fitting.js";

/**
 * Local practical identifiability (NOT proof of structural identifiability):
 * numerical Jacobian of q with respect to log scaled coefficients at the
 * measured x values, optionally whitened using supplied standard deviations.
 * Columns are normalized before a symmetric Jacobi eigenanalysis so condition
 * diagnostics are not dominated by parameter units/magnitudes.
 */
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const norm=x=>Math.sqrt(dot(x,x));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function symmetricEigen(A,{maxSweeps=160,tol=1e-13}={}) {
  const n=A.length;
  if(!n||A.some(row=>row.length!==n))throw Error("Symmetric square matrix required.");
  const a=A.map(row=>row.slice()),v=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));
  for(let sweep=0;sweep<maxSweeps*n*n;sweep++){
    let p=0,q=0,big=0;
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const x=Math.abs(a[i][j]);if(x>big){big=x;p=i;q=j;}}
    const diag=Math.max(1,...a.map((row,i)=>Math.abs(row[i])));
    if(big<=tol*diag)break;
    const t0=(a[q][q]-a[p][p])/(2*a[p][q]);
    const t=(t0>=0?1:-1)/(Math.abs(t0)+Math.sqrt(1+t0*t0));
    const c=1/Math.sqrt(1+t*t),s=t*c;
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    a[p][p]=app-t*apq;a[q][q]=aqq+t*apq;a[p][q]=0;a[q][p]=0;
    for(let k=0;k<n;k++)if(k!==p&&k!==q){
      const akp=a[k][p],akq=a[k][q];
      a[k][p]=a[p][k]=c*akp-s*akq;
      a[k][q]=a[q][k]=s*akp+c*akq;
    }
    for(let k=0;k<n;k++){
      const x=v[k][p],y=v[k][q];v[k][p]=c*x-s*y;v[k][q]=s*x+c*y;
    }
  }
  return a.map((row,j)=>({value:row[j],vector:v.map(r=>r[j])})).sort((x,y)=>y.value-x.value);
}
function internalModel(fit){return fit.modelComponents?makeHybrid(fit.modelComponents):resolveModel(fit.id);}
export function diagnoseIdentifiability(fit,data,{rankTolerance=1e-6}={}) {
  const model=internalModel(fit),k=model.params.length,n=data.length;
  if(!k||n<=k||data.some(d=>!Number.isFinite(d.x)||!Number.isFinite(d.y)))throw Error("Insufficient or invalid data for local identifiability.");
  if(data.length!==fit.observed.length||!data.every((d,i)=>d.x===fit.observed[i].x&&d.y===fit.observed[i].y))
    throw Error("Data must match the fitted observations.");
  const logTheta=fit.params.map(v=>Math.log(v)),lo=model.params.map(p=>Math.log(p.low)),hi=model.params.map(p=>Math.log(p.high));
  const base=data.map(d=>fit.predict(d.x)),isWeighted=fit.metrics.weighted;
  const weights=data.map(d=>isWeighted?1/d.sigma:1);
  const columns=[];
  for(let j=0;j<k;j++){
    const h=1e-4,plus=logTheta.slice(),minus=logTheta.slice();
    plus[j]=clamp(plus[j]+h,lo[j],hi[j]);minus[j]=clamp(minus[j]-h,lo[j],hi[j]);
    if(plus[j]===minus[j])throw Error("Cannot perturb parameter "+model.params[j].name);
    const pp=plus.map(Math.exp),pm=minus.map(Math.exp);
    const sens=data.map((d,i)=>{
      const x=d.x/fit.scale.xScale;
      const v1=evaluate(model,x,pp)*fit.scale.yScale;
      const v0=evaluate(model,x,pm)*fit.scale.yScale;
      return (v1-v0)/(plus[j]-minus[j])*weights[i];
    });
    if(!sens.every(Number.isFinite))throw Error("Nonfinite local sensitivity for "+model.params[j].name);
    columns.push(sens);
  }
  const norms=columns.map(norm),maxNorm=Math.max(...norms);
  const tiny=1e-9*Math.max(1e-12,maxNorm);
  const active=norms.map(v=>v>tiny);
  const normcols=columns.map((a,i)=>active[i]?a.map(v=>v/norms[i]):a.map(()=>0));
  const gram=normcols.map(a=>normcols.map(b=>dot(a,b)));
  const eig=symmetricEigen(gram);
  const singular=eig.map(x=>Math.sqrt(Math.max(0,x.value)));
  const top=singular[0]||0,rank=singular.filter(s=>top>0&&s>rankTolerance*top).length;
  const cond=rank===k&&singular.at(-1)>0?top/singular.at(-1):Infinity;
  const bound=model.params.map((p,i)=>fit.params[i]<=p.low*1.003||fit.params[i]>=p.high*.997);
  const sensitivityCorrelation=normcols.map(a=>normcols.map(b=>clamp(dot(a,b),-1,1)));
  let covarianceCorrelation=null,approxLogSE=null,approxPhysicalSE=null;
  // This covariance is only a local linearized approximation. Singular /
  // near-singular cases are excluded rather than made to look precise.
  if(rank===k&&cond<1e7&&!bound.some(Boolean)) {
    const inverse=Array.from({length:k},()=>Array(k).fill(0));
    eig.forEach(({value,vector})=>{
      if(!(value>0))return;
      for(let i=0;i<k;i++)for(let j=0;j<k;j++){
        inverse[i][j]+=vector[i]*vector[j]/(value*norms[i]*norms[j]);
      }
    });
    const factor=isWeighted?1:(fit.metrics.sse/(n-k));
    approxLogSE=inverse.map((row,i)=>Math.sqrt(Math.max(0,row[i]*factor)));
    // A physical coefficient can depend on multiple fitted coefficients
    // (e.g. Freundlich KF), so propagate covariance by the delta method.
    const transform=Array.from({length:k},()=>Array(k).fill(0));
    for(let j=0;j<k;j++){
      const z1=logTheta.slice(),z0=logTheta.slice(),h=1e-4;
      z1[j]=Math.min(hi[j],z1[j]+h);z0[j]=Math.max(lo[j],z0[j]-h);
      const v1=physicalParameters(model,z1.map(Math.exp),fit.scale);
      const v0=physicalParameters(model,z0.map(Math.exp),fit.scale);
      for(let i=0;i<k;i++)transform[i][j]=(v1[i]-v0[i])/(z1[j]-z0[j]);
    }
    const propagated=Array.from({length:k},(_,i)=>Array.from({length:k},(_,j)=>{
      let v=0;
      for(let a=0;a<k;a++)for(let b=0;b<k;b++)v+=transform[i][a]*inverse[a][b]*transform[j][b]*factor;
      return v;
    }));
    approxPhysicalSE=propagated.map((row,i)=>Math.sqrt(Math.max(0,row[i])));
    covarianceCorrelation=propagated.map((row,i)=>row.map((v,j)=>{
      const den=Math.sqrt(Math.max(0,propagated[i][i]*propagated[j][j]));
      return den>0?clamp(v/den,-1,1):null;
    }));
  }
  const pairs=[];
  for(let i=0;i<k;i++)for(let j=i+1;j<k;j++){
    const score=sensitivityCorrelation[i][j],approx=covarianceCorrelation?.[i]?.[j]??null;
    if(Math.abs(score)>=.95||approx!=null&&Math.abs(approx)>=.95)
      pairs.push({a:model.params[i].name,b:model.params[j].name,sensitivity:score,parameterCorrelation:approx});
  }
  pairs.sort((a,b)=>Math.max(Math.abs(b.sensitivity),Math.abs(b.parameterCorrelation??0))-Math.max(Math.abs(a.sensitivity),Math.abs(a.parameterCorrelation??0)));
  const warnings=[];
  if(rank<k)warnings.push("Local scaled Jacobian is rank deficient; individual parameters are not locally identifiable from this dataset.");
  if(cond>1e6)warnings.push("Very high sensitivity condition number (>1e6); numerical parameter estimates may be unstable.");
  if(pairs.length)warnings.push(pairs.length+" strongly coupled parameter pair(s) (absolute correlation ≥0.95).");
  if(bound.some(Boolean))warnings.push("One or more parameters are at fitted bounds; regular covariance-based inference is unreliable.");
  if(model.id==="dual_langmuir"||model.id==="triple_langmuir"||model.components?.some((id,i,a)=>a.indexOf(id)!==i))
    warnings.push("Exchangeable site labels create permutation ambiguity; bootstrap draws must be aligned before reporting site-specific parameter intervals.");
  if(n<4*k)warnings.push("Only "+n+" measurements for "+k+" coefficients: practical identifiability may be limited.");
  if(isWeighted)warnings.push("Local curvature assumes input sigma represent independent known observation standard deviations.");
  return {
    kind:"local_practical_identifiability",n,k,rank,rankTolerance,conditionNumber:cond,
    singularValues:singular,columnNorms:norms,active,boundFlags:bound,
    sensitivityCorrelation,parameterCorrelation:covarianceCorrelation,approxLogSE,approxPhysicalSE,
    parameterCorrelationBasis:covarianceCorrelation?"delta_method_physical_input_units":"not_available",
    coupledPairs:pairs,warnings,
    note:"Local log-parameter sensitivity analysis within measured x; not a structural identifiability proof."
  };
}
