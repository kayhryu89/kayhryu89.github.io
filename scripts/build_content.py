"""Generate publication fragments for Quarto pages."""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import publication_data as pubdata


ROOT = SCRIPT_DIR.parents[0]
DATA_DIR = ROOT / "data"
GENERATED_DIR = ROOT / "_generated"


def main() -> int:
    records = pubdata.parse_bibtex(DATA_DIR / "publications.bib")
    meta = pubdata.load_publication_meta(DATA_DIR / "publication_meta.yml")
    lab_members = pubdata.load_lab_members(ROOT / "Info" / "student.csv")

    GENERATED_DIR.mkdir(exist_ok=True)

    publications_fragment = pubdata.render_publication_sections(records, meta, lab_members)
    recent_fragment = pubdata.render_recent_publications(records, meta, lab_members, count=2)

    (GENERATED_DIR / "publications.md").write_text(publications_fragment, encoding="utf-8")
    (GENERATED_DIR / "recent_publications.md").write_text(recent_fragment, encoding="utf-8")

    print("Generated publication fragments:")
    print(" - _generated/publications.md")
    print(" - _generated/recent_publications.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
