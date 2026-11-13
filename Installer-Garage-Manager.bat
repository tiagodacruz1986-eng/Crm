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
powershell -NoProfile -ExecutionPolicy Bypass -Command "if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){Write-Host 'Windows bloque ce programme sur ce PC (mode protege). Montrez ce message a la personne qui gere ce PC.'; exit 1}; $t=[IO.File]::ReadAllText($env:GM_SELF); $i=$t.LastIndexOf('#GM' + '_POWERSHELL#'); if($i -lt 0){Write-Host 'Fichier incomplet : telechargez-le de nouveau.'; exit 1}; try{Invoke-Expression $t.Substring($i)}catch{Write-Host ''; Write-Host ('ERREUR inattendue : ' + $_.Exception.Message) -ForegroundColor Red; Write-Host 'Vos donnees sont intactes. Relancez ce fichier ; si le message revient, photographiez cette fenetre.' -ForegroundColor Yellow; try{Remove-Temp}catch{}; exit 1}" & echo. & pause & exit /b
#GM_POWERSHELL#
# --------------------------------------------------------------------------
# Suite du fichier : programme d'installation (PowerShell, fourni avec Windows)
# --------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
# PC derriere un proxy d'entreprise : on reutilise l'identification Windows
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultCredentials } catch { }

