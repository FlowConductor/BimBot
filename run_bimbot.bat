@echo off
rem Runs the bot from the directory this script lives in.
cd /d "%~dp0"
node bim_youtube_bot.js >> output.log 2>&1
