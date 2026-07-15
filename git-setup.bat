@echo off
title NexMoney - Git setup, first commit ^& push
cd /d "%~dp0"

REM Default remote = your GitHub repo. Override by passing a URL as arg 1.
set "REMOTE=https://github.com/lettfolio/nexmoney.git"
if not "%~1"=="" set "REMOTE=%~1"

echo ============================================
echo  NexMoney - Git setup
echo  Remote: %REMOTE%
echo ============================================
echo.

echo [1/5] Cleaning any partial/broken git state...
if exist ".git" rmdir /s /q ".git"
if exist ".write_test_claude" del /q ".write_test_claude"
echo done.
echo.

echo [2/5] Initialising repository (branch: main)...
git init -b main
git config user.name "Daniel Potts"
git config user.email "danielpotts@live.com"
echo.

echo [3/5] Staging files and creating first commit...
git add -A
git commit -m "Initial commit - NexMoney site (includes mobile compatibility fixes)"
echo.

echo [4/5] Adding remote origin...
git remote remove origin 2>nul
git remote add origin "%REMOTE%"
echo.

echo [5/5] Pushing to GitHub (you may be prompted to sign in)...
git branch -M main
git push -u origin main
echo.

echo ============================================
echo  Done. If push succeeded, your code is on
echo  GitHub at %REMOTE%
echo.
echo  NEXT: In Vercel dashboard - project "nexmoney"
echo  - Settings - Git - connect this GitHub repo
echo  to enable automatic deploys on every push.
echo ============================================
pause
