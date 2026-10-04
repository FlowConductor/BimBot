@echo off
echo Creating BimBot Daily Task Scheduler job...

schtasks /create ^
  /tn "BimBot Daily" ^
  /tr "\"%~dp0run_bimbot.bat\"" ^
  /sc daily ^
  /st 21:00 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %errorlevel% == 0 (
  echo Task created successfully!
  schtasks /query /tn "BimBot Daily"
) else (
  echo Failed to create task. Error: %errorlevel%
)

pause
