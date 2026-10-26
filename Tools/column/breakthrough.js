/* Browser-safe experimental breakthrough analysis. No model parameter estimation.
   Gas capture integral includes any change in gas-phase column hold-up. */
const finite=(x,name)=>{const n=Number(x);if(!Number.isFinite(n))throw Error(name+' must be finite.');return n;};
const positive=(x,name)=>{const n=finite(x,name);if(n<=0)throw Error(name+' must be positive.');return n;};
function splitCSVLine(line){
 const cells=[];let value='',quoted=false;
 for(let i=0;i<line.length;i++){
   const ch=line[i];if(ch==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
   else if(ch===','&&!quoted){cells.push(value.trim());value='';}else value+=ch;
 }
 if(quoted)throw Error('CSV contains an unclosed quoted field.');cells.push(value.trim());return cells;
}
const standard=s=>String(s).trim().toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9/]/g,'');
export function parseBreakthroughCSV(text,{timeUnit='s',concentrationMode='ratio',feedConcentration=null}={}){
 if(typeof text!=='string'||text.length>3e6)throw Error('CSV must be text shorter than 3 MB.');
 const lines=text.replace(/^\ufeff/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
 if(lines.length<3)throw Error('At least two observations and a header are required.');
 const head=splitCSVLine(lines[0]).map(standard);
 const find=(keys)=>head.findIndex(x=>keys.includes(x));
 let ix=find(['times','time/s','time_s','seconds','time','timemin','timeh','timehr','timehour','t']);
 if(ix<0)throw Error('CSV needs a time or time_s/time_min/time_h column.');
 const implied=head[ix].includes('min')?'min':head[ix].includes('hour')||head[ix]==='timeh'||head[ix]==='timehr'?'h':head[ix].includes('seconds')||head[ix].includes('times')||head[ix]==='time/s'?'s':timeUnit;
 const scale={s:1,min:60,h:3600}[implied];if(!scale)throw Error('Time unit must be s, min or h.');
 const ratio=find(['cout/cin','coutcin','c/c0','c/cin','ratio','outletfraction','normalized','outletfractionoffeed']);
 const absolute=find(['cout','outlet','outletmolm3','concentration','outletconcentration','cmolm3','outletmol/m3']);
 const useRatio=ratio>=0?true:absolute>=0?false:concentrationMode==='ratio';
 const iy=useRatio?(ratio>=0?ratio:1):(absolute>=0?absolute:1);
 if(iy===ix)throw Error('Time and concentration must use different columns.');
 const feed=useRatio?null:positive(feedConcentration,'Feed concentration for absolute outlet data');
 const result=[];
 for(let i=1;i<lines.length;i++){
   const row=splitCSVLine(lines[i]);if(row.every(x=>!x))continue;
   if(row.length<=Math.max(ix,iy))throw Error('Incomplete row '+(i+1)+'.');
   const t=finite(row[ix],'Time on row '+(i+1))*scale,y=finite(row[iy],'Outlet on row '+(i+1));
   if(t<0||y<0)throw Error('Negative time or outlet on row '+(i+1)+'.');
   if(result.length&&t<=result.at(-1).time)throw Error('Time must be strictly increasing (row '+(i+1)+').');
   result.push({time:t,ratio:useRatio?y:y/feed});
   if(result.length>5000)throw Error("Browser analysis is limited to 5,000 measured points; downsample the experiment first.");
 }
 if(result.length<2)throw Error('At least two measured points are required.');
 return {points:result,mode:useRatio?'ratio':'absolute',timeUnit:implied};
}
function crossing(points,threshold){
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];
  if(a.ratio<=threshold&&b.ratio>=threshold){
    if(a.ratio===b.ratio)return a.time;
    return a.time+(b.time-a.time)*(threshold-a.ratio)/(b.ratio-a.ratio);
  }
 }
 if(points[0].ratio>=threshold)return points[0].time;
 return null;
}
export function analyzeBreakthrough(points,{feedConcentration,flowRateM3s,adsorbentMassKg}={}){
 if(!Array.isArray(points)||points.length<2)throw Error('Need at least two data points.');
 const feed=positive(feedConcentration,'Feed concentration'),flow=positive(flowRateM3s,'Volumetric flow'),mass=positive(adsorbentMassKg,'Adsorbent mass');
 let integral=0,areadifference=0;
 for(let i=0;i<points.length;i++){
   const p=points[i],t=finite(p.time,'Time'),c=finite(p.ratio,'Cout/Cin');
   if(t<0||c<0)throw Error('Time and outlet ratio must be nonnegative.');
   if(i){const prev=points[i-1];if(t<=prev.time)throw Error('Time must be strictly increasing.');
     const dt=t-prev.time;integral+=.5*dt*(2-c-prev.ratio);
     areadifference+=.5*dt*(c+prev.ratio);
   }
 }
 const warning=[];
 if(points[0].time>0)warning.push('Measurements start after t=0; captured gas before the first sample is omitted.');
 if(points.some(p=>p.ratio>1.02))warning.push('Cout/Cin exceeds 1; check baseline, calibration, and desorption/history effects.');
 if(points.at(-1).ratio<.95)warning.push('The observed curve does not reach 95% breakthrough; saturation capacity is not established.');
 return {n:points.length,t05:crossing(points,.05),t50:crossing(points,.50),t95:crossing(points,.95),
   observedStartS:points[0].time,observedEndS:points.at(-1).time,
   netRetainedMol:flow*feed*integral,netRetainedPerKgMolKg:flow*feed*integral/mass,
   outletMolesObserved:flow*feed*areadifference,
   warning:[...warning,'Net retained inventory includes gas hold-up; solid uptake requires a gas-inventory correction or a full inlet–outlet mass balance.']};
}
function interpolate(series,t){
 if(t<series[0].time||t>series.at(-1).time)return null;
 let lo=0,hi=series.length-1;
 while(lo+1<hi){const mid=(lo+hi)>>1;if(series[mid].time<=t)lo=mid;else hi=mid;}
 const a=series[lo],b=series[Math.min(lo+1,series.length-1)];
 if(b.time===a.time)return a.ratio;
 return a.ratio+(b.ratio-a.ratio)*(t-a.time)/(b.time-a.time);
}
export function compareBreakthrough(measured,simulated){
 if(!Array.isArray(measured)||!Array.isArray(simulated)||simulated.length<2)throw Error('Need measured and simulated time series.');
 const model=simulated.map(s=>({time:finite(s.time,'Simulation time'),ratio:finite(s.outletFraction??s.ratio,'Simulation outlet ratio')}));
 for(let i=1;i<model.length;i++)if(model[i].time<=model[i-1].time)throw Error('Simulation time must increase.');
 let n=0,sum=0,abs=0,sq=0;
 for(const p of measured){const y=interpolate(model,p.time);if(y===null)continue;const e=y-p.ratio;sum+=e;abs+=Math.abs(e);sq+=e*e;n++;}
 if(n<2)throw Error('At least two measured points must lie within the simulation time range.');
 return {n,excluded:measured.length-n,rmse:Math.sqrt(sq/n),mae:abs/n,bias:sum/n};
}