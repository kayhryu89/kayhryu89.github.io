// Isotherm library, version 0.1.0. All coefficients use scaled X=x/xScale,
// Y=q/yScale. The relative-pressure family ALWAYS uses X=p/p0 directly.
const param = (name, guess, low=1e-4, high=100) => ({name, guess, low, high});
const cap = (name="qm") => param(name,1.4,0.002,100);
const aff = (name="b") => param(name,2,1e-4,1e4);
const expn = (name="n") => param(name,1,0.15,4);
const params = {
  henry:[param("KH",1,1e-5,1e4)],
  langmuir:[cap(),aff()],
  freundlich:[param("KF",1),expn()],
  sips:[cap(),aff(),expn()],
  toth:[cap(),aff(),expn("t")],
};
const l = (x,q,b) => q*b*x/(1+b*x);
const sp = (x,q,b,n) => q/(1+Math.pow(Math.max(b*x,1e-300),-n));
const bet = (x,q,c) => q*c*x/((1-x)*(1+(c-1)*x));
const reg = [];
function add(id,label,group,formula,ps,fn,opts={}) {
  reg.push(Object.freeze({id,label,group,formula,params:ps,eval:fn,
    relative:!!opts.relative, maxX:opts.maxX??Infinity,
    caution:opts.caution||"", alias:opts.alias||""}));
}
add("henry","Henry","Basic","q = KH x",params.henry,(x,[k])=>k*x);
add("langmuir","Langmuir","Basic","q = qm bx / (1 + bx)",params.langmuir,(x,[q,b])=>l(x,q,b));
add("dual_langmuir","Dual-site Langmuir","Multi-site",
  "q = Σ(i=1..2) qmi bi x / (1 + bi x)",
  [cap("q1"),aff("b1"),cap("q2"),aff("b2")],
  (x,[q1,b1,q2,b2])=>l(x,q1,b1)+l(x,q2,b2),
  {caution:"Site exchange symmetry can cause non-identifiable parameters."});
add("triple_langmuir","Triple-site Langmuir","Multi-site",
  "q = Σ(i=1..3) qmi bi x / (1 + bi x)",
  [cap("q1"),aff("b1"),cap("q2"),aff("b2"),cap("q3"),aff("b3")],
  (x,p)=>l(x,p[0],p[1])+l(x,p[2],p[3])+l(x,p[4],p[5]),
  {caution:"Multiple site permutations and weak identifiability are common."});
add("freundlich","Freundlich","Heterogeneous","q = KF x^n",
  params.freundlich,(x,[k,n])=>k*Math.pow(x,n),
  {caution:"Unbounded at high driving variable; empirical domain only."});
add("sips","Sips / Langmuir-Freundlich / Hill","Heterogeneous",
  "q = qm (bx)^n / (1 + (bx)^n)",params.sips,(x,[q,b,n])=>sp(x,q,b,n),
  {alias:"Hill and Langmuir–Freundlich are commonly equivalent parameterizations."});
add("toth","Toth","Heterogeneous",
  "q = qm bx / [1 + (bx)^t]^(1/t)",
  params.toth,(x,[q,b,t])=>q*b*x/Math.pow(1+Math.pow(b*x,t),1/t));
add("jovanovic","Jovanovic","Basic",
  "q = qm [1 − exp(−b x)]",
  [cap(),aff()],(x,[q,b])=>q*(-Math.expm1(-b*x)));
add("temkin","Temkin (log form)","Empirical",
  "q = B ln(1 + Kx)",
  [param("B",1),aff("K")],(x,[B,K])=>B*Math.log1p(K*x),
  {caution:"Modified logarithmic Temkin form; not the TemkinApprox vacancy-interaction model."});
add("quadratic","Quadratic","Multi-site",
  "q = qm (bx + 2cx²) / (1 + bx + cx²)",
  [cap(),aff(),param("c",0.5,1e-5,1e4)],
  (x,[q,b,c])=>q*(b*x+2*c*x*x)/(1+b*x+c*x*x));
add("unilan","Unilan","Heterogeneous",
  "q = qm / (2h) ln[(1 + be^h x)/(1 + be^(−h) x)]",
  [cap(),aff(),param("h",0.8,0.02,4)],
  (x,[q,b,h])=>q/(2*h)*(Math.log1p(b*Math.exp(h)*x)-Math.log1p(b*Math.exp(-h)*x)));
add("redlich_peterson","Redlich–Peterson","Empirical",
  "q = A x / (1 + B x^g)",
  [param("A",2),aff("B"),param("g",0.9,0.15,1)],
  (x,[A,B,g])=>A*x/(1+B*Math.pow(x,g)),
  {caution:"g<1 permits unbounded growth; not a finite-capacity isotherm."});
add("radke_prausnitz","Radke–Prausnitz (type I)","Empirical",
  "q = A x / (1 + B x^n)",
  [param("A",2),aff("B"),param("n",0.85,0.15,1)],
  (x,[A,B,n])=>A*x/(1+B*Math.pow(x,n)),
  {alias:"This particular type-I form is mathematically equivalent to Redlich–Peterson; compare as an alias, not separate evidence."});
add("koble_corrigan","Koble–Corrigan","Empirical",
  "q = A x^n / (1 + B x^n)",
  [param("A",2),aff("B"),expn()],
  (x,[A,B,n])=>A*Math.pow(x,n)/(1+B*Math.pow(x,n)),
  {alias:"Reparameterization of the Sips isotherm; not an independent mechanism."});
add("khan","Khan","Empirical",
  "q = qm bx / (1 + bx)^a",
  [cap(),aff(),param("a",0.8,0.15,1)],
  (x,[q,b,a])=>q*b*x/Math.pow(1+b*x,a),
  {caution:"For a<1 this form does not saturate at high x."});
