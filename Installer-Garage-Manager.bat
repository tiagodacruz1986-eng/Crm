@echo off
setlocal
title Installation de Garage Manager
rem ============================================================================
rem  Installer-Garage-Manager.bat
rem  Double-cliquez sur ce fichier pour INSTALLER ou METTRE A JOUR Garage Manager
rem  sur ce PC (Windows 10 ou 11). Il installe Node.js si besoin, telecharge la
rem  derniere version du logiciel, cree un raccourci sur le bureau et ne touche
rem  jamais a vos donnees (dossier "data") ni a vos reglages (fichier ".env").
rem ============================================================================
set "GM_SELF=%~f0"
set "GM_HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:GM_SELF); $i=$t.LastIndexOf('#GM' + '_POWERSHELL#'); if($i -lt 0){Write-Host 'Fichier incomplet : telechargez-le de nouveau.'; exit 1}; Invoke-Expression $t.Substring($i)" & echo. & pause & exit /b
#GM_POWERSHELL#
# --------------------------------------------------------------------------
# Suite du fichier : programme d'installation (PowerShell, fourni avec Windows)
# --------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$ZipUrl  = 'https://github.com/tiagodacruz1986-eng/Crm/archive/refs/heads/main.zip'
$MinNode = 'v22.13'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([string]$text) { Write-Host ''; Write-Host ('> ' + $text) -ForegroundColor Cyan }
function Fail([string]$text) {
  Write-Host ''
  Write-Host ('ERREUR : ' + $text) -ForegroundColor Red
  Write-Host 'Rien n''a ete supprime. Vous pouvez relancer ce fichier quand vous voulez.' -ForegroundColor Yellow
  exit 1
}

# --- Ou installer ? ---------------------------------------------------------
# Si ce fichier se trouve dans un dossier ou le logiciel a deja servi (il contient des donnees),
# la mise a jour se fait sur place. Sinon : dossier "GarageManager" de l'utilisateur
# (jamais le Bureau ni Documents : OneDrive pourrait abimer la base de donnees).
$here = ($env:GM_HERE).TrimEnd('\')
$inPlace = (Test-Path -LiteralPath (Join-Path $here 'server.js')) -and (Test-Path -LiteralPath (Join-Path $here 'data\garage.db'))
if ($inPlace) { $Dir = $here } else { $Dir = Join-Path $env:USERPROFILE 'GarageManager' }
$update = Test-Path -LiteralPath (Join-Path $Dir 'server.js')

Say ''
Say '  ==============================================' 'White'
if ($update) { Say '   Garage Manager - mise a jour' 'White' } else { Say '   Garage Manager - installation' 'White' }
Say '  ==============================================' 'White'
Say ''
Say ('  Dossier du logiciel : ' + $Dir)
Say '  Vos donnees (clients, factures, photos) et vos reglages sont conserves.'

# --- 1. Node.js -------------------------------------------------------------
function Add-NodeToPath {
  foreach ($p in @((Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))) {
    if ((Test-Path -LiteralPath (Join-Path $p 'node.exe')) -and (($env:Path -split ';') -notcontains $p)) { $env:Path = $p + ';' + $env:Path }
  }
}
function Test-Node {
  try {
    $v = & node -v
    if ("$v" -match '^v(\d+)\.(\d+)') { $maj = [int]$Matches[1]; $min = [int]$Matches[2]; return (($maj -gt 22) -or (($maj -eq 22) -and ($min -ge 13))) }
  } catch { }
  return $false
}
Step 'Verification de Node.js (le moteur du logiciel)'
Add-NodeToPath
if (Test-Node) { Say ('  Node.js ' + (& node -v) + ' est deja installe.') 'Green' }
else {
  Say ('  Node.js ' + $MinNode + ' ou plus recent est necessaire : installation...')
  Say '  Windows peut demander votre accord (fenetre "Voulez-vous autoriser...") : repondez Oui.' 'Yellow'
  $ok = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Host } catch { }
    Add-NodeToPath; $ok = Test-Node
  }
  if (-not $ok) {
    try {
      Say '  Telechargement de l''installateur officiel de Node.js...'
      $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
      $lts = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-msi') } | Select-Object -First 1
      $arch = 'x64'; if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
      $msi = Join-Path $env:TEMP ('node-' + $lts.version + '-' + $arch + '.msi')
      Invoke-WebRequest -Uri ('https://nodejs.org/dist/' + $lts.version + '/node-' + $lts.version + '-' + $arch + '.msi') -OutFile $msi -UseBasicParsing
      Start-Process -FilePath 'msiexec.exe' -ArgumentList ('/i "' + $msi + '" /passive /norestart') -Wait
      Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    } catch { }
    Add-NodeToPath; $ok = Test-Node
  }
  if (-not $ok) {
    try { Start-Process 'https://nodejs.org' } catch { }
    Fail 'Node.js n''a pas pu etre installe automatiquement. La page https://nodejs.org vient de s''ouvrir : telechargez la version LTS, installez-la, puis relancez ce fichier.'
  }
  Say ('  Node.js ' + (& node -v) + ' installe.') 'Green'
}

