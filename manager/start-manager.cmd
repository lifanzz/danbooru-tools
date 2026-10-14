@echo off
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
python -X utf8 serve.py
if errorlevel 1 pause
