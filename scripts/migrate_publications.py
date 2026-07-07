"""One-time migration from legacy Journal.bib to data/publications.bib + publication_meta.yml."""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import publication_data as pubdata


ROOT = SCRIPT_DIR.parents[0]
LEGACY_BIB = ROOT / "Info" / "Bib" / "Journal.bib"
DATA_DIR = ROOT / "data"
TITLE_OVERRIDES = {
    "kim2026uncertainty": "Uncertainty-penalized quadratic surrogate optimization using cross-validation-based ridge regression",
    "kim2025variance": "A Variance-Weighted Curvature Criterion for Sequential Experimental Design",
}


def main() -> int:
    records = pubdata.parse_bibtex(LEGACY_BIB)
    DATA_DIR.mkdir(exist_ok=True)

    bib_lines: list[str] = []
    meta_lines: list[str] = []

    for record in records:
        bib_lines.append(f"@{record.entry_type}{{{record.key},")
        for field_name, value in record.fields.items():
            if field_name in {"authorship", "status"}:
                continue
            if field_name == "title" and record.key in TITLE_OVERRIDES:
                value = TITLE_OVERRIDES[record.key]
            if field_name == "doi":
                value = pubdata.normalize_doi(value)
            if not value.strip():
                continue
            bib_lines.append(f"  {field_name}={{{value}}},")
        if bib_lines[-1].endswith(","):
            bib_lines[-1] = bib_lines[-1][:-1]
        bib_lines.append("}")
        bib_lines.append("")

        status = pubdata.canonical_status(record.fields.get("status"))
        authorship = (record.fields.get("authorship") or "").strip().lower()
        pi_roles: list[str] = []
        if authorship == "first":
            pi_roles.append("first")
        elif authorship == "corresponding":
            pi_roles.append("corresponding")

        meta_lines.append(f"{record.key}:")
        meta_lines.append(f"  status: {status}")
        meta_lines.append("  visibility: public")
        meta_lines.append("  pi_roles:")
        for role in pi_roles:
            meta_lines.append(f"    - {role}")
        meta_lines.append("")

    (DATA_DIR / "publications.bib").write_text("\n".join(bib_lines).rstrip() + "\n", encoding="utf-8")
    (DATA_DIR / "publication_meta.yml").write_text("\n".join(meta_lines).rstrip() + "\n", encoding="utf-8")

    print("Migrated publications data:")
    print(" - data/publications.bib")
    print(" - data/publication_meta.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
