@echo off
chcp 65001 >nul
cd /d "%~dp0..\server"
node "%~dp0tee.js" "%~dp0..\startup_backend.log" npm start
