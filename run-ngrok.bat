@echo off
echo ========================================
echo   Digilync - Expose localhost for WhatsApp
echo ========================================
echo.
echo Make sure your backend is running first: npm run dev
echo.
echo Starting ngrok on port 5000...
echo (Your public URL will appear below. Use it in Meta webhook configuration.)
echo.
ngrok http 5000
if errorlevel 1 (
    echo.
    echo ngrok failed. Trying localtunnel instead...
    echo.
    npx localtunnel --port 5000
)
echo.
echo Tunnel closed. Press any key to exit.
pause >nul