$ZipUrl  = 'https://github.com/tiagodacruz1986-eng/Crm/archive/refs/heads/main.zip'
$MinNode = 'v22.13'
$tmp = $null

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([string]$text) { Write-Host ''; Write-Host ('> ' + $text) -ForegroundColor Cyan }
function Remove-Temp {
  if ($tmp -and ($tmp -like '*garage-manager-*') -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
function Fail([string]$text) {
  Remove-Temp
  Write-Host ''
  Write-Host ('ERREUR : ' + $text) -ForegroundColor Red
  Write-Host 'Vos donnees sont intactes. Vous pouvez relancer ce fichier quand vous voulez.' -ForegroundColor Yellow
  exit 1
}

Say ''
Say '  ==============================================' 'White'
Say '   Garage Manager - installation et mise a jour' 'White'
Say '  ==============================================' 'White'
Say ''
Say '  Ne cliquez pas dans cette fenetre pendant l''installation.'
Say '  (Si elle semble bloquee, appuyez sur la touche Echap.)'

# --- Ou installer ? ---------------------------------------------------------
# On cherche d'abord si le logiciel a deja servi sur ce PC (un dossier qui contient
# "server.js" et la base "data\garage.db") : c'est ce dossier-la qu'on met a jour.
# Sinon : dossier "GarageManager" de l'utilisateur (jamais le Bureau ni Documents :
# OneDrive pourrait abimer la base de donnees).
$here = ($env:GM_HERE).TrimEnd('\')
if ($here -match '^[A-Za-z]:$') { $here = $here + '\' }
$default = Join-Path $env:USERPROFILE 'GarageManager'
$desktopDir = [Environment]::GetFolderPath('Desktop')

if ($here.StartsWith('\\') -and (Test-Path -LiteralPath (Join-Path $here 'data\garage.db'))) {
  Fail 'Ce fichier a ete lance par une adresse reseau (qui commence par \\). Ouvrez plutot ce dossier par sa lettre de lecteur (par exemple Z:) et relancez ce fichier depuis la.'
}

function Test-HasData([string]$d) {
  if ((-not $d) -or $d.StartsWith('\\')) { return $false }
  return ((Test-Path -LiteralPath (Join-Path $d 'server.js')) -and (Test-Path -LiteralPath (Join-Path $d 'data\garage.db')))
}
function Get-LastUse([string]$d) {
  $last = [datetime]::MinValue
  foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $d 'data') -Filter 'garage.db*' -File -ErrorAction SilentlyContinue)) {
    if ($f.LastWriteTime -gt $last) { $last = $f.LastWriteTime }
  }
  return $last
}
$found = New-Object System.Collections.ArrayList
function Add-Found([string]$d) {
  if (-not (Test-HasData $d)) { return }
  foreach ($c in $found) { if (([string]$c).TrimEnd('\') -ieq $d.TrimEnd('\')) { return } }
  $null = $found.Add($d)
}

Say ''
Say '  Recherche d''une installation deja presente sur ce PC (quelques secondes)...'
Add-Found $here
try {
  $lnkPath = Join-Path $desktopDir 'Garage Manager.lnk'
  if (Test-Path -LiteralPath $lnkPath) {
    $lnkTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath).TargetPath
    if ($lnkTarget) { Add-Found (Split-Path -Parent $lnkTarget) }
  }
} catch { }
Add-Found $default
foreach ($root in @($desktopDir, (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('MyDocuments'))) {
  try {
    if ($root -and (Test-Path -LiteralPath $root)) {
      foreach ($f in @(Get-ChildItem -LiteralPath $root -Filter 'garage.db' -File -Recurse -Depth 4 -ErrorAction SilentlyContinue)) {
        if ($f.Directory.Name -eq 'data') { Add-Found $f.Directory.Parent.FullName }
      }
    }
  } catch { }
}

$Dir = $default
if ($found.Count -eq 1) { $Dir = [string]$found[0] }
if ($found.Count -gt 1) {
  $sorted = @($found | Sort-Object { Get-LastUse $_ } -Descending)
  Say ''
  Say '  ATTENTION : Garage Manager a deja servi dans plusieurs dossiers de ce PC :' 'Yellow'
  for ($n = 0; $n -lt $sorted.Count; $n++) {
    Say ('    ' + ($n + 1) + ') ' + $sorted[$n] + '   (derniere utilisation : ' + (Get-LastUse $sorted[$n]).ToString('dd/MM/yyyy HH:mm') + ')') 'Yellow'
  }
  Say '  Le dossier 1 est celui qui a servi en dernier : c''est normalement celui de votre garage.' 'Yellow'
  $idx = -1
  while ($idx -lt 0) {
    $pick = Read-Host '  Numero du dossier a mettre a jour (Entree = 1)'
    if ("$pick" -match '^\s*$') {
      $idx = 0
    } elseif (("$pick" -match '^\s*(\d{1,2})\s*$') -and ([int]$Matches[1] -ge 1) -and ([int]$Matches[1] -le $sorted.Count)) {
      $idx = [int]$Matches[1] - 1
    } else {
      Say ('  Reponse non comprise. Tapez un numero de 1 a ' + $sorted.Count + ', puis Entree.') 'Yellow'
    }
  }
  $Dir = [string]$sorted[$idx]
}
$update  = Test-Path -LiteralPath (Join-Path $Dir 'server.js')
$hasData = Test-Path -LiteralPath (Join-Path $Dir 'data\garage.db')
if ($update -and (Test-Path -LiteralPath (Join-Path $Dir '.git'))) {
  Fail ('Le dossier ' + $Dir + ' est une copie de developpement (il contient un dossier ".git") : la mise a jour automatique y est refusee pour ne rien ecraser.')
}

Say ''
if ($hasData) {
  Say '  MISE A JOUR du logiciel deja installe.' 'White'
  Say ('  Dossier du logiciel : ' + $Dir)
  Say '  Vos donnees (clients, factures, photos) et vos reglages sont conserves.'
} elseif ($update) {
  Say '  MISE A JOUR du logiciel deja installe (il n''a pas encore servi).' 'White'
  Say ('  Dossier du logiciel : ' + $Dir)
} else {
  Say '  NOUVELLE INSTALLATION.' 'White'
  Say ('  Dossier du logiciel : ' + $Dir)
  Say '  Aucune installation n''a ete trouvee sur ce PC : le logiciel demarrera vide'
  Say '  (aucun client, aucune facture).'
  Say '  Vous utilisez deja Garage Manager sur ce PC ? Fermez cette fenetre, copiez ce fichier dans' 'Yellow'
  Say '  le dossier du logiciel (celui qui contient "demarrer-windows.bat") et lancez-le depuis la.' 'Yellow'
}

# --- 1. Le logiciel ne doit pas tourner pendant la mise a jour ---------------
function Get-Port {
  $port = '3000'
  $envFile = Join-Path $Dir '.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in @(Get-Content -LiteralPath $envFile)) {
      if ("$line" -match '^\s*PORT\s*=\s*[^\d#]?(\d+)') { $port = $Matches[1] }
    }
  }
  return $port
}
function Test-Running([string]$port) {
  try { $null = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/app-info.json') -UseBasicParsing -TimeoutSec 3; return $true } catch { return $false }
}
function Test-PortOpen([string]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  $open = $false
  try { $client.Connect('127.0.0.1', [int]$port); $open = $true } catch { }
  try { $client.Close() } catch { }
  return $open
}
# La base de donnees reste ouverte tant que le logiciel tourne : test independant du port
function Test-DbOpen {
  $dbFile = Join-Path $Dir 'data\garage.db'
  if (-not (Test-Path -LiteralPath $dbFile)) { return $false }
  try {
    $h = [IO.File]::Open($dbFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $h.Close()
    return $false
  } catch { return ($_.Exception.GetBaseException() -is [System.IO.IOException]) }
}
function Test-AppOpen { return ((Test-DbOpen) -or (Test-Running (Get-Port))) }
function Wait-AppClosed {
  $tries = 0
  while ((Test-AppOpen) -and ($tries -lt 5)) {
    $tries++
    Say ''
    Say '  Garage Manager est ouvert en ce moment.' 'Yellow'
    Say '  Fermez sa fenetre noire (ou appuyez sur Ctrl+C dedans), puis appuyez sur Entree ici.' 'Yellow'
    $null = Read-Host
  }
  if (Test-AppOpen) { Fail 'Le logiciel est toujours ouvert. Fermez sa fenetre noire, puis relancez ce fichier.' }
}
$portBusy = $false
if ($update) {
  Wait-AppClosed
} elseif (Test-PortOpen (Get-Port)) {
  $portBusy = $true
  Say ''
  Say ('  ATTENTION : un programme repond deja sur ce PC a l''adresse du logiciel (port ' + (Get-Port) + ').') 'Yellow'
  Say '  C''est sans doute Garage Manager, demarre depuis un autre dossier.' 'Yellow'
  Say '  Continuer creerait une DEUXIEME installation, VIDE, a cote de la votre.' 'Yellow'
  Say '  Pour mettre a jour l''installation existante : fermez cette fenetre, copiez ce fichier dans le' 'Yellow'
  Say '  dossier du logiciel (celui qui contient "demarrer-windows.bat") et lancez-le depuis la.' 'Yellow'
  $go = Read-Host '  Creer quand meme une nouvelle installation vide ? (O/N)'
  if ("$go" -notmatch '^\s*[oOyY]') {
    Say ''
    Say '  Installation annulee : rien n''a ete installe.'
    exit 1
  }
}

# --- 2. Node.js -------------------------------------------------------------
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
if (Test-Node) {
  Say ('  Node.js ' + (& node -v) + ' est deja installe.') 'Green'
} else {
  Say ('  Node.js ' + $MinNode + ' ou plus recent est necessaire : installation...')
  Say '  Windows va demander votre accord (fenetre "Voulez-vous autoriser...") : repondez Oui.' 'Yellow'
  Say '  Si rien ne s''affiche, cliquez sur le bouclier qui clignote dans la barre des taches.' 'Yellow'
  Say '  Si Windows demande un mot de passe administrateur, c''est celui de la personne qui gere ce PC.' 'Yellow'
  $ok = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements } catch { }
    Add-NodeToPath
    $ok = Test-Node
  }
  if (-not $ok) {
    try {
      Say '  Telechargement de l''installateur officiel de Node.js...'
      $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
      $lts = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-msi') } | Select-Object -First 1
      $arch = 'x64'
      if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
      $msi = Join-Path $env:TEMP ('node-' + $lts.version + '-' + $arch + '.msi')
      Invoke-WebRequest -Uri ('https://nodejs.org/dist/' + $lts.version + '/node-' + $lts.version + '-' + $arch + '.msi') -OutFile $msi -UseBasicParsing
      $proc = [System.Diagnostics.Process]::Start('msiexec.exe', ('/i "' + $msi + '" /passive /norestart'))
      $proc.WaitForExit()
      Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    } catch { }
    Add-NodeToPath
    $ok = Test-Node
  }
  if (-not $ok) {
    try { $null = [System.Diagnostics.Process]::Start('https://nodejs.org') } catch { }
    Fail 'Node.js n''a pas pu etre installe automatiquement (pas d''internet, ou accord administrateur refuse). La page https://nodejs.org vient de s''ouvrir : telechargez la version LTS, installez-la, puis relancez ce fichier.'
  }
  Say ('  Node.js ' + (& node -v) + ' installe.') 'Green'
}

# --- 3. Telechargement -------------------------------------------------------
Step 'Telechargement de la derniere version'
$tmp = Join-Path $env:TEMP ('garage-manager-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$null = [IO.Directory]::CreateDirectory($tmp)
$zip = Join-Path $tmp 'logiciel.zip'
try { Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing }
catch { Fail ('Telechargement impossible. Verifiez la connexion internet de ce PC, puis relancez ce fichier. (' + $_.Exception.Message + ')') }
try { Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force }
catch { Fail ('Le fichier telecharge est illisible. Relancez ce fichier. (' + $_.Exception.Message + ')') }
$src = Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'server.js') } | Select-Object -First 1
if (-not $src) { Fail 'Le telechargement ne contient pas le logiciel. Relancez ce fichier.' }
$srcDir = $src.FullName
Say '  Telechargement termine.' 'Green'

# --- 4. Composants : telecharges A COTE, avant de toucher au logiciel installe
Step 'Telechargement des composants (une a deux minutes)'
# npm ne lit pas le proxy de Windows : on le lui indique s'il y en a un
try {
  $px = [Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]'https://registry.npmjs.org/')
  if ($px -and ($px.Host -ne 'registry.npmjs.org') -and (-not $env:HTTPS_PROXY)) { $env:HTTPS_PROXY = $px.AbsoluteUri; $env:HTTP_PROXY = $px.AbsoluteUri }
} catch { }
$npmCode = 1
Push-Location -LiteralPath $srcDir
try {
  & cmd.exe /d /c 'npm install --omit=dev --no-audit --no-fund'
  $npmCode = $LASTEXITCODE
} finally { Pop-Location }
$modsSrc = Join-Path $srcDir 'node_modules'
if (($npmCode -ne 0) -or (-not (Test-Path -LiteralPath (Join-Path $modsSrc 'express')))) {
  if ($update) { Fail 'Les composants du logiciel n''ont pas pu etre telecharges. Le logiciel deja installe n''a pas ete modifie et fonctionne comme avant. Verifiez la connexion internet (si ce PC passe par un proxy d''entreprise, demandez a votre informaticien), puis relancez ce fichier.' }
  Fail 'Les composants du logiciel n''ont pas pu etre telecharges. Le logiciel n''a pas ete installe. Verifiez la connexion internet (si ce PC passe par un proxy d''entreprise, demandez a votre informaticien), puis relancez ce fichier.'
}
Say '  Composants telecharges.' 'Green'

