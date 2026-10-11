"""Generate Quarto project tables from JSON."""
from __future__ import annotations
import html
import json
from pathlib import Path

def load_projects(path: Path) -> list[dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("projects"), list):
        raise ValueError(f"Invalid projects JSON: {path}")
    return data["projects"]

def render_table(rows: list[dict[str, str]]) -> str:
    e = lambda x: html.escape(str(x), quote=True)
    out = ['<div class="project-table">', '<table class="table">', '<thead><tr>', '<th style="width:5%">No.</th>', '<th>Project</th>', '<th>Funding</th>', '<th>Period</th>', '</tr></thead>', '<tbody>']
    for i, row in enumerate(rows, 1):
        period = e(row.get("period", "")).replace("--", "–<br>")
        out.extend(['<tr>', f'<td style="text-align:center">{i}</td>', f'<td>{e(row["title"])}</td>', f'<td>{e(row["funding"])}</td>', f'<td style="white-space:nowrap">{period}</td>', '</tr>'])
    out.extend(['</tbody></table>', '</div>'])
    return "\n".join(out) + "\n"

def render_project_sections(projects: list[dict[str, str]]) -> tuple[str, str]:
    ongoing = [row for row in projects if "ongoing" in row.get("status", "").lower()]
    completed = [row for row in projects if "ongoing" not in row.get("status", "").lower()]
    return render_table(ongoing), render_table(completed)
