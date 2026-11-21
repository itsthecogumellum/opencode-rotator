<#
.SYNOPSIS
  Instalador de um comando do OpenCode Rotator.
.DESCRIPTION
  Baixa (ou usa o checkout local), instala as dependencias, configura o WARP em modo proxy,
  registra o bridge para subir sozinho com o Windows, sobe o servico e roda o doctor.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
  iwr https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [int]$OpenCodePort = 4097,
  [int]$ProxyPort = 40000,
  [string]$DefaultModel = "opencode/deepseek-v4.1-flash-free",
  [switch]$SkipWarp,
  [switch]$SkipService,
  [switch]$TakeOver,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoOwner = 'itsthecogumellum'
$RepoName  = 'opencode-rotator'
$TaskName  = 'OpenCodeRotator'

# PowerShell 5.1 nao conhece o escape `e; o codigo ANSI e montado na mao.
$ESC = [char]27
$Green = "$ESC[32m"
$Yellow = "$ESC[33m"
$Red = "$ESC[31m"
$Dim = "$ESC[90m"
$Reset = "$ESC[0m"

function Say  ($m) { Write-Host $m }
function Ok   ($m) { Write-Host ("{0}[OK]{1}    {2}" -f $Green, $Reset, $m) }
function Warn ($m) { Write-Host ("{0}[AVISO]{1} {2}" -f $Yellow, $Reset, $m) }
function Die  ($m) { Write-Host ("{0}[FALHA]{1} {2}" -f $Red, $Reset, $m); exit 1 }
function Step ($m) { Write-Host ("`n{0}==>{1} {2}" -f $Yellow, $Reset, $m) }

function Resolve-Source {
  if ($PSScriptRoot -and (Test-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'SKILL.md'))) {
    return (Split-Path $PSScriptRoot -Parent)
  }
  # veio por pipe (iwr | iex): sem $PSScriptRoot, entao baixa o repo.
  Say ("{0}baixando o {1}...{2}" -f $Dim, $RepoName, $Reset)
  $tmp = Join-Path $env:TEMP ("opencode-rotator-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp 'repo.zip'
  $url = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/main.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem $tmp -Directory | Select-Object -First 1
  return $extracted.FullName
}

function Test-PortInUse([int]$PortNumber) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction Stop | Select-Object -First 1
    return [bool]$conn
  } catch {
    return $false
  }
}

function Get-PortOwner([int]$PortNumber) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction Stop | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Pid = $conn.OwningProcess; CommandLine = $proc.CommandLine; Name = $proc.Name }
  } catch {
    return $null
  }
}

$AppDir = Join-Path $env:LOCALAPPDATA 'opencode-rotator'

function Uninstall {
  Step "Removendo o OpenCode Rotator"
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Ok "tarefa agendada $TaskName removida"
  } catch {
    Warn "tarefa $TaskName nao existia"
  }
  # Mata apenas as instancias deste pacote (caminho da propria pasta), nunca outros bridges.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$AppDir*" -and $_.CommandLine -like '*bridge.mjs*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Ok "processo bridge encerrado (pid $($_.ProcessId))"
    }
  if (Test-Path $AppDir) {
    Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
    Ok "pasta $AppDir removida"
  }
  Say ("`n{0}Desinstalado.{1} O WARP e o opencode continuam instalados.`n" -f $Green, $Reset)
  exit 0
}

if ($Uninstall) { Uninstall }

$Source = Resolve-Source
Say ("`n{0}OpenCode Rotator - instalador{1}" -f $Yellow, $Reset)
Say ("{0}origem: {1}{2}" -f $Dim, $Source, $Reset)

# ---------------------------------------------------------------- 1. Node
Step "1/6 Node.js"
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node --version) -replace 'v', ''
  $major = [int]($v.Split('.')[0])
  if ($major -ge 20) {
    $nodeOk = $true
    Ok "Node $v"
  } else {
    Warn "Node $v e antigo demais (precisa 20+)"
  }
}
if (-not $nodeOk) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "  instalando Node LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements | Out-Null
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    if (Get-Command node -ErrorAction SilentlyContinue) {
      $nodeOk = $true
      Ok "Node instalado: $(node --version)"
    }
  }
}
if (-not $nodeOk) { Die "Node.js 20+ e obrigatorio. Baixe em https://nodejs.org e rode o instalador de novo." }

