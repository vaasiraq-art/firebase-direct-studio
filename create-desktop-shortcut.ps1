$ErrorActionPreference = "Stop"
$workDir = $PSScriptRoot
$icoPath = Join-Path $workDir "firebase-direct.ico"
$launcherPath = Join-Path $workDir "Start-Firebase-Direct.ps1"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

# 1. Generate a custom 64x64 .ico file using System.Drawing
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# Background circle/badge
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$g.FillEllipse($bgBrush, 2, 2, 60, 60)

$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 245, 158, 11), 3)
$g.DrawEllipse($borderPen, 3, 3, 58, 58)

# Flame / Rocket polygon in Firebase Orange/Gold
$flameBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 251, 191, 36))
$pts = @(
    (New-Object System.Drawing.Point(18, 46)),
    (New-Object System.Drawing.Point(26, 14)),
    (New-Object System.Drawing.Point(34, 28)),
    (New-Object System.Drawing.Point(42, 18)),
    (New-Object System.Drawing.Point(48, 46)),
    (New-Object System.Drawing.Point(33, 54))
)
$g.FillPolygon($flameBrush, $pts)

# Inner core accent
$coreBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 88, 12))
$ptsCore = @(
    (New-Object System.Drawing.Point(24, 46)),
    (New-Object System.Drawing.Point(33, 28)),
    (New-Object System.Drawing.Point(42, 46)),
    (New-Object System.Drawing.Point(33, 52))
)
$g.FillPolygon($coreBrush, $ptsCore)

$g.Dispose()

# Write valid ICO with embedded PNG
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
# ICONDIR header
$bw.Write([UInt16]0)   # Reserved
$bw.Write([UInt16]1)   # Type: 1 = ICO
$bw.Write([UInt16]1)   # Count: 1 image
# ICONDIRENTRY
$bw.Write([Byte]64)    # Width
$bw.Write([Byte]64)    # Height
$bw.Write([Byte]0)     # Colors
$bw.Write([Byte]0)     # Reserved
$bw.Write([UInt16]1)   # Planes
$bw.Write([UInt16]32)  # BPP
$bw.Write([UInt32]$pngBytes.Length) # Size
$bw.Write([UInt32]22)  # Offset (6 + 16)
$bw.Write($pngBytes)
$bw.Close()
$fs.Close()

# 2. Create Desktop Shortcut (.lnk)
$WshShell = New-Object -ComObject WScript.Shell
$desktopDir = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktopDir "Firebase Direct Studio.lnk"
$localShortcutPath = Join-Path $workDir "Firebase Direct Studio.lnk"

foreach ($lnk in @($desktopShortcutPath, $localShortcutPath)) {
    $shortcut = $WshShell.CreateShortcut($lnk)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $workDir
    $shortcut.WindowStyle = 7
    $shortcut.IconLocation = "$icoPath,0"
    $shortcut.Description = "Open Firebase Direct Studio in your default browser"
    $shortcut.Save()
}

Write-Output "Created icon at: $icoPath"
Write-Output "Created Desktop shortcut at: $desktopShortcutPath"