# --- 5. Sauvegarde de la base avant toute modification -----------------------
if ($update) { Wait-AppClosed }
$dataDir = Join-Path $Dir 'data'
$db = Join-Path $dataDir 'garage.db'
if (Test-Path -LiteralPath $db) {
  Step 'Sauvegarde de vos donnees'
  $backupRoot = Join-Path $Dir 'sauvegardes'
  $backup = Join-Path $backupRoot (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')
  try {
    $null = [IO.Directory]::CreateDirectory($backup)
    foreach ($f in @(Get-ChildItem -LiteralPath $dataDir -Filter 'garage.db*' -File)) { [IO.File]::Copy($f.FullName, (Join-Path $backup $f.Name), $true) }
  } catch {
    $why = $_.Exception.Message
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    Fail ('La sauvegarde de la base de donnees a echoue : par securite, rien n''a ete modifie. Verifiez que le logiciel est bien ferme et qu''il reste de la place sur le disque, puis relancez ce fichier. (' + $why + ')')
  }
  $copy = Join-Path $backup 'garage.db'
  if ((-not (Test-Path -LiteralPath $copy)) -or ((Get-Item -LiteralPath $copy).Length -ne (Get-Item -LiteralPath $db).Length)) {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'La sauvegarde de la base de donnees est incomplete : par securite, rien n''a ete modifie. Relancez ce fichier.'
  }
  # on garde les 10 dernieres sauvegardes faites par ce fichier (les autres dossiers ne sont jamais touches)
  Get-ChildItem -LiteralPath $backupRoot -Directory | Where-Object { $_.Name -match '^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$' } | Sort-Object Name -Descending | Select-Object -Skip 10 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Say ('  Copie de la base enregistree dans : ' + $backup) 'Green'
  Say '  (Pour revenir en arriere, logiciel ferme : dans le dossier "data", supprimez d''abord garage.db,'
  Say '   garage.db-wal et garage.db-shm, puis copiez-y TOUS les fichiers de cette sauvegarde.)'
}

# --- 6. Copie des fichiers du logiciel (donnees et reglages jamais touches) --
Step 'Installation des fichiers'
$null = [IO.Directory]::CreateDirectory($Dir)
& robocopy $srcDir $Dir /E /XD (Join-Path $srcDir 'data') $modsSrc (Join-Path $srcDir 'sauvegardes') (Join-Path $srcDir '.git') /XF (Join-Path $srcDir '.env') /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail ('La copie des fichiers a echoue (code ' + $LASTEXITCODE + '). Fermez le logiciel et relancez ce fichier.') }
$null = [IO.Directory]::CreateDirectory((Join-Path $Dir 'data'))
$envFile = Join-Path $Dir '.env'
$freePort = 0
if (-not (Test-Path -LiteralPath $envFile)) {
  [IO.File]::Copy((Join-Path $Dir '.env.example'), $envFile, $false)
  if ($portBusy) {
    # le port habituel est pris par un autre programme : cette installation en utilise un libre
    foreach ($cand in 3001..3020) { if ((-not $freePort) -and (-not (Test-PortOpen ([string]$cand)))) { $freePort = $cand } }
    if ($freePort) {
      [IO.File]::WriteAllText($envFile, ([IO.File]::ReadAllText($envFile) -replace '(?m)^(PORT[ \t]*=[ \t]*)\d+', ('${1}' + $freePort)))
      Say ('  Le port 3000 est deja pris sur ce PC : cette installation utilisera le port ' + $freePort + '.') 'Yellow'
    }
  }
}
Say '  Fichiers installes.' 'Green'

