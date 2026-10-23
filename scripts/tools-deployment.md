# Publishing standalone research tools in the LASER website

The canonical research code is private: `kayhryu89/Research/Adsorp_supporting_tool/web/<module>`.
The public HTML-only mirror lives in `kayhryu89/kayhryu89.github.io/Tools/<module>`.

## Repeat on EVERY tool implementation/update

1. Check the main branch of **both repositories** and confirm source is a tested, final version. Fetch the exact source Research commit SHA.
2. Select only files necessary to run the public static ES-module tool: `index.html`, relevant JavaScript/CSS and non-sensitive static assets. Never publish tests, raw experimental data (unless explicitly licensed and approved), private documentation, credentials, or private internal repo paths. In this first deployment both `isotherm` and `kinetic` have ten copied files.
3. Mirror these files **byte-for-byte** into `Tools/<module>/` on a branch of the public website repository; preserve relative module imports, including `../isotherm/...` used by kinetic.
4. Update the `Tools/manifest.json` module listing, per-file exact Git blob SHA, and canonical Research source commit. Remove stale runtime copies no longer in source, once backward compatibility is evaluated.
5. Run `python scripts/validate_tools.py` before Quarto. Run `quarto render` and verify `_site/Tools/<module>/index.html` and expected sibling modules. Use a real browser E2E when UI/runtime modules change.
6. Merge to website `main`, allow the existing `.github/workflows/publish.yml` Quarto Pages publisher to finish. Check `gh-pages` includes the full `Tools/<module>/` tree, and confirm `https://kayhryu89.github.io/Tools/<module>/` loads. Keep the homepage `_quarto.yml` navbar, menus, and `index.qmd` unchanged.
7. Update source project deployment notes with latest website SHA and verification status. Never assume that Research's own `gh-pages` branch creates a reachable Pages site; only the public website repository is the destination.

**Security and behavior:** public static tools are discoverable by URL and are not access-controlled. The UI processes user-supplied data locally and does not persist them to the website. Absence of homepage links does NOT provide confidentiality. GitHub Actions cross-repository private-source access is not currently configured: a development task must carry out this sync explicitly, or the user must approve and configure a credentialed automation. Do not add GitHub Personal Access Tokens to source files.

## Shared runtime components

When browser tools use reusable static helpers from `Research/Adsorp_supporting_tool/web/shared/<component>/`, mirror production-only JS/CSS under `Tools/shared/<component>/`. The manifest `shared_assets` maps every public shared file path to its source Git blob SHA. The publisher's `scripts/validate_tools.py` enforces presence, SHA consistency, and local relative imports. Keep `Tools/isotherm/` and `Tools/kinetic/` as separate direct-entry apps and never introduce links in the laboratory homepage.
