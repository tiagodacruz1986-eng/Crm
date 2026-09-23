@echo off
chcp 65001 >nul
title Garage Manager
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe.
  echo  Telechargez-le sur https://nodejs.org ^(bouton LTS^), installez-le, puis relancez ce fichier.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
if not exist node_modules (
  echo Premiere installation, patientez une minute...
  call npm install
)
if not exist .env copy .env.example .env >nul
echo.
echo  Garage Manager demarre. Ne fermez pas cette fenetre.
echo  Adresse : http://localhost:3000
echo.
start "" http://localhost:3000
call npm start
pause
