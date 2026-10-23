// Measurement-based example traced to the NIST digitized A. J. Brown dataset.
// These data represent historical experimental values, not simulated output.
export const EXAMPLES = [
{
  "id": "nist_co2_vycor_150k",
  "name": "CO₂ / Vycor glass · 150.71 K",
  "kind": "measured",
  "source": "NIST digitization of A. J. Brown (1963) dissertation",
  "doi": "10.18434/mds2-2466",
  "source_url": "https://github.com/nist-isodb/AJBrownThesisIsotherms/blob/master/Boundary_Isotherms/co2_boundary_isotherms.csv",
  "temperature_K": 150.71,
  "adsorbent": "Vycor glass",
  "adsorbate": "CO2",
  "xUnit": "kPa",
  "qUnit": "mmol/g",
  "domain": "bulk",
  "recommended_branch": "adsorption",
  "data_note": "NIST digitized historical experimental data, run 1. Pressure converted from log10(mmHg) to kPa; adsorption (mg) converted to mmol/g using 61.6 mg adsorbent and CO₂ molar mass 44.01 g/mol. Rows annotated by the NIST editors as potentially erroneous are excluded, without changing any retained measurements. Desorption branch is recorded separately.",
  "excluded_editor_flagged": 3,
  "source_type": "experimental_digitization",
  "rows": [
    {
      "p": 0.0174945623,
      "q": 0.734042145,
      "branch": "adsorption"
    },
    {
      "p": 0.0382739321,
      "q": 0.922163499,
      "branch": "adsorption"
    },
    {
      "p": 0.0990610854,
      "q": 1.12135081,
      "branch": "adsorption"
    },
    {
      "p": 0.185311803,
      "q": 1.27627428,
      "branch": "adsorption"
    },
    {
      "p": 0.244851677,
      "q": 1.3389814,
      "branch": "adsorption"
    },
    {
      "p": 0.405418051,
      "q": 1.50128218,
      "branch": "adsorption"
    },
    {
      "p": 0.510391087,
      "q": 1.55661199,
      "branch": "adsorption"
    },
    {
      "p": 0.607999304,
      "q": 1.62300776,
      "branch": "adsorption"
    },
    {
      "p": 0.682186439,
      "q": 1.67464891,
      "branch": "adsorption"
    },
    {
      "p": 0.772508171,
      "q": 1.74842199,
      "branch": "adsorption"
    },
    {
      "p": 0.87680513,
      "q": 1.7963745,
      "branch": "adsorption"
    },
    {
      "p": 0.930900111,
      "q": 1.82588373,
      "branch": "adsorption"
    },
    {
      "p": 0.909710237,
      "q": 1.81481777,
      "branch": "desorption"
    },
    {
      "p": 0.884918108,
      "q": 1.7963745,
      "branch": "desorption"
    },
    {
      "p": 0.837342398,
      "q": 1.78530853,
      "branch": "desorption"
    },
    {
      "p": 0.777862942,
      "q": 1.75211065,
      "branch": "desorption"
    },
    {
      "p": 0.626474044,
      "q": 1.6598943,
      "branch": "desorption"
    },
    {
      "p": 0.549418251,
      "q": 1.62300776,
      "branch": "desorption"
    },
    {
      "p": 0.493063759,
      "q": 1.5713666,
      "branch": "desorption"
    },
    {
      "p": 0.368895266,
      "q": 1.46808429,
      "branch": "desorption"
    },
    {
      "p": 0.323521451,
      "q": 1.40906583,
      "branch": "desorption"
    },
    {
      "p": 0.242048883,
      "q": 1.34635871,
      "branch": "desorption"
    },
    {
      "p": 0.132709827,
      "q": 1.18036928,
      "branch": "desorption"
    },
    {
      "p": 0.051156766,
      "q": 0.999625233,
      "branch": "desorption"
    }
  ]
},
{ id:"synthetic_langmuir_henry", name:"Langmuir + Henry · synthetic demo",kind:"synthetic",domain:"bulk",xUnit:"bar",qUnit:"mmol/g",recommended_branch:"adsorption",source:"Generated analytical curve with deterministic perturbation; NOT experimental.",data_note:"Synthetic, only for software demonstration.",rows:Array.from({length:29},(_,i)=>{const x=i*.05,q=2.8*1.8*x/(1+1.8*x)+.18*x;return {p:+x.toFixed(5),q:+(q*(1+.015*Math.sin(i*2.13)+.006*Math.cos(i*3.2))).toFixed(7),branch:"adsorption"};})}
];
export function findExample(id){return EXAMPLES.find(e=>e.id===id)||null;}
export function exampleCsv(example){if(!example)throw Error("Unknown example");return "pressure,loading,branch\n"+example.rows.map(r=>[r.p,r.q,r.branch].join(",")).join("\n");}
