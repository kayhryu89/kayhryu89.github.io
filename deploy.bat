@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo === LASER Website Deploy ===
echo.

REM Find Python (portable, same drive as script)
set DRIVE=%~d0
set PYTHON=%DRIVE%\07_LASER\03_App\00_Python\python.exe
if not exist "%PYTHON%" set PYTHON=python

echo [1/4] Validating site sources...
"%PYTHON%" "%~dp0validate_site.py"
if errorlevel 1 (
    echo ERROR: Validation failed
    pause
    exit /b 1
)

echo [2/4] Rendering site locally...
"%PYTHON%" "%~dp0deploy_helper.py" render
if errorlevel 1 (
    echo ERROR: Render failed
    pause
    exit /b 1
)

echo [3/4] Committing source to main...
git add -A
set "MSG=%*"
if "%MSG%"=="" set /p MSG=Commit message (Enter for Update site): 
if "%MSG%"=="" set MSG=Update site
git diff --cached --quiet
if not errorlevel 1 goto PUSH_ONLY

git commit -m "%MSG%"
if errorlevel 1 (
    echo ERROR: Commit failed
    pause
    exit /b 1
)

:PUSH_ONLY
git push
echo.

echo === Deploy complete ===
echo Source pushed to main. GitHub Actions will render and publish gh-pages.
echo Check: https://github.com/kayhryu89/kayhryu89.github.io/actions
echo Site:  https://kayhryu89.github.io/
pause
