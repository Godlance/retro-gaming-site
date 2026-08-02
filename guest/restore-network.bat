@echo off
setlocal

rem Windows XP normally names the first adapter "Local Area Connection".
rem Pass a different connection name as argument 1 when the image uses one.
set "V86_NIC=Local Area Connection"
if not "%~1"=="" set "V86_NIC=%~1"

ipconfig /release >nul 2>&1
netsh interface set interface name="%V86_NIC%" admin=DISABLED >nul 2>&1
ping -n 2 127.0.0.1 >nul
netsh interface set interface name="%V86_NIC%" admin=ENABLED >nul 2>&1
ping -n 3 127.0.0.1 >nul
ipconfig /renew
ipconfig /flushdns >nul 2>&1

endlocal
