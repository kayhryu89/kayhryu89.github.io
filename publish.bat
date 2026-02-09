@echo off
setlocal

REM 이 배치파일이 있는 폴더(리포 루트)로 이동
cd /d "%~dp0"

REM Git 저장소인지 확인
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Not a git repository.
  exit /b 1
)

REM 커밋 메시지: 인자로 받거나(예: publish.bat "msg"), 없으면 입력받기
set "MSG=%*"
if "%MSG%"=="" (
  set /p MSG=Commit message: 
)

REM 변경사항 스테이징
git add -A
if errorlevel 1 exit /b 1

REM 스테이징된 변경이 없으면 커밋 생략하고 push만 시도
git diff --cached --quiet
if not errorlevel 1 goto PUSH

REM 커밋
git commit -m "%MSG%"
if errorlevel 1 exit /b 1

:PUSH
git push
if errorlevel 1 exit /b 1

echo Done.
endlocal
