@echo off
chcp 65001 >nul
cd /d "%~dp0..\client"
node "%~dp0tee.js" "%~dp0..\logs\startup_frontend.log" npm run dev
