/**
 * Box-constrained projected limited-memory BFGS optimization.
 *
 * Standard limited-memory BFGS two-loop recursion, with projected Armijo
 * backtracking and active constraints. This is NOT the generalized-Cauchy-
 * point algorithm of canonical Fortran/SciPy L-BFGS-B.
 *
 * evaluate(z, needGradient): {cost, grad} if true, {cost} if false.
 */
const clip=(v,l,h)=>Math.max(l,Math.min(h,v));
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const normInf=a=>a.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
function pgVector(z,g,lower,upper) {
  return g.map((v,i)=>{
    const tol=1e-10*Math.max(1,Math.abs(z[i]));
    if(z[i]<=lower[i]+tol&&v>0)return 0;
    if(z[i]>=upper[i]-tol&&v<0)return 0;
    return v;
  });
}
function directionFromHistory(pg,sList,yList,rhos) {
  const n=pg.length,m=sList.length;
  const q=pg.slice(),alpha=Array(m);
  for(let j=m-1;j>=0;j--){
    alpha[j]=rhos[j]*dot(sList[j],q);
    for(let i=0;i<n;i++)q[i]-=alpha[j]*yList[j][i];
  }
  const sy=m?dot(sList[m-1],yList[m-1]):1;
  const yy=m?dot(yList[m-1],yList[m-1]):1;
  const gamma=clip(sy/Math.max(yy,1e-30),1e-5,1e5);
  const r=q.map(v=>gamma*v);
  for(let j=0;j<m;j++){
    const beta=rhos[j]*dot(yList[j],r);
    for(let i=0;i<n;i++)r[i]+=sList[j][i]*(alpha[j]-beta);
  }
  return r.map(v=>-v);
}
function feasibleDirection(z,d,lower,upper) {
  return d.map((v,i)=>{
    if(z[i]<=lower[i]+1e-12 && v<0)return 0;
    if(z[i]>=upper[i]-1e-12 && v>0)return 0;
    return v;
  });
}
export function minimizeProjectedLBFGS(evaluate,initial,lower,upper,options={}) {
  const n=initial.length;
  if(n===0||lower.length!==n||upper.length!==n)throw Error("Inconsistent optimizer dimensions.");
  for(let i=0;i<n;i++)if(!Number.isFinite(lower[i])||!Number.isFinite(upper[i])||!(lower[i]<upper[i]))throw Error("Invalid parameter interval "+i);
  const maxIter=Math.max(5,Math.floor(options.maxIter??180));
  const memory=Math.max(2,Math.min(15,Math.floor(options.memory??7)));
  const gtol=options.gtol??1e-7;
  const ftol=options.ftol??1e-12;
  const x=initial.map((v,i)=>clip(v,lower[i],upper[i]));
  let evaluated=evaluate(x,true),evaluations=1;
  if(!evaluated||!Number.isFinite(evaluated.cost)||!evaluated.grad?.every(Number.isFinite)){
    return {z:x,cost:Infinity,converged:false,reason:"invalid_initial",iterations:0,evaluations,accepted:0,projectedGradient:Infinity};
  }
  let {cost,grad}=evaluated,accepted=0,iter=0,reason="max_iterations",converged=false;
  const sList=[],yList=[],rhos=[];
  for(iter=0;iter<maxIter;iter++){
    const pg=pgVector(x,grad,lower,upper);
    if(normInf(pg)<=gtol){reason="projected_gradient";converged=true;break;}
    let d=feasibleDirection(x,directionFromHistory(pg,sList,yList,rhos),lower,upper);
    if(!(dot(grad,d)<-1e-14*Math.max(1,Math.abs(cost)))){
      d=feasibleDirection(x,pg.map(v=>-v),lower,upper);
    }
    if(!(dot(grad,d)<0)){reason="non_descent_direction";break;}
    const inf=normInf(d);
    if(inf>2)d=d.map(v=>v*2/inf);
    let alpha=1,newZ=null,step=null,success=false;
    for(let trial=0;trial<36;trial++){
      const zz=x.map((v,i)=>clip(v+alpha*d[i],lower[i],upper[i]));
      const ss=zz.map((v,i)=>v-x[i]);
      if(normInf(ss)<1e-13){alpha*=.5;continue;}
      const rr=evaluate(zz,false);evaluations++;
      const linear=dot(grad,ss);
      if(rr&&Number.isFinite(rr.cost)&&rr.cost<=cost+1e-4*linear&&rr.cost<cost){
        newZ=zz;step=ss;success=true;break;
      }
      alpha*=.5;
    }
    if(!success){reason="line_search_stalled";break;}
    const complete=evaluate(newZ,true);evaluations++;
    if(!complete||!Number.isFinite(complete.cost)||!complete.grad?.every(Number.isFinite)){
      reason="invalid_gradient";break;
    }
    const y=complete.grad.map((v,i)=>v-grad[i]);
    const sy=dot(step,y),ss=dot(step,step),yy=dot(y,y);
    if(sy>Math.max(1e-14,1e-10*Math.sqrt(ss*yy))){
      if(sList.length>=memory){sList.shift();yList.shift();rhos.shift();}
      sList.push(step);yList.push(y);rhos.push(1/sy);
    }
    const improvement=cost-complete.cost;
    x.splice(0,n,...newZ);cost=complete.cost;grad=complete.grad;accepted++;
    if(improvement<=ftol*Math.max(1,cost)){
      const projected=normInf(pgVector(x,grad,lower,upper));
      if(projected<=1e-4){reason="small_step";converged=true;break;}
      if(normInf(step)<1e-8){reason="stagnation";break;}
    }
  }
  if(iter>=maxIter)reason="max_iterations";
  return {z:x.slice(),cost,converged,reason,iterations:Math.min(iter+1,maxIter),
    evaluations,accepted,projectedGradient:normInf(pgVector(x,grad,lower,upper))};
}
