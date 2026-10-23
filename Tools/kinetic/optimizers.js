import {minimizeProjectedLBFGS} from "../isotherm/lbfgs.js";

const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const maxAbs=v=>v.reduce((m,x)=>Math.max(m,Math.abs(x)),0);
const norm=v=>Math.sqrt(dot(v,v));
function solve(A,b){
  const n=b.length,m=A.map((r,i)=>[...r,b[i]]);
  for(let j=0;j<n;j++){
    let p=j;for(let i=j+1;i<n;i++)if(Math.abs(m[i][j])>Math.abs(m[p][j]))p=i;
    if(!Number.isFinite(m[p][j])||Math.abs(m[p][j])<1e-22)return null;
    [m[j],m[p]]=[m[p],m[j]];
    const d=m[j][j];for(let x=j;x<=n;x++)m[j][x]/=d;
    for(let i=j+1;i<n;i++){const f=m[i][j];for(let x=j;x<=n;x++)m[i][x]-=f*m[j][x];}
  }
  const out=Array(n).fill(0);
  for(let i=n-1;i>=0;i--){let s=m[i][n];for(let j=i+1;j<n;j++)s-=m[i][j]*out[j];out[i]=s;}
  return out;
}
function jacobian(fn,z,lower,upper,center){
 const n=z.length,rows=center.r.length,J=Array.from({length:rows},()=>Array(n).fill(0));
 let evals=0;
 for(let j=0;j<n;j++){
   const h=1e-4,plus=z.slice(),minus=z.slice();
   plus[j]=Math.min(upper[j],z[j]+h);minus[j]=Math.max(lower[j],z[j]-h);
   if(plus[j]===minus[j])return {J:null,evals};
   const p=fn(plus),m=fn(minus);evals+=2;
   if(!p||!m||!p.r||!m.r)return {J:null,evals};
   for(let i=0;i<rows;i++)J[i][j]=(p.r[i]-m.r[i])/(plus[j]-minus[j]);
 }
 return {J,evals};
}
function projGradient(z,g,lower,upper){
 return g.map((v,i)=>((z[i]<=lower[i]+1e-8&&v>0)||(z[i]>=upper[i]-1e-8&&v<0))?0:v);
}
/** Damped Gauss-Newton with bounded projected trust radius, explicit
 * actual/predicted reduction acceptance. This is NOT canonical reflective TRF:
 * no reflected candidate steps, SVD, or Coleman–Li bound scaling. */
