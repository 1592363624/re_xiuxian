@echo off
chcp 65001
echo ===================================================
echo 重生之凡人修仙传 - 生产环境启动脚本
echo ===================================================
echo.
echo 正在构建前端资源...
cd client
call npm install
call npm run build
if %errorlevel% neq 0 (
    echo 前端构建失败！
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo 正在安装后端依赖...
cd server
call npm install
cd ..

echo.
echo ===================================================
echo 正在启动生产服务...
echo 访问地址: http://localhost:3000 (或服务器IP:3000)
echo ===================================================
cd server
node index.js
pause
