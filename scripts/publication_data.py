"""Utilities for LASER publication data loading and rendering."""
from __future__ import annotations

import csv
import html
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


def load_publication_meta(path: Path) -> dict[str, dict[str, object]]:
    data: dict[str, dict[str, object]] = {}
    current_key: str | None = None
    current_list_key: str | None = None

    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.rstrip()
        without_comment = line.split("#", 1)[0].rstrip()
        if not without_comment:
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        content = without_comment[indent:]
        if indent == 0:
            if not content.endswith(":"):
                raise ValueError(f"{path.name}:{line_number} expected top-level key ending with ':'")
            current_key = content[:-1].strip()
            data[current_key] = {}
            current_list_key = None
            continue

        if current_key is None:
            raise ValueError(f"{path.name}:{line_number} found nested field before a publication key")

        if indent == 2:
            if content.endswith(":"):
                current_list_key = content[:-1].strip()
                data[current_key][current_list_key] = []
            else:
                if ":" not in content:
                    raise ValueError(f"{path.name}:{line_number} expected 'field: value'")
                key, value = content.split(":", 1)
                data[current_key][key.strip()] = parse_yaml_scalar(value.strip())
                current_list_key = None
            continue

        if indent == 4 and content.startswith("- "):
            if current_list_key is None:
                raise ValueError(f"{path.name}:{line_number} list item without a parent field")
            items = data[current_key].setdefault(current_list_key, [])
            if not isinstance(items, list):
                raise ValueError(f"{path.name}:{line_number} parent field is not a list")
            items.append(parse_yaml_scalar(content[2:].strip()))
            continue

        raise ValueError(f"{path.name}:{line_number} unsupported indentation")

    return data


def parse_yaml_scalar(value: str) -> object:
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if value in {"null", "None", "~", ""}:
        return None
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def parse_bibtex(path: Path) -> list[PublicationRecord]:
    text = path.read_text(encoding="utf-8")
    records: list[PublicationRecord] = []
    idx = 0
    order = 0

    while True:
        at = text.find("@", idx)
        if at == -1:
            break

        brace = text.find("{", at)
        if brace == -1:
            raise ValueError(f"{path.name}: malformed entry starting at character {at}")

        entry_type = text[at + 1 : brace].strip().lower()
        key_end = text.find(",", brace)
        if key_end == -1:
            raise ValueError(f"{path.name}: missing key separator for entry near character {at}")

        key = text[brace + 1 : key_end].strip()
        body_start = key_end + 1
        body_end = find_matching_brace(text, brace)
        body = text[body_start:body_end].strip()

        order += 1
        records.append(
            PublicationRecord(
                key=key,
                entry_type=entry_type,
                fields=parse_bibtex_fields(body),
                order=order,
            )
        )
        idx = body_end + 1

    return records


def find_matching_brace(text: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("unbalanced braces in BibTeX input")


def parse_bibtex_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    idx = 0
    length = len(body)

    while idx < length:
        while idx < length and body[idx] in " \t\r\n,":
            idx += 1
        if idx >= length:
            break

        name_start = idx
        while idx < length and (body[idx].isalnum() or body[idx] in "_-"):
            idx += 1
        field_name = body[name_start:idx].strip().lower()
        if not field_name:
            idx += 1
            continue

        while idx < length and body[idx] in " \t\r\n":
            idx += 1
        if idx >= length or body[idx] != "=":
            raise ValueError(f"malformed BibTeX field near '{field_name}'")
        idx += 1
        while idx < length and body[idx] in " \t\r\n":
            idx += 1
        if idx >= length:
            raise ValueError(f"missing value for '{field_name}'")

        char = body[idx]
        if char == "{":
            value, idx = consume_braced_value(body, idx)
        elif char == '"':
            value, idx = consume_quoted_value(body, idx)
        else:
            start = idx
            while idx < length and body[idx] not in ",\r\n":
                idx += 1
            value = body[start:idx].strip()

        fields[field_name] = value.strip()

    return fields


def consume_braced_value(text: str, start: int) -> tuple[str, int]:
    depth = 0
    idx = start
    chars: list[str] = []
    while idx < len(text):
        char = text[idx]
        if char == "{":
            depth += 1
            if depth > 1:
                chars.append(char)
        elif char == "}":
            depth -= 1
            if depth == 0:
                return "".join(chars), idx + 1
            chars.append(char)
        else:
            chars.append(char)
        idx += 1
    raise ValueError("unbalanced braces in field value")


def consume_quoted_value(text: str, start: int) -> tuple[str, int]:
    idx = start + 1
    chars: list[str] = []
    escaped = False
    while idx < len(text):
        char = text[idx]
        if escaped:
            chars.append(char)
            escaped = False
        elif char == "\\":
            chars.append(char)
            escaped = True
        elif char == '"':
            return "".join(chars), idx + 1
        else:
            chars.append(char)
        idx += 1
    raise ValueError("unterminated quoted field value")


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
    parts = name.strip().split()
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


def pi_suffix(pi_roles: list[str]) -> str:
    markers: list[str] = []
    role_set = {role.strip().lower() for role in pi_roles}
    if "first" in role_set or "co_first" in role_set:
        markers.append("*")
    if "corresponding" in role_set:
        markers.append("&dagger;")
    if not markers:
        return ""
    return f"<sup>{''.join(markers)}</sup>"


def format_author_html(name: str, lab_members: set[str], pi_roles: list[str]) -> str:
    escaped = html.escape(name)
    if is_pi(name):
        return f"<strong>{escaped}</strong>{pi_suffix(pi_roles)}"
    if is_lab_member(name, lab_members):
        return f'<span class="lab-member">{escaped}</span>'
    return escaped


def format_author_list(authors: list[dict[str, str]], lab_members: set[str], pi_roles: list[str]) -> str:
    return ", ".join(format_author_html(author["full"], lab_members, pi_roles) for author in authors)


def render_status_text(status: str) -> str:
    return status.replace("_", " ").title()


def render_publication_text(record: PublicationRecord, meta: dict[str, object], lab_members: set[str]) -> str:
    fields = record.fields
    authors = parse_authors(fields.get("author", ""))
    pi_roles = [str(role) for role in meta.get("pi_roles", [])] if isinstance(meta.get("pi_roles"), list) else []
    parts = [
        format_author_list(authors, lab_members, pi_roles),
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
    if year.strip():
        detail_parts.append(html.escape(year.strip()))
    if detail_parts:
        parts.append(", ".join(detail_parts))

    text = ". ".join(part for part in parts if part).strip()
    doi = doi_url(fields.get("doi"))
    status = str(meta.get("status", "published"))
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
            author_html = format_author_html(first_author, lab_member_set, [])
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
