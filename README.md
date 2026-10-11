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
