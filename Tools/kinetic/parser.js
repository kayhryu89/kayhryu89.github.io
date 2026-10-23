/* Single trajectory, with optional sigma, pressure and adsorption/desorption.
   Reject duplicate times rather than silently averaging or reordering branches. */
export function parseKineticCSV(raw,{branch="adsorption"}={}){
 const line=String(raw).trim().split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
 if(line.length<2)throw Error("Provide a CSV header and at least 6 rows.");
 const delim=line[0].includes("\t")?"\t":",";
 const split=l=>{const out=[];let x="",quoted=false;for(let i=0;i<l.length;i++){
   const c=l[i];if(c==='"'&&l[i+1]==='"'&&quoted){x+='"';i++;}
   else if(c==='"'){quoted=!quoted;}
   else if(c===delim&&!quoted){out.push(x.trim());x="";}
   else x+=c;
 }out.push(x.trim());if(quoted)throw Error("Unclosed CSV quoted field.");return out;};
 const cols=split(line[0]).map(s=>s.toLowerCase().replace(/[\s_\-\(\)\[\]]/g,""));
 const pick=(keys)=>cols.findIndex(s=>keys.includes(s));
 const ti=pick(["time","t","times","timemin","timeh","timesec","timehours","timeseconds"]);
 const qi=pick(["q","loading","uptake","qt","adsorbed","uptakemmolg","loadingmmolg"]);
 const si=pick(["sigma","sd","std","error","uncertainty"]);
 const pi=pick(["pressure","p","concentration","cgas","partialpressure","driving"]);
 const bi=pick(["branch","mode"]);
 if(ti<0||qi<0)throw Error("CSV needs named 'time' and 'loading' columns.");
 const rows=[];let skipped=0,other=0;
 for(const l of line.slice(1)){
   const fields=split(l);if(bi>=0&&branch!=="all"&&(fields[bi]||"adsorption").toLowerCase()!==branch){other++;continue;}
   const time=Number(fields[ti]),y=Number(fields[qi]);
   if(fields[ti]===""||fields[qi]===""||!Number.isFinite(time)||!Number.isFinite(y)||time<0||y<0){skipped++;continue;}
   const row={time,y};
   if(si>=0){const sigma=Number(fields[si]);if(!fields[si]||!Number.isFinite(sigma)||sigma<=0)throw Error("Every supplied sigma must be positive.");row.sigma=sigma;}
   if(pi>=0){const pressure=Number(fields[pi]);if(fields[pi]===""||!Number.isFinite(pressure)||pressure<0)throw Error("Every supplied pressure must be nonnegative and finite.");row.pressure=pressure;}
   row.branch=bi>=0?(fields[bi]||"adsorption").toLowerCase():"adsorption";
   rows.push(row);
 }
 rows.sort((a,b)=>a.time-b.time);
 if(rows.length<6)throw Error("At least 6 valid observations in the selected branch are required.");
 if(rows.some((r,i)=>i&&Math.abs(r.time-rows[i-1].time)<1e-12))throw Error("Duplicate sampling times must be resolved before fitting.");
 if(branch==="all"&&new Set(rows.map(r=>r.branch)).size>1)throw Error("Do not pool adsorption and desorption into one kinetic trajectory.");
 if(!(rows.at(-1).time>rows[0].time))throw Error("A positive time interval is required.");
 return {data:rows,skipped,otherBranch:other,columns:{time:cols[ti],q:cols[qi],sigma:si>=0?cols[si]:null,pressure:pi>=0?cols[pi]:null}};
}