export function minimizeBoundedTrustLS(residual,initial,lower,upper,{maxIter=180,gtol=1e-7,initialRadius=1.5}={}){
 const k=initial.length,z=initial.map((x,i)=>clamp(x,lower[i],upper[i]));
 let cur=residual(z),evals=1,accepted=0,radius=initialRadius,iterations=0;
 if(!cur||!Number.isFinite(cur.cost)||!cur.r?.every(Number.isFinite))
   return {z,cost:Infinity,converged:false,reason:"invalid_initial",evaluations:evals,iterations,accepted};
 let lambda=.01,reason="max_iterations",converged=false,gradNorm=Infinity;
 for(let iteration=0;iteration<maxIter;iteration++){
   iterations=iteration+1;
   const diff=jacobian(residual,z,lower,upper,cur);evals+=diff.evals;
   const J=diff.J;if(!J){reason="invalid_jacobian";break;}
   const H=Array.from({length:k},()=>Array(k).fill(0)),g=Array(k).fill(0);
   for(let i=0;i<J.length;i++)for(let a=0;a<k;a++){
     g[a]+=J[i][a]*cur.r[i];
     for(let b=0;b<=a;b++)H[a][b]+=J[i][a]*J[i][b];
   }
   for(let a=0;a<k;a++)for(let b=a+1;b<k;b++)H[a][b]=H[b][a];
   gradNorm=maxAbs(projGradient(z,g,lower,upper));
   if(gradNorm<=gtol*Math.max(1,Math.sqrt(cur.cost))){converged=true;reason="projected_gradient";break;}
   let success=false,lastNorm=Infinity;
   for(let trial=0;trial<24;trial++){
     const mat=H.map((row,i)=>row.map((v,j)=>v+(i===j?lambda*(Math.max(H[i][i],.001))+.00000001:0)));
     let step=solve(mat,g.map(v=>-v));
     if(!step){lambda*=4;radius=Math.max(.00001,radius*.5);continue;}
     const length=norm(step);
     if(length>radius)step=step.map(v=>v*radius/length);
     const dest=z.map((v,i)=>clamp(v+step[i],lower[i],upper[i]));
     step=dest.map((v,i)=>v-z[i]);
     lastNorm=maxAbs(step);
     if(lastNorm<1e-12){lambda*=5;radius=Math.max(.00001,radius*.5);continue;}
     const predicted=-(dot(g,step)+.5*dot(step,H.map(row=>dot(row,step))));
     if(!(predicted>0)){lambda*=5;radius=Math.max(.00001,radius*.5);continue;}
     const candidate=residual(dest);evals++;
     const actual=candidate? .5*(cur.cost-candidate.cost): -Infinity;
     const ratio=actual/predicted;
     if(ratio>.1&&actual>0){
       z.splice(0,k,...dest);cur=candidate;accepted++;success=true;
       if(ratio>.75){radius=Math.min(8,radius*1.8);lambda=Math.max(1e-12,lambda*.35);}
       else if(ratio<.25){radius=Math.max(.00001,radius*.6);lambda*=2;}
       else lambda=Math.max(1e-12,lambda*.8);
       break;
     }
     radius=Math.max(.00001,radius*.5);lambda*=4;
   }
   if(!success){reason=lastNorm<1e-10?"step_stalled":"no_acceptable_step";break;}
 }
 return {z:z.slice(),cost:cur.cost,converged,reason,iterations,accepted,evaluations:evals,projectedGradient:gradNorm};
}
function rng(seed){let x=(seed>>>0)||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
/** Stochastic global differential evolution with projected L-BFGS polish. The
 * DE population operates in the bounded log-coordinate parameter space. */
export function minimizeDELBFGS(evaluate,initial,lower,upper,{seed=20261023,population=0,generations=55,maxIter=190}={}){
 const n=initial.length,rand=rng(seed),count=Math.max(18,population||12*n);
 const pop=Array.from({length:count},(_,j)=>j===0?initial.slice():lower.map((lo,i)=>lo+(upper[i]-lo)*rand()));
 let evals=0;
 function cost(z){evals++;const r=evaluate(z,false);return r&&Number.isFinite(r.cost)?r.cost:Infinity;}
 const scores=pop.map(cost);
 for(let gen=0;gen<generations;gen++){
   let improved=false;
   for(let i=0;i<count;i++){
     const take=()=>{let j;do{j=Math.floor(rand()*count);}while(j===i);return j;};
     let a=take(),b;do{b=take();}while(b===a);
     let c;do{c=take();}while(c===a||c===b);
     const F=.5+.35*rand(),forced=Math.floor(rand()*n);
     const trial=pop[i].map((x,j)=>(j===forced||rand()<.85)?
       clamp(pop[a][j]+F*(pop[b][j]-pop[c][j]),lower[j],upper[j]):x);
     const s=cost(trial);
     if(s<scores[i]){pop[i]=trial;scores[i]=s;improved=true;}
   }
   if(!improved&&gen>15&&gen%5===0){
     const min=Math.min(...scores);
     const best=pop[scores.indexOf(min)];
     if(scores.filter(x=>x<=min+1e-10*Math.max(1,min)).length>=count*.8)break;
   }
 }
 let bestIndex=scores.indexOf(Math.min(...scores));
 let best={z:pop[bestIndex],cost:scores[bestIndex]};
 // Polish several good DE basins, not only the best random member.
 const ids=scores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s).slice(0,Math.min(3,n+1));
 let successful=0,localConverged=0;
 for(const p of ids){
   if(!Number.isFinite(p.s))continue;
   const r=minimizeProjectedLBFGS(evaluate,pop[p.i],lower,upper,{maxIter,memory:7});
   evals+=r.evaluations;successful++;
   if(r.converged)localConverged++;
   if(Number.isFinite(r.cost)&&(r.cost<best.cost||(r.converged&&r.cost<=best.cost+1e-12*Math.max(1,best.cost))))best=r;
 }
 return {...best,evaluations:evals,converged:best.converged??false,
   reason:best.reason??"DE_only",iterations:generations*count,successful,
   localConverged,accepted:best.accepted??null};
}
