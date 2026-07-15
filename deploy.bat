@echo off
title NexMoney - Deploy to Vercel
cd /d "%~dp0"
echo Deploying NexMoney site to production...
echo.
call vercel --prod
echo.
echo ============================================
echo  Deployment finished. Check output above.
echo ============================================
pause
