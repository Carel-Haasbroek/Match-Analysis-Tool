'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { createServer } = require('./server');

const ROOT = path.join(__dirname, '..');

let win = null;
let store = null;
let http = null;
let port = 0;

function createWindow(){
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#120d1f',
    title: 'Video Notes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.removeMenu();
  win.loadURL('http://127.0.0.1:' + port + '/video-notes.html');
  win.on('closed', () => { win = null; });
}

/* ---------- storage bridge: exactly the shape app.js already looks for ---------- */
ipcMain.handle('store:get', (e, key) => store.get(key));
ipcMain.handle('store:set', (e, key, value) => store.set(key, value));
ipcMain.handle('store:keys', () => store.keys());

/* ---------- videos ---------- */
ipcMain.handle('video:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4','m4v','webm','mkv','mov','avi','ogv'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return describe(r.filePaths[0]);
});

ipcMain.handle('video:stat', (e, filePath) => {
  if (!filePath) return null;
  return describe(filePath);
});

function describe(filePath){
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (err) { return null; }
  if (!stat.isFile()) return null;
  http.allow(filePath);                 /* only now may it be served */
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    url: 'http://127.0.0.1:' + port + '/media?p=' +
         Buffer.from(filePath, 'utf8').toString('base64url')
  };
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'store'));
  http = createServer({ root: ROOT });
  port = await http.listen();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
