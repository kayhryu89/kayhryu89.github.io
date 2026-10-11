"""Generate all Quarto page fragments from the JSON databases."""
from __future__ import annotations
from pathlib import Path
import member_data
import project_data
import publication_data as pubdata

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "_generated"

def main() -> int:
    records, meta = pubdata.load_publications(DATA / "publications.json")
    members = member_data.load_members(DATA / "members.json")
    projects = project_data.load_projects(DATA / "projects.json")
    lab_names = member_data.lab_member_names(members)
    ongoing, completed = project_data.render_project_sections(projects)
    fragments = {
        "publications.md": pubdata.render_publication_sections(records, meta, lab_names),
        "recent_publications.md": pubdata.render_recent_publications(records, meta, lab_names, count=2),
        "members.md": member_data.render_member_sections(members),
        "ongoing_projects.md": ongoing,
        "completed_projects.md": completed,
    }
    OUT.mkdir(exist_ok=True)
    for filename, content in fragments.items():
        (OUT / filename).write_text(content, encoding="utf-8")
        print(f"Generated _generated/{filename}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
