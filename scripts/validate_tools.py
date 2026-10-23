"""Validate unpublished standalone Tools HTML/CSS/JS copies before Quarto deploy."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "Tools"
MANIFEST = TOOLS / "manifest.json"
IMPORT_RE = re.compile(r'\b(?:import|export)\s+(?:[\s\S]*?\bfrom\s*)?[\'"](\.[^\'"]+)[\'"]')
ASSET_RE = re.compile(r'(?:src|href)\s*=\s*[\'"]([^\'"]+)[\'"]', re.IGNORECASE)
ALLOWED = {".js", ".html", ".css"}

def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

def safe_path(base: Path, child: str) -> Path:
    path = (base / child).resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise ValueError(f"Local tool reference escapes source tree: {child}")
    return path

def validate() -> int:
    issues: list[str] = []
    try:
        report = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"Invalid public Tools manifest: {exc}", file=sys.stderr)
        return 1
    if report.get("schema_version") != 1 or not report.get("modules"):
        issues.append("manifest needs schema_version=1 and at least one module")
    approved: set[Path] = set()
    for module in report.get("modules", []):
        module_id = module.get("id", "")
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", module_id):
            issues.append(f"Invalid module ID {module_id!r}")
            continue
        folder = safe_path(TOOLS, module_id)
        if module.get("entrypoint") != f"Tools/{module_id}/index.html":
            issues.append(f"Invalid direct link path for {module_id}")
        file_map = module.get("files", {})
        if not file_map:
            issues.append(f"No production files for {module_id}")
        if "index.html" not in file_map:
            issues.append(f"Module {module_id} lacks index.html")
        for name, expected in file_map.items():
            if "/" in name or "\\" in name or Path(name).suffix not in ALLOWED or name.startswith("."):
                issues.append(f"Unsupported public runtime file {module_id}/{name}")
                continue
            path = safe_path(folder, name)
            approved.add(path)
            if not path.is_file():
                issues.append(f"Missing file {path.relative_to(ROOT)}")
                continue
            data = path.read_bytes()
            if blob_sha(data) != expected:
                issues.append(f"Out-of-sync byte content or SHA: {path.relative_to(ROOT)}")
            if path.suffix == ".js":
                for relative in IMPORT_RE.findall(data.decode("utf-8")):
                    resolved = safe_path(folder, relative)
                    if not resolved.is_file():
                        issues.append(f"Broken ES module import {relative} in {path.relative_to(ROOT)}")
            if path.suffix == ".html":
                for href in ASSET_RE.findall(data.decode("utf-8")):
                    uri = urlsplit(href)
                    if uri.scheme or href.startswith(("#", "//", "mailto:", "tel:")):
                        continue
                    dest = safe_path(folder, unquote(uri.path))
                    if dest.suffix in {".js", ".css", ".html"} and not dest.is_file():
                        issues.append(f"Broken local HTML reference {href} in {path.relative_to(ROOT)}")
    for file in TOOLS.rglob("*"):
        if file.is_file() and file.name != "manifest.json" and file.resolve() not in approved:
            issues.append(f"Unexpected public Tools file: {file.relative_to(ROOT)}")
    config = (ROOT / "_quarto.yml").read_text(encoding="utf-8")
    if '"Tools/**"' not in config:
        issues.append("Quarto project.resources must include Tools/**")
    if issues:
        print("Tools verification failed:", file=sys.stderr)
        for issue in issues:
            print(" - " + issue, file=sys.stderr)
        return 1
    print("Validated", len(approved), "byte-matched public Tools runtime files in", len(report["modules"]), "modules.")
    return 0

if __name__ == "__main__":
    raise SystemExit(validate())
