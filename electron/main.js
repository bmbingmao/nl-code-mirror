// NL Code Mirror — Electron 桌面壳
// 内置启动 server.js(端口 8790),打开本地窗口;用户无需安装 Node
const { app, BrowserWindow } = require('electron');
const { fork } = require('child_process');
const path = require('path');

const PORT = 8790;
let srv = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'NL Code Mirror',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // 等服务就绪后加载(重试)
  const tryLoad = () => {
    win.loadURL(`http://127.0.0.1:${PORT}`).catch(() => setTimeout(tryLoad, 500));
  };
  tryLoad();
  return win;
}

app.whenReady().then(() => {
  // 在子进程启动后端(端口 8790,避开用户可能已跑的 8787)
  srv = fork(path.join(__dirname, '..', 'server', 'server.js'), [], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
  });
  srv.on('exit', (code) => {
    if (code && code !== 0) console.error('后端退出码:', code);
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (srv) { try { srv.kill(); } catch {} srv = null; }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
