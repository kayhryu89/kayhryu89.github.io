@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo === LASER Website Deploy ===
echo.

REM Find Python (portable, same drive as script)
set DRIVE=%~d0
set PYTHON=%DRIVE%\07_LASER\03_App\00_Python\python.exe
if not exist "%PYTHON%" set PYTHON=python

"%PYTHON%" "%~dp0deploy_helper.py" render
if errorlevel 1 (
    echo ERROR: Render failed
    pause
    exit /b 1
)

echo [3/5] Committing source to main...
git add -A
set "MSG="
set /p MSG=Commit message (Enter for Update site): 
if "%MSG%"=="" set MSG=Update site
git commit -m "%MSG%"
git push
echo.

echo [4/5] Publishing to gh-pages...
"%PYTHON%" "%~dp0deploy_helper.py" publish
echo.

echo === Deploy complete ===
echo Published to https://kayhryu89.github.io/
echo NOTE: GitHub Pages caching may delay changes by a few minutes.
pause
