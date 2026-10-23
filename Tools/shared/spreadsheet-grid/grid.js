/** Reusable client-only spreadsheet grid for experiment data. */
const cell=v=>String(v??"").slice(0,20000);
const blank=row=>row.every(x=>!String(x??"").trim());
const norm=s=>String(s??"").toLowerCase().replace(/[^a-z0-9]/g,"");
export function splitDelimited(text,delimiter=","){
  const src=String(text??"").replace(/^\uFEFF/,"");
  let word="",row=[],quoted=false;const rows=[];
  for(let i=0;i<src.length;i++){
    const ch=src[i];
    if(ch==='"'){if(quoted&&src[i+1]==='"'){word+='"';i++;}else if(quoted||word==="")quoted=!quoted;else word+=ch;}
    else if(!quoted&&ch===delimiter){row.push(word);word="";}
    else if(!quoted&&(ch==="\n"||ch==="\r")){
      row.push(word);rows.push(row);row=[];word="";
      if(ch==="\r"&&src[i+1]==="\n")i++;
    }else word+=ch;
  }
  if(quoted)throw Error("Unclosed quoted CSV cell.");
  if(row.length||word!==""){row.push(word);rows.push(row);}
  return rows;
}
export function parseSpreadsheetText(text){
  const first=String(text).split(/\r?\n/,1)[0]||"";
  const delim=["\t",",",";"].map(d=>({d,n:splitDelimited(first,d)[0]?.length||0})).sort((a,b)=>b.n-a.n)[0].d;
  return splitDelimited(text,delim);
}
export function encodeDelimited(rows,d=","){
  return rows.map(row=>row.map(v=>{
    const s=String(v??"");return s.includes(d)||/["\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
  }).join(d)).join("\n");
}
export function mapColumns(rows,columns,{hasHeader="auto"}={}){
  const input=rows.map(row=>row.map(cell)).filter(row=>!blank(row));
  if(!input.length)return [];
  const first=input[0],matching=columns.map(c=>{
    const choices=[c.key,c.label,...(c.aliases||[])].map(norm);
    return first.findIndex(s=>norm(s)!==""&&choices.includes(norm(s)));
  });
  const header=hasHeader==="auto"?
    matching.slice(0,2).every(i=>i>=0)||first.slice(0,2).some(s=>String(s).trim()!==""&&!Number.isFinite(Number(s))):
    Boolean(hasHeader);
  return (header?input.slice(1):input).map(row=>columns.map((_,i)=>cell(row[header?matching[i]:i]??"")));
}
export function mountSpreadsheetGrid(host,{columns,initialRows=8,maxRows=2000,onChange=()=>{}}={}){
  if(!(host instanceof HTMLElement))throw Error("Spreadsheet grid host must be an HTMLElement.");
  if(!Array.isArray(columns)||columns.length<2||columns.length>16||columns.some(c=>!c.key||!c.label))
    throw Error("Spreadsheet grid needs 2–16 named columns.");
  const count=columns.length;
  let rows=Array.from({length:initialRows},()=>columns.map(()=>"")),focused={r:0,c:0};
  host.classList.add("spreadsheet-grid");
  const frame=document.createElement("div");frame.className="sheet-scroll";
  const table=document.createElement("table");table.className="sheet-table";table.setAttribute("role","grid");
  const head=document.createElement("thead"),titles=document.createElement("tr"),corner=document.createElement("th");
  corner.textContent="#";titles.append(corner);
  for(const c of columns){const th=document.createElement("th");th.textContent=c.label;titles.append(th);}
  head.append(titles);
  const body=document.createElement("tbody");table.append(head,body);frame.append(table);
  const buttons=document.createElement("div");buttons.className="sheet-controls";
  function button(label){const b=document.createElement("button");b.type="button";b.className="btn small";b.textContent=label;buttons.append(b);return b;}
  const add=button("+ Add row"),remove=button("Delete row"),copy=button("Copy table"),clearButton=button("Clear");
  host.replaceChildren(frame,buttons);
  function getRows(){return rows.filter(r=>!blank(r)).map(r=>r.slice());}
  function toCSV(){return encodeDelimited([columns.map(c=>c.key),...getRows()]);}
  function notify(){onChange({rows:getRows(),text:toCSV()});}
  function move(r,c){
    if(c>=count){r++;c=0;}if(c<0){r--;c=count-1;}
    if(r<0||r>=maxRows)return;
    if(r>=rows.length){rows.push(columns.map(()=>""));render();}
    body.querySelector('input[data-r="'+r+'"][data-c="'+c+'"]')?.focus();
  }
  function pasteRows(data,r=focused.r,c=focused.c){
    if(r===0&&c===0&&getRows().length===0&&data.length>1){
      const first=data[0],matches=columns.slice(0,2).every(col=>first.some(v=>
        [col.key,col.label,...(col.aliases||[])].map(norm).includes(norm(v))&&norm(v)!==""));
      if(matches){setRows(mapColumns(data,columns,{hasHeader:true}));move(0,0);return;}
    }
    if(r+data.length>maxRows||data.some(line=>c+line.length>count))throw Error("Pasted range exceeds available grid rows/columns.");
    while(rows.length<r+data.length)rows.push(columns.map(()=>""));
    data.forEach((line,dr)=>line.forEach((v,dc)=>{rows[r+dr][c+dc]=cell(v);}));
    render();notify();move(r,c);
  }
  function render(){
    body.replaceChildren();
    rows.forEach((row,r)=>{
      const tr=document.createElement("tr"),rn=document.createElement("th");rn.scope="row";rn.textContent=String(r+1);tr.append(rn);
      row.forEach((v,c)=>{
        const td=document.createElement("td"),input=document.createElement("input");
        input.type="text";input.value=v;input.dataset.r=r;input.dataset.c=c;
        input.setAttribute("aria-label",columns[c].label+" row "+(r+1));
        input.autocomplete="off";input.spellcheck=false;
        input.addEventListener("focus",()=>{focused={r,c};});
        input.addEventListener("input",()=>{rows[r][c]=cell(input.value);notify();});
        input.addEventListener("paste",e=>{
          const text=e.clipboardData?.getData("text/plain");
          if(text==null)return;
          const matrix=parseSpreadsheetText(text);
          if(matrix.length>1||matrix.some(line=>line.length>1)){
            e.preventDefault();
            try{pasteRows(matrix,r,c);}catch(err){window.alert(err.message);}
          }
        });
        input.addEventListener("keydown",e=>{
          if(e.key==="Enter"||e.key==="Tab"||((e.key==="ArrowDown"||e.key==="ArrowUp")&&e.altKey)){
            e.preventDefault();
            if(e.key==="Tab")move(r,c+(e.shiftKey?-1:1));
            else move(r+(e.key==="ArrowUp"||e.shiftKey?-1:1),c);
          }
        });
        td.append(input);tr.append(td);
      });body.append(tr);
    });
  }
  function setRows(data,{notifyChange=true}={}){
    if(data.length>maxRows)throw Error("Spreadsheet row limit exceeded ("+maxRows+").");
    rows=data.map(r=>columns.map((c,i)=>cell(Array.isArray(r)?r[i]:r?.[c.key])));
    while(rows.length<initialRows)rows.push(columns.map(()=>""));
    render();if(notifyChange)notify();
  }
  function setDelimited(text,options){setRows(mapColumns(parseSpreadsheetText(text),columns,options));}
  add.addEventListener("click",()=>{if(rows.length>=maxRows)return;rows.push(columns.map(()=>""));render();move(rows.length-1,0);notify();});
  remove.addEventListener("click",()=>{
    rows.splice(Math.min(focused.r,rows.length-1),1);
    if(rows.length===0)rows.push(columns.map(()=>""));
    render();move(Math.min(focused.r,rows.length-1),focused.c);notify();
  });
  copy.addEventListener("click",async()=>{
    const text=encodeDelimited([columns.map(c=>c.key),...getRows()],"\t");
    try{
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
      else{
        const ta=document.createElement("textarea");ta.value=text;
        ta.style.position="fixed";ta.style.left="-10000px";document.body.append(ta);
        ta.select();const ok=document.execCommand("copy");ta.remove();
        if(!ok)throw Error("Clipboard permission denied.");
      }
      copy.textContent="Copied";
      setTimeout(()=>{copy.textContent="Copy table";},1200);
    }catch(e){copy.textContent="Copy failed";setTimeout(()=>{copy.textContent="Copy table";},1500);}
  });
  clearButton.addEventListener("click",()=>setRows([]));
  render();
  return {getRows,toCSV,setRows,setDelimited,pasteRows,clear:()=>setRows([]),columns:columns.map(c=>({...c}))};
}
