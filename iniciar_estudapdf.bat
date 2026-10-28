@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Iniciando EstudaPDF em http://localhost:8080 ...
start "" "http://localhost:8080"
python server.py 8080
pause

