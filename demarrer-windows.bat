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
rem Version de Node.js : 22.13 ou plus recente
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo  Votre version de Node.js est trop ancienne. Il faut la version 22.13 ou plus recente.
  echo  Telechargez la version LTS sur https://nodejs.org, installez-la, puis relancez ce fichier.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
rem Port choisi dans le fichier .env (PORT=3001), sinon 3000
set "GARAGE_PORT=3000"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" if not "%%B"=="" set "GARAGE_PORT=%%B"
echo.
echo  Garage Manager demarre. Ne fermez pas cette fenetre.
echo  Adresse : http://localhost:%GARAGE_PORT%
echo.
rem Le navigateur s'ouvre quelques secondes apres, le temps que le logiciel demarre
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:%GARAGE_PORT%"
call npm start
echo.
echo  Le logiciel s'est arrete. Si un message d'erreur est affiche ci-dessus, notez-le avant de fermer.
pause
