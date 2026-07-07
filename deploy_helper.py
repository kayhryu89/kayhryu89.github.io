"""Helper script for deploy.bat - renders the Quarto site locally."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
WORKSPACE = PROJECT.parents[2]
PORTABLE_PYTHON_DIR = WORKSPACE / "03_App" / "00_Python"
QUARTO = PORTABLE_PYTHON_DIR / "Lib" / "quarto" / "bin" / "quarto.cmd"
SKIP_DIRS = {".git", "_site", "_freeze", ".quarto", "__pycache__"}


def copy_project(dst: Path) -> None:
    """Copy project to dst, excluding .git and build artifacts."""
    for item in PROJECT.iterdir():
        if item.name in SKIP_DIRS:
            continue
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def render() -> int:
    """Render site in a temp directory to avoid local git/worktree issues."""
    build_dir = Path(tempfile.gettempdir()) / "laser-build"

    if build_dir.exists():
        shutil.rmtree(build_dir, ignore_errors=True)
    build_dir.mkdir(parents=True, exist_ok=True)

    print("[1/5] Copying project to temp...")
    copy_project(build_dir)

    print("[2/5] Rendering site...")
    build_env = os.environ.copy()
    if PORTABLE_PYTHON_DIR.exists():
        build_env["PATH"] = str(PORTABLE_PYTHON_DIR) + os.pathsep + build_env.get("PATH", "")
    result = subprocess.run([str(QUARTO), "render"], cwd=build_dir, env=build_env, shell=True)
    if result.returncode != 0:
        shutil.rmtree(build_dir, ignore_errors=True)
        return 1

    site_src = build_dir / "_site"
    site_dst = PROJECT / "_site"
    if site_dst.exists():
        for _ in range(3):
            shutil.rmtree(site_dst, ignore_errors=True)
            if not site_dst.exists():
                break
            time.sleep(1)
    site_dst.mkdir(parents=True, exist_ok=True)

    for item in site_src.iterdir():
        target = site_dst / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)

    shutil.rmtree(build_dir, ignore_errors=True)
    print("       Render complete.")
    return 0


def publish() -> int:
    """Legacy entry point kept for compatibility."""
    print("Direct gh-pages publishing is disabled.")
    print("Use deploy.bat, or push main and let GitHub Actions publish the site.")
    return 0


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "render"
    if action == "render":
        sys.exit(render())
    if action == "publish":
        sys.exit(publish())
    print(f"Unknown action: {action}")
    sys.exit(1)
