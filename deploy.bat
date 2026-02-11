@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo === LASER Website Deploy ===
echo.

REM Use Python for reliable cross-drive file operations
python "%~dp0deploy_helper.py" render
if errorlevel 1 (
    echo ERROR: Render failed
    pause
    exit /b 1
)

echo [3/5] Committing source to main...
git add -A
set /p "MSG=Commit message (Enter for 'Update site'): "
if "!MSG!"=="" set MSG=Update site
git commit -m "!MSG!"
git push
echo.

echo [4/5] Publishing to gh-pages...
python "%~dp0deploy_helper.py" publish
echo.

echo === Deploy complete ===
echo Published to https://kayhryu89.github.io/
echo NOTE: GitHub Pages caching may delay changes by a few minutes.
pause
