/** Lightweight .xlsx first-sheet reader; no external dependencies or formula evaluation. */
const decoder=new TextDecoder();
function unzip(input){
  const bytes=new Uint8Array(input),v=new DataView(input);
  if(bytes.length>4_000_000)throw Error(".xlsx import limited to 4 MB.");
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)
    if(v.getUint32(p,true)===0x06054b50){end=p;break;}
  if(end<0)throw Error("Invalid .xlsx ZIP file.");
  const n=v.getUint16(end+10,true);let pos=v.getUint32(end+16,true),total=0;
  if(n>600)throw Error("Excel workbook contains too many internal files.");
  const entries=new Map();
  for(let i=0;i<n;i++){
    if(pos+46>bytes.length||v.getUint32(pos,true)!==0x02014b50)throw Error("Invalid Excel ZIP directory.");
    const method=v.getUint16(pos+10,true),packed=v.getUint32(pos+20,true),size=v.getUint32(pos+24,true);
    const nl=v.getUint16(pos+28,true),ex=v.getUint16(pos+30,true),co=v.getUint16(pos+32,true),offset=v.getUint32(pos+42,true);
    if(pos+46+nl+ex+co>bytes.length)throw Error("Truncated Excel ZIP directory.");
    const name=decoder.decode(bytes.subarray(pos+46,pos+46+nl));
    if(size>5_000_000||packed>5_000_000||(total+=size)>15_000_000)throw Error("Excel decompressed data exceeds size limit.");
    if(offset+30>bytes.length||v.getUint32(offset,true)!==0x04034b50)throw Error("Invalid ZIP entry.");
    const start=offset+30+v.getUint16(offset+26,true)+v.getUint16(offset+28,true);
    if(start+packed>bytes.length)throw Error("Truncated Excel ZIP content.");
    entries.set(name,{method,size,raw:bytes.slice(start,start+packed)});
    pos+=46+nl+ex+co;
  }
  return entries;
}
async function parseXml(entries,name){
  const e=entries.get(name);if(!e)return null;
  let bytes;
  if(e.method===0)bytes=e.raw;
  else if(e.method===8){
    if(typeof DecompressionStream!=="function")throw Error("This browser cannot decompress .xlsx; paste Excel cells instead.");
    const stream=new Blob([e.raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes=new Uint8Array(await new Response(stream).arrayBuffer());
  }else throw Error("Unsupported Excel compression method.");
  if(bytes.length!==e.size||bytes.length>5_000_000)throw Error("Invalid decompressed Excel file length.");
  const xml=new DOMParser().parseFromString(decoder.decode(bytes),"application/xml");
  if(xml.querySelector("parsererror"))throw Error("Invalid XML in Excel workbook.");
  return xml;
}
const nodes=(el,name)=>Array.from(el.getElementsByTagName(name));
const indexFromCell=s=>(s.match(/^[A-Z]+/i)||["A"])[0].toUpperCase().split("").reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)-1;
function value(c,shared){
  const type=c.getAttribute("t"),raw=nodes(c,"v")[0]?.textContent??"";
  if(type==="s")return shared[Number(raw)]??"";
  if(type==="inlineStr")return nodes(c,"t").map(t=>t.textContent).join("");
  if(type==="b")return raw==="1"?"TRUE":"FALSE";
  return raw;
}
export async function readXlsx(buffer,{maxRows=2000,maxColumns=16}={}){
  const entries=unzip(buffer);
  const sst=await parseXml(entries,"xl/sharedStrings.xml");
  const strings=sst?nodes(sst,"si").map(si=>nodes(si,"t").map(t=>t.textContent).join("")):[];
  const name=[...entries.keys()].filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a,b)=>Number(a.match(/\d+(?=\.xml)/)[0])-Number(b.match(/\d+(?=\.xml)/)[0]))[0];
  if(!name)throw Error("Excel first worksheet not found.");
  const sheet=await parseXml(entries,name);
  const rows=[];let maxCol=0;
  for(const r of nodes(sheet,"row")){
    const rowNumber=Number(r.getAttribute("r"))||rows.length+1;
    if(rowNumber<1||rowNumber>maxRows)throw Error("Excel file exceeds "+maxRows+" rows.");
    while(rows.length<rowNumber)rows.push([]);
    const cells=rows[rowNumber-1];let current=0;
    for(const c of Array.from(r.children).filter(el=>el.localName==="c")){
      const ref=c.getAttribute("r");
      const col=ref?indexFromCell(ref):current;current=col+1;
      if(col>=maxColumns)throw Error("Excel file exceeds "+maxColumns+" columns.");
      cells[col]=value(c,strings);maxCol=Math.max(maxCol,col+1);
    }
  }
  if(!rows.length)throw Error("Excel worksheet has no data.");
  return rows.map(r=>Array.from({length:maxCol},(_,i)=>r[i]??""));
}