# ---------------------------------------------------------------- 2. opencode
Step "2/6 opencode"
function Find-Opencode {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\ai.opencode.desktop\resources\opencode-cli.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\opencode\opencode.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command opencode -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$opencodeBin = Find-Opencode
if ($opencodeBin) {
  Ok "opencode encontrado: $opencodeBin"
} else {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Say "  instalando opencode via npm..."
    npm install -g opencode-ai 2>&1 | Out-Null
    $opencodeBin = Find-Opencode
  }
  if ($opencodeBin) {
    Ok "opencode instalado: $opencodeBin"
  } else {
    Warn "opencode nao encontrado. Instale o app desktop ou rode: npm i -g opencode-ai"
  }
}

# ---------------------------------------------------------------- 3. WARP
Step "3/6 Cloudflare WARP (rota de IP)"
$warpCli = 'C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe'
if (-not (Test-Path $warpCli)) {
  $cmd = Get-Command warp-cli -ErrorAction SilentlyContinue
  if ($cmd) { $warpCli = $cmd.Source }
}
if (-not $warpCli -and -not $SkipWarp) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "  instalando Cloudflare WARP via winget..."
    winget install --id Cloudflare.CloudflareWARP -e --accept-package-agreements --accept-source-agreements | Out-Null
  }
  if (-not (Test-Path $warpCli)) {
    $cmd = Get-Command warp-cli -ErrorAction SilentlyContinue
    if ($cmd) { $warpCli = $cmd.Source }
  }
}
if (-not $warpCli) {
  Warn "warp-cli nao encontrado: a rotacao de IP fica desligada. Instale o Cloudflare WARP."
} elseif (-not $SkipWarp) {
  & $warpCli --accept-tos mode proxy | Out-Null
  & $warpCli --accept-tos proxy port $ProxyPort | Out-Null
  # so registra quando ainda nao ha registro (registrar de novo troca o device e o IP)
  $registration = (& $warpCli --accept-tos registration show 2>&1) -join ' '
  if ($registration -notmatch 'Account type') {
    Say "  registrando no WARP (sem conta, plano free)..."
    & $warpCli --accept-tos registration new | Out-Null
  }
  & $warpCli --accept-tos connect | Out-Null
  Start-Sleep -Seconds 4
  $warpStatus = (& $warpCli --accept-tos status 2>&1) -join ' '
  if ($warpStatus -match 'Connected') {
    Ok "WARP conectado em modo proxy (porta $ProxyPort)"
  } else {
    Warn "WARP nao conectou: $warpStatus"
  }
}

# ---------------------------------------------------------------- portas
Step "portas"
$owner = Get-PortOwner $Port
if ($owner) {
  if ($TakeOver) {
    Write-Host ("  {0}porta {1} ocupada por {2} (pid {3}). Assumindo a porta.{4}" -f $Yellow, $Port, $owner.Name, $owner.Pid, $Reset)
    Stop-Process -Id $owner.Pid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Ok "porta $Port liberada"
  } else {
    Die ("porta {0} ja esta em uso por {1} (pid {2}).`n  Linha de comando: {3}`n  Use -TakeOver para o OpenCode Rotator assumir essa porta, ou -Port <outra porta>." -f $Port, $owner.Name, $owner.Pid, $owner.CommandLine)
  }
}

# A porta do opencode serve e interna. Se estiver ocupada, o proprio bridge escolhe a
# proxima livre em runtime — nao matamos nada aqui para nao derrubar outro opencode.
$ocOwner = Get-PortOwner $OpenCodePort
if ($ocOwner) {
  Warn "porta do opencode serve $OpenCodePort ocupada por $($ocOwner.Name) (pid $($ocOwner.Pid)); o bridge vai usar a proxima livre"
}

