"""Utilities for LASER publication data loading and rendering."""
from __future__ import annotations

import csv
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PublicationRecord:
    key: str
    entry_type: str
    fields: dict[str, str]
    order: int


STATUS_GROUPS = {
    "submitted": {"submitted", "under_review", "under_revision"},
    "accepted": {"accepted", "in_press"},
    "published": {"published"},
}

STATUS_LABELS = {
    "submitted": "Submitted",
    "accepted": "Accepted / In Press",
    "published": "Published",
}

VISIBLE_STATUSES = STATUS_GROUPS["submitted"] | STATUS_GROUPS["accepted"] | STATUS_GROUPS["published"]
HOME_ELIGIBLE_STATUSES = STATUS_GROUPS["accepted"] | STATUS_GROUPS["published"]
PI_NAMES = {"Kyung Hwan Ryu", "Ryu, Kyung Hwan"}


def canonical_status(raw: str | None) -> str:
    if raw is None:
        return "published"
    value = raw.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "accepted": "accepted",
        "draft": "draft",
        "in_press": "in_press",
        "published": "published",
        "rejected": "rejected",
        "submitted": "submitted",
        "under_reivew": "under_review",
        "under_review": "under_review",
        "under_revision": "under_revision",
        "withdrawn": "withdrawn",
    }
    return aliases.get(value, value)


def status_group(status: str) -> str | None:
    for group, values in STATUS_GROUPS.items():
        if status in values:
            return group
    return None