add("fritz_schlunder","Fritz–Schlunder (4 parameter)","Empirical",
  "q = A x^m / (1 + B x^n)",
  [param("A",1.5),aff("B"),expn("m"),expn("n")],
  (x,[A,B,m,n])=>A*Math.pow(x,m)/(1+B*Math.pow(x,n)),
  {caution:"Four-parameter flexible empirical form. Monotonicity/saturation are not guaranteed."});
add("jensen_seaton","Jensen–Seaton","Microporous",
  "q = Kx / [1 + (Kx / {qm(1+kx)})^t]^(1/t)",
  [param("K",2),cap(),aff("k"),expn("t")],
  (x,[K,qm,k,t])=>K*x/Math.pow(1+Math.pow(K*x/(qm*(1+k*x)),t),1/t),
  {caution:"High-x response can remain rising rather than approach a plateau."});
add("brouers_sotolongo","Brouers–Sotolongo","Heterogeneous",
  "q = qm [1 − exp(−(b x)^n)]",
  [cap(),aff(),expn()],(x,[q,b,n])=>q*(-Math.expm1(-Math.pow(b*x,n))));
add("brouers_gaspard","Brouers–Gaspard","Heterogeneous",
  "q = qm [1 − (1 + a(bx)^n)^(−1/a)]",
  [cap(),aff(),expn(),param("a",0.8,0.1,5)],
  (x,[q,b,n,a])=>q*(-Math.expm1(-Math.log1p(a*Math.pow(b*x,n))/a)));
add("bet","BET","Relative pressure",
  "q = qm c x / [(1−x)(1+(c−1)x)]",
  [cap(),aff("c")],(x,[q,c])=>bet(x,q,c),
  {relative:true,maxX:0.98,caution:"Requires relative pressure p/p0; only a justified BET range, not arbitrary liquid concentration."});
add("gab","GAB","Relative pressure",
  "q = qm c k x / [(1−kx)(1−kx + ckx)]",
  [cap(),aff("c"),param("k",0.8,0.02,0.9999)],
  (x,[q,c,k])=>q*c*k*x/((1-k*x)*(1-k*x+c*k*x)),
  {relative:true,maxX:0.999,caution:"Requires relative pressure/activity; interpret moisture-uptake application and bounds carefully."});
add("dubinin_radushkevich","Dubinin–Radushkevich","Relative pressure",
  "q = qm exp[−(a ln(1/x))²]",
  [cap(),param("a",0.8,0.005,100)],
  (x,[q,a])=>x===0?0:q*Math.exp(-Math.pow(a*Math.log(1/x),2)),
  {relative:true,maxX:1,caution:"Gas potential form with relative pressure; a is an effective inverse characteristic-energy factor at fixed T."});
add("dubinin_astakhov","Dubinin–Astakhov","Relative pressure",
  "q = qm exp[−(a ln(1/x))^n]",
  [cap(),param("a",0.8,0.005,100),expn()],
  (x,[q,a,n])=>x===0?0:q*Math.exp(-Math.pow(a*Math.log(1/x),n)),
  {relative:true,maxX:1,caution:"Gas adsorption-potential form; requires reference saturation pressure and known T."});
add("halsey","Halsey","Relative pressure",
  "q = [A / ln(1/x)]^(1/n)",
  [param("A",0.3),expn()],(x,[A,n])=>x===0?0:Math.pow(A/Math.log(1/x),1/n),
  {relative:true,maxX:0.98,caution:"Diverges as relative pressure approaches 1; not suitable for saturated columns."});
add("harkins_jura","Harkins–Jura","Relative pressure",
  "q = sqrt[A / (B − ln x)]",
  [param("A",1),param("B",1)],
  (x,[A,B])=>x===0?0:Math.sqrt(A/(B-Math.log(x))),
  {relative:true,maxX:0.98,caution:"Empirical multilayer form; positive B constrains the evaluation range."});
export const MODELS = Object.freeze(reg);
export const MODEL_MAP = new Map(MODELS.map(m=>[m.id,m]));
export function resolveModel(id) {
  const model=MODEL_MAP.get(id);
  if(!model) throw new Error("Unknown model: "+id);
  return model;
}
export function makeHybrid(ids) {
  if(!Array.isArray(ids)||ids.length<2||ids.length>3) throw new Error("Choose 2–3 hybrid components.");
  const parts=ids.map(id=>resolveModel(id));
  if(parts.some(p=>p.relative)) throw new Error("Relative-pressure-only models cannot be mixed in the first hybrid version.");
  const ps=parts.flatMap((part,i)=>part.params.map(p=>({...p,name:"s"+(i+1)+"_"+p.name})));
  return {id:"hybrid:"+ids.join("+"),label:"Hybrid: "+parts.map(p=>p.label).join(" + "),
    group:"Hybrid",params:ps,formula:parts.map(p=>p.formula).join(" + "),
    relative:false,maxX:Infinity,caution:"Components are additive site contributions, not competitive multicomponent adsorption.",
    components:ids,
    eval(x,theta) {let offset=0, value=0;for(const part of parts){const n=part.params.length;value+=part.eval(x,theta.slice(offset,offset+n));offset+=n;}return value;}
  };
}
export function evaluate(model,x,coeffs) {
  if(!Number.isFinite(x)||x<0) return NaN;
  if(model.relative&&x>model.maxX) return NaN;
  const y=model.eval(x,coeffs);
  return Number.isFinite(y)&&y>=-1e-10?Math.max(0,y):NaN;
}
