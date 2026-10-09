@echo off
chcp 65001 >nul
title Garage - acces securise depuis les telephones (Tailscale)
cd /d "%~dp0"
rem Rend le logiciel joignable en https depuis VOS appareils seulement (reseau prive Tailscale),
rem au garage comme en 4G. Rien n'est ouvert sur internet.
set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TS%" goto :no_tailscale

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:3000/app-info.json | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_app

echo.
echo  Activation de l'adresse securisee https...
echo  Si une page web s'ouvre ou si un lien s'affiche, acceptez l'activation de HTTPS puis revenez ici.
echo.
"%TS%" serve --bg 3000
if errorlevel 1 goto :serve_failed

set "URL="
for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "$s = & $env:TS status --json | ConvertFrom-Json; 'https://' + $s.Self.DNSName.TrimEnd('.')"`) do set "URL=%%U"
if "%URL%"=="https://" set "URL="
if not defined URL goto :no_url

echo.
echo  ==============================================================
echo    Adresse securisee : %URL%
echo  ==============================================================
echo.
echo  Sur chaque telephone :
echo    1. Installez l'application Tailscale ^(App Store / Google Play^)
echo    2. Connectez-vous avec le MEME compte que sur ce PC
echo    3. Ouvrez l'adresse ci-dessus, ou scannez le QR code :
echo       logiciel, menu du compte, "Sur telephone / tablette"
echo.
echo  Ce reglage reste actif apres un redemarrage du PC.
echo  Pour l'arreter : "%TS%" serve --https=443 off
echo.
start "" "%URL%"
pause
exit /b 0

:no_tailscale
echo.
echo  Tailscale n'est pas installe sur ce PC.
echo    1. Installez-le : https://tailscale.com/download/windows
echo    2. Connectez-vous ^(icone Tailscale pres de l'horloge^)
echo    3. Relancez ce fichier.
echo.
start "" https://tailscale.com/download/windows
pause
exit /b 1

:no_app
echo.
echo  Le logiciel ne repond pas sur http://localhost:3000
echo  Lancez d'abord demarrer-windows.bat, laissez la fenetre ouverte, puis relancez ce fichier.
echo.
pause
exit /b 1

:serve_failed
echo.
echo  Tailscale n'a pas pu activer l'adresse https.
echo  Verifiez que Tailscale est connecte, puis sur https://login.tailscale.com/admin/dns
echo  activez "MagicDNS" et "HTTPS Certificates". Relancez ensuite ce fichier.
echo  Si le message parle de droits ou d'acces, relancez ce fichier par clic droit, "Executer en tant qu'administrateur".
echo.
pause
exit /b 1

:no_url
echo.
echo  L'adresse https n'a pas pu etre lue. Tapez cette commande pour l'afficher :
echo    "%TS%" serve status
echo.
pause
exit /b 1
