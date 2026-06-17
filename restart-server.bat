@echo off
echo Jungiuosi prie serverio 10.2.1.115...
echo Kai paklaus slaptazodzio - iveskite serverio SSH slaptazodi.
echo.
ssh -o StrictHostKeyChecking=no -t eimutis.simkus@10.2.1.115 "[ -d ~/propoint ] && (cd ~/propoint && git pull) || git clone https://github.com/energo-git1/propoint ~/propoint; cd ~/propoint && npm install --omit=dev && pm2 start server.js --name propoint 2>/dev/null || pm2 restart propoint; pm2 save; pm2 logs propoint --lines 10"
echo.
pause
