@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo === LASER Website Deploy ===
echo.

REM Prefer the workspace portable Python, then fall back to PATH.
set PYTHON=%~dp0..\..\..\03_App\00_Python\python.exe
for %%I in ("%PYTHON%") do set PYTHON=%%~fI
if not exist "%PYTHON%" set PYTHON=python

echo [1/6] Generating publication content...
"%PYTHON%" "%~dp0scripts\build_content.py"
if errorlevel 1 (
  echo ERROR: Content generation failed
  pause
  exit /b 1
)

set "DASHBOARD_APP=%~dp0..\..\..\03_App\04_Dashborad"
echo [2/6] Generating research board...
"%PYTHON%" "%DASHBOARD_APP%\build_dashboard.py"
if errorlevel 1 (
  echo ERROR: Dashboard generation failed
  pause
  exit /b 1
)
"%PYTHON%" "%DASHBOARD_APP%\publish_board.py"
if errorlevel 1 (
  echo ERROR: Board synchronization failed
  pause
  exit /b 1
)

echo [3/6] Validating site sources...
"%PYTHON%" "%~dp0validate_site.py"
if errorlevel 1 (
  echo ERROR: Validation failed
    pause
    exit /b 1
)

echo [4/6] Rendering site locally...
"%PYTHON%" "%~dp0deploy_helper.py" render
if errorlevel 1 (
    echo ERROR: Render failed
    pause
    exit /b 1
)

echo [5/6] Committing source to main...
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

echo [6/6] Deploy complete
echo === Deploy complete ===
echo Source pushed to main. GitHub Actions will render and publish gh-pages.
echo Check: https://github.com/kayhryu89/kayhryu89.github.io/actions
echo Site:  https://kayhryu89.github.io/
pause
