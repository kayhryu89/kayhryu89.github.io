/** Spreadsheet kinetic data: one selected adsorption/desorption trajectory at a time. */
import {encodeDelimited} from "../shared/spreadsheet-grid/grid.js";
const ADS=new Set(["adsorption","ads","a"]),DES=new Set(["desorption","des","d"]);
export function normalizeKineticBranch(value){
 const raw=String(value??"").trim().toLowerCase();
 return !raw?"":ADS.has(raw)?"adsorption":DES.has(raw)?"desorption":null;
}
const isMeasurement=row=>String(row?.[0]??"").trim()!==""||String(row?.[1]??"").trim()!=="";
export function analyzeKineticBranches(rows){
 const labels=new Set(),invalid=[];
 rows.forEach((row,i)=>{
   if(!isMeasurement(row))return;
   const raw=String(row[4]??"").trim(),v=normalizeKineticBranch(raw);
   if(v)labels.add(v);else if(raw)invalid.push({row:i+1,value:raw});
 });
 return {labels:[...labels],invalid,mixed:labels.size>1||invalid.length>0};
}
export function buildKineticCSV(rows,{selectedBranch="adsorption",mixed=false}={}){
 if(!["adsorption","desorption"].includes(selectedBranch))throw Error("Select adsorption or desorption; kinetic trajectories cannot pool branches.");
 const values=rows.filter(isMeasurement);
 const hasPressure=values.some(r=>String(r[2]??"").trim()!=="");
 const hasSigma=values.some(r=>String(r[3]??"").trim()!=="");
 const header=["time","loading",...(hasPressure?["pressure"]:[]),...(hasSigma?["sigma"]:[]),"branch"];
 const out=values.map((r,i)=>{
   const branch=mixed?normalizeKineticBranch(r[4]):selectedBranch;
   if(mixed&&!branch)throw Error("Row "+(i+1)+": specify adsorption or desorption for each measurement.");
   return [r[0]??"",r[1]??"",...(hasPressure?[r[2]??""]:[]),...(hasSigma?[r[3]??""]:[]),branch];
 });
 return encodeDelimited([header,...out]);
}
