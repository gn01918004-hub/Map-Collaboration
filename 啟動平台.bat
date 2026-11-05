@echo off
chcp 65001 >nul
title 地籍共作平台
cd /d "%~dp0"
where py >nul 2>nul && (py -3 server\app.py %*) || (python server\app.py %*)
if errorlevel 1 (
  echo.
  echo 啟動失敗：這台電腦可能還沒裝 Python 3（到 https://www.python.org 下載，安裝時勾 Add to PATH）
  pause
)
