@echo off
rem 一键跑 wb-relay 端到端验证（fake CLI，不依赖真实 WorkBuddy 账号）
cd /d "%~dp0\.."
node test\verify.js
