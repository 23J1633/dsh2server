@echo off
rem ============================================================================
rem  dsh2server — PHP 测试后端一键启动
rem
rem  用法：双击本文件，或在命令行执行  php\start-relay.cmd
rem  关闭本窗口即停止服务。
rem
rem  为什么建议你自己启动：中转服务器是独立进程，让它跑在你自己的终端里最稳
rem  （放在别的进程树下时，那个进程一重启就会把它一起带走）。
rem ============================================================================
setlocal
cd /d "%~dp0"

set "PHP_BIN=php"
where php >nul 2>nul
if errorlevel 1 (
  if exist "D:\xampp\php\php.exe" (
    set "PHP_BIN=D:\xampp\php\php.exe"
  ) else (
    echo [!] 找不到 php，请把 PHP 加入 PATH，或修改本文件里的 PHP_BIN。
    pause
    exit /b 1
  )
)

if "%DSH_RELAY_PORT%"=="" set "DSH_RELAY_PORT=8080"
if "%DSH_RELAY_HOST%"=="" set "DSH_RELAY_HOST=127.0.0.1"

echo.
echo   dsh2server PHP 中转服务器
echo     API 端点 : http://%DSH_RELAY_HOST%:%DSH_RELAY_PORT%/dsh-api
echo     测试台   : http://%DSH_RELAY_HOST%:%DSH_RELAY_PORT%/
echo     key 白名单: %~dp0keys.json
echo     运行状态 : %~dp0data\state.json
echo.
echo   在 dsh 的 设置 - 插件 - dsh2server 里把端点填成上面这个 API 端点即可。
echo   按 Ctrl+C 或关闭本窗口停止服务。
echo.

"%PHP_BIN%" -S %DSH_RELAY_HOST%:%DSH_RELAY_PORT% dsh-relay.php
