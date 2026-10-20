[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [ValidateRange(1024, 65535)]
    [int]$Port = 4545
)

$ErrorActionPreference = 'Stop'
$workDir = $PSScriptRoot
$appUrl = "http://localhost:$Port"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$mutex = $null
$ownsMutex = $false

function Test-StudioReady {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $health.app -eq 'firebase-direct-studio'
    } catch {
        return $false
    }
}

function Test-LocalPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        return $pending.Wait(1000) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Install-StudioDependencies($NodePath, $LogDir) {
    $npmCli = Join-Path (Split-Path -Parent $NodePath) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) {
        $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($npmCommand) {
            $npmCli = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
        }
    }
    if (-not (Test-Path -LiteralPath $npmCli)) {
        throw 'npm is missing. Install Node.js with npm, then open this shortcut again.'
    }
    $installLog = Join-Path $LogDir 'install.log'
    $installErrorLog = Join-Path $LogDir 'install.error.log'
    $progressWindow = $null
    try {
        if (-not $NoBrowser) {
            Add-Type -AssemblyName System.Windows.Forms
            $progressWindow = New-Object System.Windows.Forms.Form
            $progressWindow.Text = 'Firebase Direct Studio'
            $progressWindow.ClientSize = New-Object System.Drawing.Size(470, 115)
            $progressWindow.StartPosition = 'CenterScreen'
            $progressWindow.FormBorderStyle = 'FixedDialog'
            $progressWindow.ControlBox = $false
            $label = New-Object System.Windows.Forms.Label
            $label.Location = New-Object System.Drawing.Point(18, 16)
            $label.Size = New-Object System.Drawing.Size(435, 40)
            $label.Text = 'Setting up Firebase Direct Studio for the first time. Downloading app and Firebase tools; this can take a few minutes.'
            $bar = New-Object System.Windows.Forms.ProgressBar
            $bar.Location = New-Object System.Drawing.Point(18, 72)
            $bar.Size = New-Object System.Drawing.Size(435, 18)
            $bar.Style = 'Marquee'
            $progressWindow.Controls.Add($label)
            $progressWindow.Controls.Add($bar)
            $progressWindow.Show()
            [System.Windows.Forms.Application]::DoEvents()
        }
        $installProcess = Start-Process -FilePath $NodePath `
            -ArgumentList @(('"' + $npmCli + '"'), 'ci', '--no-audit', '--no-fund') `
            -WorkingDirectory $workDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $installLog -RedirectStandardError $installErrorLog
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
        while (-not $installProcess.HasExited) {
            if ($null -ne $progressWindow) { [System.Windows.Forms.Application]::DoEvents() }
            if ([DateTime]::UtcNow -ge $deadline) {
                Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') `
                    -ArgumentList @('/PID', [string]$installProcess.Id, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
                throw "Setup timed out. Check your internet connection and try again. Details: $installErrorLog"
            }
            Start-Sleep -Milliseconds 250
            $installProcess.Refresh()
        }
        # WaitForExit makes the redirected streams and exit code available on Windows PowerShell.
        $installProcess.WaitForExit()
        if ($installProcess.ExitCode -ne 0) {
            throw "Dependency setup failed. Check your internet connection and try again. Details: $installErrorLog"
        }
    } finally {
        if ($null -ne $progressWindow) { $progressWindow.Close(); $progressWindow.Dispose() }
    }
}

try {
    # A second click waits for the first launch instead of starting another server.
    $mutex = New-Object System.Threading.Mutex($false, "Local\FirebaseDirectStudio-$Port")
    try {
        $ownsMutex = $mutex.WaitOne(10000)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'Firebase Direct Studio is still starting. Try the shortcut again in a moment.'
    }

    if (-not (Test-StudioReady)) {
        if (Test-LocalPort) {
            throw "Port $Port is being used by another app or an older Firebase Direct Studio server. Close that server, then open this shortcut again."
        }

        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $nodeCommand) { throw 'Node.js is missing. Install Node.js 22.16 or newer, then open this shortcut again.' }
        $logDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FirebaseDirectStudio\logs'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        if (-not (Test-Path -LiteralPath (Join-Path $workDir 'node_modules\express\package.json')) -or
            -not (Test-Path -LiteralPath (Join-Path $workDir 'node_modules\firebase-tools\package.json'))) {
            Install-StudioDependencies $nodeCommand.Source $logDir
        }
        $stdoutLog = Join-Path $logDir "server-$Port.log"
        $stderrLog = Join-Path $logDir "server-$Port.error.log"
        $previousPort = $env:PORT
        try {
            $env:PORT = [string]$Port
            $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList '"server.js"' `
                -WorkingDirectory $workDir -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        } finally {
            $env:PORT = $previousPort
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-StudioReady)) {
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) {
                throw "The server could not start. Details are saved in $stderrLog"
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "The server did not become ready in 30 seconds. Details are saved in $stderrLog"
            }
            Start-Sleep -Milliseconds 400
        }
    }

    if (-not $NoBrowser) {
        $shortcutScript = Join-Path $workDir 'create-desktop-shortcut.ps1'
        if (Test-Path -LiteralPath $shortcutScript) {
            try { & $shortcutScript | Out-Null }
            catch { Write-Warning 'The app is ready, but the desktop shortcut could not be refreshed.' }
        }
        Start-Process $appUrl
    }
    Write-Output "Firebase Direct Studio is ready at $appUrl"
} catch {
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Firebase Direct Studio', 'OK', 'Error') | Out-Null
    }
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($ownsMutex -and $null -ne $mutex) {
        $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
