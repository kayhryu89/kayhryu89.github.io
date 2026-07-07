"""Validate public LASER website sources before rendering or deployment."""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import publication_data as pubdata

EXTERNAL_PREFIXES = (
    "http://",
    "https://",
    "mailto:",
    "tel:",
    "#",
)

PLACEHOLDER_PATTERNS = (
    "Renew in progress",
    "TODO",
    "TBD",
)

PHONE_RE = re.compile(r"(?:\+?\d[\d\-\s().]{7,}\d)")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
YAML_PATH_RE = re.compile(r"^\s*(?:logo|bibliography)\s*:\s*['\"]?([^'\"\s]+)", re.MULTILINE)
IO_OPEN_RE = re.compile(r"io\.open\(['\"]([^'\"]+)['\"]")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)(?:\s+\{#([A-Za-z0-9_-]+)\})?\s*$")
ALLOWED_PUBLICATION_STATUSES = {
    "draft",
    "submitted",
    "under_review",
    "under_revision",
    "accepted",
    "in_press",
    "published",
    "rejected",
    "withdrawn",
}
ALLOWED_VISIBILITY = {"public", "private"}
ALLOWED_PI_ROLES = {"first", "co_first", "corresponding"}


def display(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def strip_fragment(target: str) -> tuple[str, str]:
    if "#" not in target:
        return target, ""
    path, fragment = target.split("#", 1)
    return path, fragment


def is_external(target: str) -> bool:
    return target.startswith(EXTERNAL_PREFIXES)


def normalize_local_target(source: Path, target: str) -> Path | None:
    target, _ = strip_fragment(target)
    if not target or is_external(target):
        return None
    if target.startswith("/"):
        target = target.lstrip("/")
    if target.endswith(".html"):
        target = target[:-5] + ".qmd"
    base = ROOT if target.startswith(("Info/", "board/", "history/", ".")) else source.parent
    return base / target


def exact_case_exists(path: Path) -> bool:
    try:
        rel = path.relative_to(ROOT)
    except ValueError:
        return False

    current = ROOT
    for part in rel.parts:
        if part in ("", "."):
            continue
        if part == ".." or not current.exists():
            return False
        names = {child.name for child in current.iterdir()}
        if part not in names:
            return False
        current = current / part
    return current.exists()


def slugify_heading(text: str) -> str:
    text = re.sub(r"\{#.*?\}\s*$", "", text)
    text = re.sub(r"[*_`~\[\]()]|!\[[^\]]*\]", "", text)
    text = re.sub(r"[^0-9A-Za-z가-힣\s-]", "", text)
    return re.sub(r"\s+", "-", text.strip().lower())


def anchors_for(path: Path) -> set[str]:
    anchors: set[str] = set()
    if not path.exists() or path.suffix.lower() != ".qmd":
        return anchors
    for line in path.read_text(encoding="utf-8").splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        heading = match.group(2).strip()
        explicit = match.group(3)
        if explicit:
            anchors.add(explicit)
        implicit = slugify_heading(heading)
        if implicit:
            anchors.add(implicit)
    return anchors


def collect_path_refs(source: Path, text: str) -> list[str]:
    refs = [match.group(1).strip() for match in LINK_RE.finditer(text)]
    refs.extend(match.group(1).strip() for match in YAML_PATH_RE.finditer(text))
    refs.extend(match.group(1).strip() for match in IO_OPEN_RE.finditer(text))
    return refs


def validate_paths(errors: list[str]) -> None:
    sources = [
        *ROOT.glob("*.qmd"),
        *ROOT.glob("*.yml"),
        *ROOT.glob("*.lua"),
        *ROOT.glob("board/*.qmd"),
        *ROOT.glob("history/*.md"),
    ]
    for source in sources:
        text = source.read_text(encoding="utf-8")
        for ref in collect_path_refs(source, text):
            target_text, fragment = strip_fragment(ref)
            target_path = normalize_local_target(source, ref)
            if target_path is None:
                continue
            if not exact_case_exists(target_path):
                errors.append(f"{display(source)} references missing or case-mismatched path: {target_text}")
                continue
            if fragment:
                target_qmd = target_path if target_path.suffix == ".qmd" else target_path.with_suffix(".qmd")
                if fragment not in anchors_for(target_qmd):
                    errors.append(f"{display(source)} references missing anchor #{fragment} in {display(target_qmd)}")


def validate_privacy(errors: list[str], warnings: list[str]) -> None:
    csv_path = ROOT / "Info" / "student.csv"
    if not csv_path.exists():
        errors.append("Info/student.csv is missing")
        return

    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_number, row in enumerate(reader, start=2):
            name = row.get("Name", f"row {row_number}")
            phone = (row.get("Phone") or "").strip()
            email = (row.get("Email") or "").strip()
            if phone:
                errors.append(f"Info/student.csv row {row_number} ({name}) exposes a phone number")
            if email:
                warnings.append(f"Info/student.csv row {row_number} ({name}) exposes an email address")
            for field, value in row.items():
                if field == "Phone":
                    continue
                if PHONE_RE.search(value or ""):
                    errors.append(f"Info/student.csv row {row_number} ({name}) contains phone-like text in {field}")


def validate_placeholders(errors: list[str]) -> None:
    for path in [*ROOT.glob("*.qmd"), *ROOT.glob("board/*.qmd")]:
        text = path.read_text(encoding="utf-8")
        for pattern in PLACEHOLDER_PATTERNS:
            if pattern in text:
                errors.append(f"{display(path)} still contains placeholder text: {pattern}")


def validate_publications(errors: list[str], warnings: list[str]) -> None:
    bib_path = ROOT / "data" / "publications.bib"
    meta_path = ROOT / "data" / "publication_meta.yml"
    if not bib_path.exists():
        errors.append("data/publications.bib is missing")
        return
    if not meta_path.exists():
        errors.append("data/publication_meta.yml is missing")
        return

    try:
        records = pubdata.parse_bibtex(bib_path)
        meta = pubdata.load_publication_meta(meta_path)
    except Exception as exc:
        errors.append(f"publication data failed to load: {exc}")
        return

    seen_keys: set[str] = set()
    seen_dois: dict[str, str] = {}
    record_keys = [record.key for record in records]

    for key in record_keys:
        if key in seen_keys:
            errors.append(f"data/publications.bib contains duplicate key: {key}")
        seen_keys.add(key)

    for record in records:
        fields = record.fields
        if not fields.get("title", "").strip():
            errors.append(f"data/publications.bib entry {record.key} is missing title")
        if not fields.get("author", "").strip():
            errors.append(f"data/publications.bib entry {record.key} is missing author")
        year = fields.get("year", "").strip()
        if not re.fullmatch(r"\d{4}", year):
            errors.append(f"data/publications.bib entry {record.key} has invalid year: {year or '<empty>'}")

        if record.key not in meta:
            errors.append(f"data/publication_meta.yml is missing key for publication: {record.key}")
            continue

        record_meta = meta[record.key]
        status = pubdata.canonical_status(record_meta.get("status"))
        visibility = str(record_meta.get("visibility", ""))
        if status not in ALLOWED_PUBLICATION_STATUSES:
            errors.append(f"data/publication_meta.yml key {record.key} has invalid status: {status}")
        if visibility not in ALLOWED_VISIBILITY:
            errors.append(f"data/publication_meta.yml key {record.key} has invalid visibility: {visibility}")

        pi_roles = record_meta.get("pi_roles", [])
        if not isinstance(pi_roles, list):
            errors.append(f"data/publication_meta.yml key {record.key} has non-list pi_roles")
        else:
            for role in pi_roles:
                if str(role) not in ALLOWED_PI_ROLES:
                    errors.append(f"data/publication_meta.yml key {record.key} has invalid pi_role: {role}")

        doi = fields.get("doi", "").strip()
        if doi:
            normalized = pubdata.normalize_doi(doi)
            if doi != normalized:
                warnings.append(f"data/publications.bib entry {record.key} DOI should be stored without URL prefix")
            if status in {"accepted", "in_press"}:
                warnings.append(
                    f"data/publication_meta.yml key {record.key} is {status} but has a DOI; "
                    "consider marking it as published"
                )
            if normalized in seen_dois:
                errors.append(
                    "data/publications.bib has duplicate DOI "
                    f"{normalized} for {seen_dois[normalized]} and {record.key}"
                )
            else:
                seen_dois[normalized] = record.key

        title = fields.get("title", "")
        if "\\textcolor" in title:
            errors.append(f"data/publications.bib entry {record.key} title still contains LaTeX review markup")

    for meta_key in meta:
        if meta_key not in seen_keys:
            errors.append(f"data/publication_meta.yml contains unknown key: {meta_key}")


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    validate_paths(errors)
    validate_privacy(errors, warnings)
    validate_placeholders(errors)
    validate_publications(errors, warnings)

    for warning in warnings:
        print(f"WARNING: {warning}")

    if errors:
        print("SITE VALIDATION FAILED")
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("SITE VALIDATION OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