def load_publications(path: Path) -> tuple[list[PublicationRecord], dict[str, dict[str, object]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError(f"{path.name} must contain schema_version 1")
    items = data.get("publications")
    if not isinstance(items, list):
        raise ValueError(f"{path.name} publications must be a list")

    allowed_fields = {
        "id",
        "type",
        "title",
        "authors",
        "journal",
        "year",
        "volume",
        "issue",
        "page_range",
        "article_number",
        "publisher",
        "doi",
        "url",
        "status",
        "visibility",
        "pi_roles",
        "corresponding_authors",
        "dates",
        "next_action",
    }
    allowed_dates = {"submitted", "status_updated", "next_review"}
    records: list[PublicationRecord] = []
    meta: dict[str, dict[str, object]] = {}

    for order, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"{path.name} publication {order} must be an object")
        unknown_fields = set(item) - allowed_fields
        if unknown_fields:
            raise ValueError(
                f"{path.name} publication {order} has unknown fields: {sorted(unknown_fields)}"
            )

        key = str(item.get("id", "")).strip()
        if not key:
            raise ValueError(f"{path.name} publication {order} is missing id")
        raw_authors = item.get("authors")
        if not isinstance(raw_authors, list):
            raise ValueError(f"{path.name} publication {key} authors must be a list")

        author_values: list[str] = []
        author_full_names: list[str] = []
        for author_index, author in enumerate(raw_authors, start=1):
            if not isinstance(author, dict) or set(author) - {"given", "family"}:
                raise ValueError(
                    f"{path.name} publication {key} author {author_index} must contain given/family"
                )
            given = str(author.get("given", "")).strip()
            family = str(author.get("family", "")).strip()
            if not given and not family:
                raise ValueError(f"{path.name} publication {key} author {author_index} is empty")
            author_values.append(f"{family}, {given}".strip(", ") if family else given)
            author_full_names.append(f"{given} {family}".strip())

        page_range = str(item.get("page_range", "")).strip()
        article_number = str(item.get("article_number", "")).strip()
        if page_range and article_number:
            raise ValueError(
                f"{path.name} publication {key} cannot define both page_range and article_number"
            )

        fields = {
            "title": str(item.get("title", "")),
            "author": " and ".join(author_values),
            "journal": str(item.get("journal", "")),
            "year": str(item.get("year", "")),
        }
        optional_fields = {
            "volume": item.get("volume"),
            "number": item.get("issue"),
            "pages": page_range or article_number,
            "publisher": item.get("publisher"),
            "doi": item.get("doi"),
            "url": item.get("url"),
        }
        fields.update(
            {name: str(value) for name, value in optional_fields.items() if value not in {None, ""}}
        )
        records.append(
            PublicationRecord(
                key=key,
                entry_type=str(item.get("type", "journal_article")),
                fields=fields,
                order=order,
            )
        )

        record_meta: dict[str, object] = {
            "status": item.get("status", "published"),
            "visibility": item.get("visibility", "public"),
            "pi_roles": item.get("pi_roles", []),
        }
        corresponding_authors = item.get("corresponding_authors", [])
        if not isinstance(corresponding_authors, list) or any(
            not isinstance(name, str) or not name.strip() for name in corresponding_authors
        ):
            raise ValueError(
                f"{path.name} publication {key} corresponding_authors must be a list of names"
            )
        for corresponding_author in corresponding_authors:
            if not any(
                names_match(corresponding_author, author_name)
                for author_name in author_full_names
            ):
                raise ValueError(
                    f"{path.name} publication {key} corresponding author is not in authors: "
                    f"{corresponding_author}"
                )
        record_meta["corresponding_authors"] = corresponding_authors
        dates = item.get("dates", {})
        if not isinstance(dates, dict):
            raise ValueError(f"{path.name} publication {key} dates must be an object")
        unknown_dates = set(dates) - allowed_dates
        if unknown_dates:
            raise ValueError(
                f"{path.name} publication {key} has unknown dates: {sorted(unknown_dates)}"
            )
        record_meta.update({name: value for name, value in dates.items() if value})
        if item.get("next_action"):
            record_meta["next_action"] = item["next_action"]
        meta[key] = record_meta

    return records, meta


def normalize_doi(raw: str | None) -> str:
    if not raw:
        return ""
    value = raw.strip()
    value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
    return value.strip()


def doi_url(raw: str | None) -> str:
    doi = normalize_doi(raw)
    return f"https://doi.org/{doi}" if doi else ""


def decode_latex(value: str) -> str:
    result = value
    replacements = {
        r"\&": "&",
        r"\%": "%",
        r"\_": "_",
        r"\#": "#",
        r"---": "—",
        r"--": "–",
        "{\\'e}": "e",
        "{\\'E}": "E",
    }
    for src, dst in replacements.items():
        result = result.replace(src, dst)

    result = re.sub(r"\\textcolor\{[^{}]+\}\{([^{}]+)\}", r"\1", result)
    result = result.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", result).strip()


def load_lab_members(csv_path: Path) -> list[str]:
    names = ["Kyung Hwan Ryu"]
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            raw_name = (row.get("Name") or "").strip()
            if not raw_name:
                continue
            english = raw_name.split("(", 1)[0].strip()
            if english and english not in names:
                names.append(english)
    return names


def split_full_name(name: str) -> tuple[str, str]:
    stripped = name.strip()
    if "," in stripped:
        family, given = [part.strip() for part in stripped.split(",", 1)]
        return given, family
    parts = stripped.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return "", parts[0]
    return " ".join(parts[:-1]), parts[-1]


def names_match(candidate: str, reference: str) -> bool:
    if candidate == reference:
        return True
    candidate_given, candidate_family = split_full_name(candidate)
    reference_given, reference_family = split_full_name(reference)
    if not candidate_family or not reference_family:
        return False
    return (
        candidate_family.lower() == reference_family.lower()
        and candidate_given[:3].lower() == reference_given[:3].lower()
    )


def parse_authors(raw_authors: str) -> list[dict[str, str]]:
    authors: list[dict[str, str]] = []
    for raw_author in split_authors(raw_authors):
        author = raw_author.strip()
        if not author:
            continue
        if "," in author:
            family, given = [part.strip() for part in author.split(",", 1)]
        else:
            parts = author.split()
            if len(parts) == 1:
                given = parts[0]
                family = ""
            else:
                given = " ".join(parts[:-1])
                family = parts[-1]
        full = f"{given} {family}".strip()
        authors.append({"given": given, "family": family, "full": full, "raw": author})
    return authors


def split_authors(raw_authors: str) -> list[str]:
    return [part.strip() for part in raw_authors.split(" and ")]


def is_pi(name: str) -> bool:
    return any(names_match(name, pi_name) for pi_name in PI_NAMES)


def is_lab_member(name: str, lab_members: set[str]) -> bool:
    return any(names_match(name, member) for member in lab_members) and not is_pi(name)


def is_corresponding_author(
    name: str,
    corresponding_authors: list[str],
    pi_roles: list[str],
) -> bool:
    if any(names_match(name, author) for author in corresponding_authors):
        return True
    role_set = {role.strip().lower() for role in pi_roles}
    return is_pi(name) and "corresponding" in role_set


def format_author_html(
    name: str,
    lab_members: set[str],
    corresponding_authors: list[str],
    pi_roles: list[str],
) -> str:
    escaped = html.escape(name)
    suffix = "<sup>&dagger;</sup>" if is_corresponding_author(
        name, corresponding_authors, pi_roles
    ) else ""
    if is_pi(name):
        return f"<strong>{escaped}</strong>{suffix}"
    if is_lab_member(name, lab_members):
        return f'<span class="lab-member">{escaped}</span>{suffix}'
    return f"{escaped}{suffix}"


def format_author_list(
    authors: list[dict[str, str]],
    lab_members: set[str],
    corresponding_authors: list[str],
    pi_roles: list[str],
) -> str:
    return ", ".join(
        format_author_html(author["full"], lab_members, corresponding_authors, pi_roles)
        for author in authors
    )


def render_status_text(status: str) -> str:
    return status.replace("_", " ").title()


def render_publication_text(record: PublicationRecord, meta: dict[str, object], lab_members: set[str]) -> str:
    fields = record.fields
    authors = parse_authors(fields.get("author", ""))
    pi_roles = [str(role) for role in meta.get("pi_roles", [])] if isinstance(meta.get("pi_roles"), list) else []
    corresponding_authors = (
        [str(name) for name in meta.get("corresponding_authors", [])]
        if isinstance(meta.get("corresponding_authors"), list)
        else []
    )
    status = str(meta.get("status", "published"))
    parts = [
        format_author_list(authors, lab_members, corresponding_authors, pi_roles),
        html.escape(decode_latex(fields.get("title", ""))),
    ]

    journal = decode_latex(fields.get("journal", ""))
    if journal:
        parts.append(f"<em>{html.escape(journal)}</em>")

    detail_parts = []
    volume = decode_latex(fields.get("volume", ""))
    number = decode_latex(fields.get("number", ""))
    pages = decode_latex(fields.get("pages", ""))
    year = decode_latex(fields.get("year", ""))
    if volume.strip() and number.strip():
        detail_parts.append(f"{html.escape(volume.strip())}({html.escape(number.strip())})")
    elif volume.strip():
        detail_parts.append(html.escape(volume.strip()))
    elif number.strip():
        detail_parts.append(f"({html.escape(number.strip())})")
    if pages.strip():
        detail_parts.append(html.escape(pages.strip()))
    if year.strip() and status not in {"under_review", "under_revision"}:
        detail_parts.append(html.escape(year.strip()))
    if detail_parts:
        parts.append(", ".join(detail_parts))

    text = ". ".join(part for part in parts if part).strip()
    doi = doi_url(fields.get("doi"))
    group = status_group(status)
    status_text = render_status_text(status) if group != "published" else ""

    if doi and status_text:
        return f'{text}. <a href="{html.escape(doi)}" target="_blank" rel="noopener">[LINK]</a>, {html.escape(status_text)}.'
    if doi:
        return f'{text}. <a href="{html.escape(doi)}" target="_blank" rel="noopener">[LINK]</a>'
    if status_text:
        return f"{text}, {html.escape(status_text)}."
    return f"{text}."


def render_publication_sections(records: list[PublicationRecord], meta: dict[str, dict[str, object]], lab_members: list[str]) -> str:
    visible_records = []
    for record in records:
        record_meta = meta.get(record.key, {})
        visibility = str(record_meta.get("visibility", "public"))
        status = canonical_status(record_meta.get("status"))
        if visibility != "public" or status not in VISIBLE_STATUSES:
            continue
        visible_records.append((record, record_meta | {"status": status}))

    submitted = [(record, record_meta) for record, record_meta in visible_records if status_group(str(record_meta["status"])) == "submitted"]
    accepted = [(record, record_meta) for record, record_meta in visible_records if status_group(str(record_meta["status"])) == "accepted"]
    published = [(record, record_meta) for record, record_meta in visible_records if status_group(str(record_meta["status"])) == "published"]

    published.sort(key=lambda item: (-safe_year(item[0]), item[0].order, item[0].key))

    lab_member_set = set(lab_members)
    lines = ['<div id="refs">']

    if submitted:
        lines.append(f'<h2 class="pub-year-header">{STATUS_LABELS["submitted"]}</h2>')
        lines.extend(render_plain_entries(submitted, lab_member_set))

    if accepted:
        lines.append(f'<h2 class="pub-year-header">{STATUS_LABELS["accepted"]}</h2>')
        lines.extend(render_plain_entries(accepted, lab_member_set))

    if published:
        total_published = len(published)
        current_label: str | None = None
        for index, (record, record_meta) in enumerate(published, start=1):
            year = safe_year(record)
            label = "~2020" if year <= 2020 else str(year)
            if label != current_label:
                current_label = label
                lines.append(f'<h2 class="pub-year-header">{html.escape(label)}</h2>')
            pub_number = total_published - index + 1
            content = render_publication_text(record, record_meta, lab_member_set)
            lines.append(
                '<div class="csl-entry">'
                f'<span class="pub-index">[{pub_number}]</span> {content}'
                "</div>"
            )

    lines.append("</div>")
    return "\n".join(lines) + "\n"


def render_plain_entries(items: list[tuple[PublicationRecord, dict[str, object]]], lab_members: set[str]) -> list[str]:
    lines: list[str] = []
    for record, record_meta in items:
        content = render_publication_text(record, record_meta, lab_members)
        lines.append(f'<div class="csl-entry">{content}</div>')
    return lines


def render_recent_publications(records: list[PublicationRecord], meta: dict[str, dict[str, object]], lab_members: list[str], count: int = 2) -> str:
    lab_member_set = set(lab_members)
    selected: list[tuple[PublicationRecord, dict[str, object]]] = []
    for record in records:
        record_meta = meta.get(record.key, {})
        visibility = str(record_meta.get("visibility", "public"))
        status = canonical_status(record_meta.get("status"))
        if visibility != "public" or status not in HOME_ELIGIBLE_STATUSES:
            continue
        authors = parse_authors(record.fields.get("author", ""))
        if not authors:
            continue
        first_author = authors[0]["full"]
        pi_roles = [str(role).strip().lower() for role in record_meta.get("pi_roles", [])] if isinstance(record_meta.get("pi_roles"), list) else []
        pi_is_corresponding = "corresponding" in pi_roles
        if not is_lab_member(first_author, lab_member_set) and not is_pi(first_author) and not pi_is_corresponding:
            continue
        selected.append((record, record_meta | {"status": status}))

    selected.sort(key=lambda item: (-safe_year(item[0]), item[0].order, item[0].key))
    lines: list[str] = []
    for record, record_meta in selected[:count]:
        authors = parse_authors(record.fields.get("author", ""))
        if authors:
            first_author = authors[0]["full"]
            pi_roles = (
                [str(role) for role in record_meta.get("pi_roles", [])]
                if isinstance(record_meta.get("pi_roles"), list)
                else []
            )
            corresponding_authors = (
                [str(name) for name in record_meta.get("corresponding_authors", [])]
                if isinstance(record_meta.get("corresponding_authors"), list)
                else []
            )
            author_html = format_author_html(
                first_author,
                lab_member_set,
                corresponding_authors,
                pi_roles,
            )
        else:
            author_html = ""
        title = html.escape(decode_latex(record.fields.get("title", "")))
        journal = html.escape(decode_latex(record.fields.get("journal", "")))
        year = html.escape(decode_latex(record.fields.get("year", "")))
        doi = doi_url(record.fields.get("doi"))
        line = (
            '<p class="recent-publication">'
            f"{author_html} - {title}, <em>{journal}</em>, {year}"
        )
        if doi:
            line += f' <a href="{html.escape(doi)}" target="_blank" rel="noopener">[LINK]</a>'
        line += "</p>"
        lines.append(line)

    if not lines:
        lines.append("<p>No public publications available yet.</p>")
    return "\n".join(lines) + "\n"


def safe_year(record: PublicationRecord) -> int:
    year = record.fields.get("year", "").strip()
    return int(year) if year.isdigit() else 0
