/**
 * Branch logic for Isotherm Studio spreadsheet input.
 * Default: one branch selector applies to every entered measurement.
 * Mixed mode: the fourth column assigns each row's branch explicitly.
 */
import {encodeDelimited} from "../shared/spreadsheet-grid/grid.js";
const ADS=new Set(["adsorption","ads","a"]);
const DES=new Set(["desorption","des","d"]);
export function normalizeBranch(value){
  const raw=String(value??"").trim().toLowerCase();
  if(!raw)return "";
  if(ADS.has(raw))return "adsorption";
  if(DES.has(raw))return "desorption";
  return null;
}
const dataRow=row=>String(row?.[0]??"").trim()!==""||String(row?.[1]??"").trim()!=="";
export function analyzeRowBranches(rows){
  const labels=new Set(),invalid=[];
  rows.forEach((row,index)=>{
    if(!dataRow(row))return;
    const raw=String(row[3]??"").trim(),kind=normalizeBranch(raw);
    if(kind)labels.add(kind);
    else if(raw)invalid.push({row:index+1,value:raw});
  });
  return {labels:[...labels],invalid,mixed:labels.size>1||invalid.length>0};
}
export function buildBranchCSV(rows,{selectedBranch="adsorption",mixed=false}={}){
  if(!["adsorption","desorption","all"].includes(selectedBranch))throw Error("Invalid global branch selection.");
  if(!mixed&&selectedBranch==="all")throw Error("All branches requires mixed-data mode.");
  const filtered=rows.filter(dataRow);
  const prepared=filtered.map((row,i)=>{
    const kind=mixed?normalizeBranch(row[3]):selectedBranch;
    if(mixed&&kind===null)throw Error("Row "+(i+1)+": Branch must be adsorption or desorption.");
    if(mixed&&!kind)throw Error("Row "+(i+1)+": enter Branch for each measurement in mixed mode.");
    return [row[0]??"",row[1]??"",row[2]??"",kind];
  });
  return encodeDelimited([["pressure","loading","sigma","branch"],...prepared]);
}
