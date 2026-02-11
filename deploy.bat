@echo off
cd /d "%~dp0"
echo === LASER Website Deploy ===
echo.

echo [1/4] Rendering site...
quarto render
if errorlevel 1 (
    echo ERROR: quarto render failed
    pause
    exit /b 1
)
echo.

echo [2/4] Staging files...
git add .
echo.

echo [3/4] Committing...
set /p MSG="Commit message (Enter for 'Update site'): "
if "%MSG%"=="" set MSG=Update site
git commit -m "%MSG%"
echo.

echo [4/4] Pushing and publishing...
git push
quarto publish gh-pages --no-prompt
echo.

echo === Deploy complete ===
pause