# --- 7. Composants : copie de ceux telecharges a l'etape 4 -------------------
Step 'Installation des composants'
$modsDst = Join-Path $Dir 'node_modules'
& robocopy $modsSrc $modsDst /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
  Say '  Copie incomplete : nouvel essai par telechargement...' 'Yellow'
  $npmCode = 1
  Push-Location -LiteralPath $Dir
  try {
    & cmd.exe /d /c 'npm ci --omit=dev --no-audit --no-fund'
    $npmCode = $LASTEXITCODE
  } finally { Pop-Location }
  if (($npmCode -ne 0) -or (-not (Test-Path -LiteralPath (Join-Path $modsDst 'express')))) { Fail 'Les fichiers du logiciel ont ete mis a jour, mais ses composants n''ont pas pu etre installes : le logiciel risque de ne pas demarrer tant que cette etape n''a pas reussi. Fermez le logiciel et votre antivirus s''il bloque, puis relancez ce fichier.' }
}
Say '  Composants installes.' 'Green'

# --- 8. Raccourci sur le bureau ------------------------------------------------
Step 'Raccourci sur le bureau'
$shortcutOk = $false
try {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktopDir 'Garage Manager.lnk'))
  $link.TargetPath = Join-Path $Dir 'demarrer-windows.bat'
  $link.WorkingDirectory = $Dir
  $link.Description = 'Demarrer Garage Manager'
  $icon = Join-Path $Dir 'public\icons\garage-manager.ico'
  if (Test-Path -LiteralPath $icon) { $link.IconLocation = $icon }
  $link.Save()
  $shortcutOk = $true
  Say '  Raccourci "Garage Manager" cree sur le bureau.' 'Green'
} catch { Say '  Le raccourci n''a pas pu etre cree.' 'Yellow' }