# --- 2. Le logiciel ne doit pas tourner pendant la mise a jour ---------------
function Get-Port {
  $port = '3000'
  $envFile = Join-Path $Dir '.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in (Get-Content -LiteralPath $envFile)) { if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = $Matches[1] } }
  }
  return $port
}
function Test-Running([string]$port) {
  try { $null = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/app-info.json') -UseBasicParsing -TimeoutSec 3; return $true } catch { return $false }
}
if ($update) {
  $port = Get-Port
  $tries = 0
  while ((Test-Running $port) -and ($tries -lt 5)) {
    $tries++
    Say ''
    Say '  Garage Manager est ouvert en ce moment.' 'Yellow'
    Say '  Fermez sa fenetre noire (ou appuyez sur Ctrl+C dedans), puis appuyez sur Entree ici.' 'Yellow'
    $null = Read-Host
  }
  if (Test-Running $port) { Fail 'Le logiciel est toujours ouvert. Fermez sa fenetre noire, puis relancez ce fichier.' }
}

# --- 3. Telechargement -------------------------------------------------------
Step 'Telechargement de la derniere version'
$tmp = Join-Path $env:TEMP ('garage-manager-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmp -Force
$zip = Join-Path $tmp 'logiciel.zip'
try { Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing }
catch { Fail ('Telechargement impossible. Verifiez la connexion internet de ce PC, puis relancez ce fichier. (' + $_.Exception.Message + ')') }
try { Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force }
catch { Fail ('Le fichier telecharge est illisible. Relancez ce fichier. (' + $_.Exception.Message + ')') }
$src = Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'server.js') } | Select-Object -First 1
if (-not $src) { Fail 'Le telechargement ne contient pas le logiciel. Relancez ce fichier.' }
Say '  Telechargement termine.' 'Green'

# --- 4. Sauvegarde de la base avant toute modification -----------------------
$db = Join-Path $Dir 'data\garage.db'
if (Test-Path -LiteralPath $db) {
  Step 'Sauvegarde de vos donnees'
  $backupRoot = Join-Path $Dir 'sauvegardes'
  $backup = Join-Path $backupRoot (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')
  $null = New-Item -ItemType Directory -Path $backup -Force
  Copy-Item -Path (Join-Path $Dir 'data\garage.db*') -Destination $backup -Force
  # on garde les 10 dernieres sauvegardes
  Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 10 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Say ('  Copie de la base enregistree dans : ' + $backup) 'Green'
}

# --- 5. Copie des fichiers du logiciel (donnees et reglages jamais touches) --
Step 'Installation des fichiers'
$null = New-Item -ItemType Directory -Path $Dir -Force
$srcDir = $src.FullName
& robocopy $srcDir $Dir /E /XD (Join-Path $srcDir 'data') (Join-Path $srcDir 'node_modules') (Join-Path $srcDir 'sauvegardes') /XF (Join-Path $srcDir '.env') /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail ('La copie des fichiers a echoue (code ' + $LASTEXITCODE + '). Fermez le logiciel et relancez ce fichier.') }
$null = New-Item -ItemType Directory -Path (Join-Path $Dir 'data') -Force
if (-not (Test-Path -LiteralPath (Join-Path $Dir '.env'))) { Copy-Item -LiteralPath (Join-Path $Dir '.env.example') -Destination (Join-Path $Dir '.env') }
Say '  Fichiers installes.' 'Green'

# --- 6. Composants du logiciel ------------------------------------------------
Step 'Installation des composants (une a deux minutes la premiere fois)'
Push-Location -LiteralPath $Dir
try {
  & cmd.exe /d /c 'npm install --omit=dev --no-audit --no-fund'
  $npmCode = $LASTEXITCODE
} finally { Pop-Location }
if ($npmCode -ne 0) { Fail 'L''installation des composants a echoue. Verifiez la connexion internet, puis relancez ce fichier.' }
Say '  Composants installes.' 'Green'

# --- 7. Raccourci sur le bureau ------------------------------------------------
Step 'Raccourci sur le bureau'
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'Garage Manager.lnk'))
  $link.TargetPath = Join-Path $Dir 'demarrer-windows.bat'
  $link.WorkingDirectory = $Dir
  $link.Description = 'Demarrer Garage Manager'
  $icon = Join-Path $Dir 'public\icons\garage-manager.ico'
  if (Test-Path -LiteralPath $icon) { $link.IconLocation = $icon }
  $link.Save()
  Say '  Raccourci "Garage Manager" cree sur le bureau.' 'Green'
} catch { Say '  Le raccourci n''a pas pu etre cree : demarrez le logiciel avec "demarrer-windows.bat" dans le dossier du logiciel.' 'Yellow' }

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- Termine --------------------------------------------------------------------
Say ''
Say '  ==============================================' 'Green'
if ($update) { Say '   Mise a jour terminee.' 'Green' } else { Say '   Installation terminee.' 'Green' }
Say '  ==============================================' 'Green'
Say ''
Say '  Pour demarrer : double-cliquez sur "Garage Manager" sur le bureau.'
Say '  Une fenetre noire s''ouvre (laissez-la ouverte), puis votre navigateur affiche le logiciel.'
Say '  Pour mettre a jour plus tard : relancez ce fichier.'
Say ''
$answer = Read-Host '  Demarrer Garage Manager maintenant ? (O/N)'
if ("$answer" -match '^\s*[oOyY]') { Start-Process -FilePath (Join-Path $Dir 'demarrer-windows.bat') -WorkingDirectory $Dir }
exit 0
