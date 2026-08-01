@echo off
title AutoWhatsApp Pro - WhatsApp Marketing Automation
color 0A

echo ========================================================
echo           AUTOWHATSAPP PRO AUTOMATION TOOL
echo ========================================================
echo Starting WhatsApp Automation Web App Server...
echo.

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies... Please wait a moment...
    call cmd /c npm install
)

echo Opening Web Dashboard in your browser...
start http://localhost:3000

echo Starting Server...
node server.js

pause