Remove-Temp

# --- Termine --------------------------------------------------------------------
Say ''
Say '  ==============================================' 'Green'
if ($update) { Say '   Mise a jour terminee.' 'Green' } else { Say '   Installation terminee.' 'Green' }
Say '  ==============================================' 'Green'
Say ''
if ($shortcutOk) {
  Say '  Pour demarrer : double-cliquez sur "Garage Manager" sur le bureau.'
} else {
  Say '  Pour demarrer : ouvrez le dossier ci-dessous et double-cliquez sur "demarrer-windows.bat".'
  Say ('    ' + $Dir)
}
Say '  Une fenetre noire s''ouvre (laissez-la ouverte), puis votre navigateur affiche le logiciel.'
if ($freePort) { Say ('  Adresse du logiciel sur ce PC : http://localhost:' + $freePort) }
Say '  Pour mettre a jour plus tard : relancez ce fichier (une copie est rangee dans le dossier du logiciel).'
if ($found.Count -gt 1) {
  if ($shortcutOk) {
    Say '  Les autres dossiers n''ont pas ete modifies : utilisez desormais uniquement le raccourci du bureau.' 'Yellow'
  } else {
    Say '  Les autres dossiers n''ont pas ete modifies. ATTENTION : le raccourci du bureau n''a pas pu etre mis a jour' 'Yellow'
    Say '  et ouvre peut-etre un autre dossier : demarrez uniquement depuis le dossier indique ci-dessus.' 'Yellow'
  }
}
Say ''
$answer = Read-Host '  Demarrer Garage Manager maintenant ? (O/N)'
if ("$answer" -match '^\s*[oOyY]') {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $Dir 'demarrer-windows.bat'
    $psi.WorkingDirectory = $Dir
    $null = [System.Diagnostics.Process]::Start($psi)
  } catch { Say '  Le demarrage automatique n''a pas fonctionne : double-cliquez sur "demarrer-windows.bat" dans le dossier du logiciel.' 'Yellow' }
}
exit 0