# ---------------------------------------------------------------- 4. arquivos
Step "4/6 arquivos em $AppDir"
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
foreach ($folder in @('scripts','templates','references','prompts')) {
  $src = Join-Path $Source $folder
  if (Test-Path $src) {
    $dst = Join-Path $AppDir $folder
    Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $src $dst -Recurse -Force
  }
}
foreach ($file in @('SKILL.md','README.md','GUIA-COMPLETO.md','LICENSE')) {
  $src = Join-Path $Source $file
  if (Test-Path $src) { Copy-Item $src (Join-Path $AppDir $file) -Force }
}
Ok "arquivos copiados"

# ---------------------------------------------------------------- 5. config
Step "5/6 configuracao"
$config = [ordered]@{
  bridgePort   = $Port
  opencodePort = $OpenCodePort
  proxyUrl     = "http://127.0.0.1:$ProxyPort"
  defaultModel = $DefaultModel
  opencodeBin  = $opencodeBin
  warpCli      = $warpCli
  keepSessions = $false
}
# Grava sem BOM: o Node faz JSON.parse e BOM quebra.
$cfgPath = Join-Path $AppDir 'config.json'
[IO.File]::WriteAllText($cfgPath, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Ok "config.json gravado (bridge :$Port, proxy :$ProxyPort)"

# ---------------------------------------------------------------- 6. servico
Step "6/6 inicializacao automatica"
if (-not $SkipService) {
  $nodeBin = (Get-Command node).Source
  $bridgePath = Join-Path $AppDir 'scripts\bridge.mjs'
  $registered = $false
  try {
    $action = New-ScheduledTaskAction -Execute $nodeBin -Argument ('"{0}"' -f $bridgePath) -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Gateway OpenAI-compatible com rotacao automatica de IP (OpenCode Rotator)' -Force -ErrorAction Stop | Out-Null
    $registered = $true
    Ok "tarefa agendada '$TaskName' criada (sobe com o login, reinicia a cada 1 min se morrer)"
  } catch {
    Warn "tarefa agendada negada (exige administrador): $($_.Exception.Message)"
    # Fallback sem admin: atalho na pasta de Inicializar do usuario.
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    New-Item -ItemType Directory -Path $startup -Force | Out-Null
    $cmdFile = Join-Path $startup 'OpenCodeRotator.cmd'
    $cmdBody = "@echo off`r`ncd /d `"$AppDir`"`r`n`"$nodeBin`" `"$bridgePath`"`r`n"
    [IO.File]::WriteAllText($cmdFile, $cmdBody, [Text.Encoding]::ASCII)
    $registered = $true
    Ok "atalho de inicializacao criado (sem admin): $cmdFile"
    Write-Host ("  {0}para a tarefa agendada com reinicio automatico, rode o instalador como administrador{1}" -f $Dim, $Reset)
  }
} else {
  $nodeBin = (Get-Command node).Source
  $bridgePath = Join-Path $AppDir 'scripts\bridge.mjs'
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$AppDir*" -and $_.CommandLine -like '*bridge.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-Process -FilePath $nodeBin -ArgumentList ('"{0}"' -f $bridgePath) -WorkingDirectory $AppDir -WindowStyle Hidden
Ok "bridge iniciado"

Write-Host ("`n{0}aguardando o bridge responder...{1}" -f $Dim, $Reset)
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 750
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($h.ok) { $up = $true; break }
  } catch {}
}
if ($up) {
  Ok "bridge respondendo em http://127.0.0.1:$Port"
} else {
  Warn "bridge ainda nao respondeu; veja $AppDir\bridge.log"
}

# ---------------------------------------------------------------- doctor
Step "doctor"
& $nodeBin (Join-Path $AppDir 'scripts\doctor.mjs')
$doctorExit = $LASTEXITCODE

Write-Host ("`n{0}Instalado.{1}" -f $Green, $Reset)
Write-Host ("  uso:        node `"{0}\scripts\bridgectl.mjs`" status" -f $AppDir)
Write-Host ("  rotacionar: node `"{0}\scripts\bridgectl.mjs`" rotate" -f $AppDir)
Write-Host ("  log:        {0}\bridge.log`n" -f $AppDir)
exit $doctorExit
