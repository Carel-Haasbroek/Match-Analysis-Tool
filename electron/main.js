'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { FolderStore } = require('./folderstore');
const { resolveDataDir, migrateIfNeeded } = require('./datadir');
const { createServer } = require('./server');

const ROOT = path.join(__dirname, '..');

let win = null;
let store = null;
let dataDir = null;          /* { dir, kind } */
let migration = null;        /* what happened on first run, reported to the window */
let http = null;
let port = 0;

function createWindow(){
  /* A packaged app takes its window icon from the exe. Running from source there is
     no exe, so point at the png or the window shows Electron's default. */
  const devIcon = path.join(ROOT, 'build', 'icon.png');

  win = new BrowserWindow({
    icon: app.isPackaged ? undefined : (fs.existsSync(devIcon) ? devIcon : undefined),
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
  win.loadURL('http://127.0.0.1:' + port + '/app.html');
  win.on('closed', () => { win = null; });
}

/* ---------- storage bridge: exactly the shape app.js already looks for ---------- */
ipcMain.handle('store:get', (e, key) => store.get(key));
ipcMain.handle('store:set', (e, key, value) => store.set(key, value));
ipcMain.handle('store:keys', () => store.keys());

/* where the notes actually are, and what the first run did with them */
ipcMain.handle('app:dataDir', () => ({
  dir: dataDir.dir, kind: dataDir.kind, migration: migration
}));
ipcMain.handle('app:reveal', (e, target) => {
  shell.openPath(target || dataDir.dir);
  return true;
});

/* grouping: the app's folders are the folders on disk */
ipcMain.handle('session:move', (e, key, groupPath) => store.moveSession(key, groupPath));

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
  dataDir = resolveDataDir(app);
  store = new FolderStore(dataDir.dir);

  /* One-time move out of the old base64-blob store. It writes a backup first and
     never deletes the old copy: this is work that cannot be recreated. */
  try {
    migration = migrateIfNeeded(path.join(app.getPath('userData'), 'store'), store,
      (m) => console.log('[migrate] ' + m));
    if (migration && migration.migrated){
      console.log('[migrate] moved ' + migration.migrated + ' keys, ' +
        migration.notesBefore + ' notes -> ' + migration.notesAfter +
        (migration.intact ? ' (intact)' : ' (MISMATCH)'));
    }
  } catch (err) {
    migration = { error: String(err && err.message || err) };
    console.error('[migrate] failed: ' + migration.error);
  }
  console.log('[notes] ' + dataDir.dir + '  (' + dataDir.kind + ')');
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
