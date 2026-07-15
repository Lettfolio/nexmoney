@echo off
title NexMoney - trigger Vercel deploy via git push
cd /d "%~dp0"
echo Pushing to GitHub to trigger Vercel auto-deploy...
echo.
git add -A
git commit -m "Deploy: mobile compatibility fixes"
if errorlevel 1 (
  echo No file changes to commit - creating an empty commit to trigger a build.
  git commit --allow-empty -m "Trigger Vercel deploy - mobile compatibility fixes"
)
git push origin main
echo.
echo ============================================
echo  Push finished. Vercel should now build.
echo ============================================
pause
