# LASER Website

Quarto source for the LASER research group website.

## Deployment

Use `deploy.bat` from this directory. The script validates the public source
files, renders the site locally, commits source changes to `main`, and pushes.
GitHub Actions is the single publishing path for `gh-pages`.

## Publication Data

Publication content is now managed from:

- `data/publications.bib` for bibliographic fields
- `data/publication_meta.yml` for site metadata such as status and PI roles
- `scripts/build_content.py` for generated homepage/publication fragments

Local commands should prefer the workspace portable Python at
`E:\07_LASER\03_App\00_Python\python.exe`.

```powershell
E:\07_LASER\03_App\00_Python\python.exe scripts\build_content.py
E:\07_LASER\03_App\00_Python\python.exe validate_site.py
```

Validation can also be run directly:

```powershell
python validate_site.py
```
