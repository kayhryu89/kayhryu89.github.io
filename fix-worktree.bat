@echo off
echo Removing stale quarto publish worktree...
takeown /F "%~dp0.git\worktrees\quarto-publish-worktree-b497cf7ed94ae18c" /R /D Y
icacls "%~dp0.git\worktrees\quarto-publish-worktree-b497cf7ed94ae18c" /grant %USERNAME%:(OI)(CI)F /T
rd /s /q "%~dp0.git\worktrees\quarto-publish-worktree-b497cf7ed94ae18c"
if exist "%~dp0.git\worktrees\quarto-publish-worktree-b497cf7ed94ae18c" (
    echo FAILED - please restart PC and try again
) else (
    echo SUCCESS - worktree removed
)
pause
