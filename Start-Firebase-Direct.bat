@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-Firebase-Direct.ps1"
exit /b %errorlevel%
