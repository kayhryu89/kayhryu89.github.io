# LASER Website

Quarto source for the LASER research group website.

## Deployment

Use `deploy.bat` from this directory. The script validates the public source
files, renders the site locally, commits source changes to `main`, and pushes.
GitHub Actions is the single publishing path for `gh-pages`.

Validation can also be run directly:

```powershell
python validate_site.py
```
