"""Generate Quarto member sections from JSON."""
from __future__ import annotations
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def load_members(path: Path) -> list[dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("members"), list):
        raise ValueError(f"Invalid members JSON: {path}")
    return data["members"]

def lab_member_names(members: list[dict[str, str]]) -> list[str]:
    names = ["Kyung Hwan Ryu"]
    for row in members:
        name = str(row.get("name", "")).split("(", 1)[0].strip()
        if name and name not in names:
            names.append(name)
    return names

def photo_for(row: dict[str, str]) -> str | None:
    if str(row.get("photo", "")).strip().lower() == "none":
        return None
    for prefix in ("pic", "Pic"):
        for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            filename = f"Info/Images/{prefix}{row['id']}{ext}"
            if (ROOT / filename).is_file():
                return "./" + filename
    return None

def render_card(row: dict[str, str]) -> str:
    e = lambda x: html.escape(str(x), quote=True)
    out = ['<div class="member-card">']
    photo = photo_for(row)
    if photo:
        out.extend(['<div class="member-photo">', f'<img src="{e(photo)}" alt="{e(row["name"])}">', '</div>'])
    out.extend(['<div class="member-info">', f'<h4>{e(row["name"])}</h4>'])
    for field, label in (("research_topic", "Research Topic"), ("email", "Email"), ("joined", "Joined")):
        if row.get(field):
            out.append(f'<p><strong>{label}</strong>: {e(row[field])}</p>')
    out.extend(['</div>', '</div>'])
    return "\n".join(out)

def render_alumni(rows: list[dict[str, str]]) -> str:
    e = lambda x: html.escape(str(x), quote=True)
    out = ['<table class="table">', '<thead><tr><th>Name</th><th>Graduation</th><th>Thesis Title</th><th>Current Position</th></tr></thead>', '<tbody>']
    for row in rows:
        name = str(row["name"])
        if "(" in name and ")" in name:
            english, suffix = name.split("(", 1)
            korean = suffix.split(")", 1)[0]
            display = f'{e(english.strip())}<br><span style="color:#666;font-size:0.88em;">({e(korean)})</span>'
        else:
            display = e(name)
        out.append('<tr>')
        for cell in (display, e(row.get("graduation", "")), e(row.get("thesis", "")), e(row.get("current_position", ""))):
            out.append(f"<td>{cell}</td>")
        out.append("</tr>")
    out.extend(["</tbody></table>"])
    return "\n".join(out)

def render_member_sections(members: list[dict[str, str]]) -> str:
    groups = {key: [] for key in ("postdoc", "phd", "ms", "researcher", "graduate")}
    for row in members:
        status = str(row.get("status", "")).strip().lower()
        if status in ("post-doc", "postdoc"):
            groups["postdoc"].append(row)
        elif status in ("researcher", "researchers"):
            groups["researcher"].append(row)
        elif status in groups:
            groups[status].append(row)
    out = []
    if any(groups[x] for x in ("postdoc", "phd", "ms")):
        out.append("## Graduate Students {#graduate-students}")
        for key, title in (("postdoc", "Post-Doctoral Researchers"), ("phd", "Ph.D. Students"), ("ms", "M.S. Students")):
            if groups[key]:
                out.append(f"### {title}")
                out.extend(render_card(row) for row in groups[key])
    if groups["researcher"]:
        out.append("## Researchers {#researchers}")
        out.extend(render_card(row) for row in groups["researcher"])
    if groups["graduate"]:
        out.extend(["---", "## Alumni {#alumni}", "### M.S. Graduates", render_alumni(groups["graduate"])])
    return "\n\n".join(out) + ("\n" if out else "")
