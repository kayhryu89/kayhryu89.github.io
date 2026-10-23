# LASER Website

Quarto source for the LASER research group website.

## Deployment

Use `deploy.bat` from this directory. The script validates the public source
files, renders the site locally, commits source changes to `main`, and pushes.
GitHub Actions is the single publishing path for `gh-pages`.

## Publication Data

Publication, project, and member data are managed from:

- `data/publications.json` for bibliographic fields, structured authors, named corresponding authors, publication status, and site metadata
- `data/projects.json` for funding projects, periods and current/completed status
- `data/members.json` for active researchers, students, and alumni
- `scripts/build_content.py` for generated homepage/publication fragments
- `board-dashboard.html` for the generated, access-gated research Board view

Local commands should prefer the workspace portable Python at
`E:\07_LASER\03_App\00_Python\python.exe`.

```powershell
E:\07_LASER\03_App\00_Python\python.exe scripts\build_content.py
E:\07_LASER\03_App\00_Python\python.exe validate_site.py
```

Run `scripts\build_content.py` before a direct `quarto render`; deployment scripts already perform this step automatically.

The homepage `Board` tab embeds `board-dashboard.html`. That file is generated from the local research dashboard by `E:\07_LASER\03_App\04_Dashborad\run.bat`, the project manager, or `deploy.bat`. The login is a client-side gate for the static page; it does not provide server-side protection for public hosting.

Validation can also be run directly:

```powershell
python validate_site.py
```

## JSON data and Python rendering

All three public content databases are JSON. Python `scripts/build_content.py` generates the Publications, Projects, People, and Home page fragments in `_generated/` before Quarto renders. The original Lua filters, BibTeX project database and CSV member database have been retired. Edit JSON sources, not generated Markdown. The Board prototype is unchanged.

## Standalone research tools (unlisted)

Browser-only research utilities are mirrored from the private `kayhryu89/Research` repository under `Tools/<module>/`. The main LASER website navigation is intentionally unchanged; each tool is available only through its direct address (e.g. `https://kayhryu89.github.io/Tools/isotherm/` and `https://kayhryu89.github.io/Tools/kinetic/`).

These are **publicly accessible** static HTML/JavaScript applications. Their source code and bundled demonstration examples are visible to anyone with the URL. Never mirror raw/private research data, credentials, tests, manuscript materials or entire Research folders.

**Maintenance rule:** Every time a research tool's browser runtime is implemented or updated, mirror the final reviewed production HTML/JavaScript/CSS into `Tools/<module>/` in this repository, update `Tools/manifest.json` with exact Git blob hashes and the source Research commit, and verify the Quarto `_site/Tools/<module>/index.html` output and live GitHub Pages endpoint. Do not add the tool to `_quarto.yml` website navbar or `index.qmd`. The Quarto `project.resources: ["Tools/**"]` entry only copies files. Publishing still uses the existing `publish.yml` GitHub Actions flow. Read `scripts/tools-deployment.md` for the synchronization checklist.

A push to the private Research repository **does not automatically update** this public repository; the explicit mirroring step must be performed as part of each tool-development task unless a suitably authorized cross-repository automation is configured later.

## Shared interactive UI components

Reusable public-safe browser runtime lives in `Tools/shared/<component>/` and is tracked separately under `Tools/manifest.json` → `shared_assets`. Current example: `Tools/shared/spreadsheet-grid/` supplies the Excel-style data grid and local `.xlsx` parser. Isotherm Studio imports the same module from `../shared/spreadsheet-grid/`. Keep shared runtime files synchronized when any dependent tool changes and validate SHA hashes before Quarto deploy. These assets are **not** homepage navigation entries or standalone pages.
