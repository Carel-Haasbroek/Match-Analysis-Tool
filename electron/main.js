'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { FolderStore } = require('./folderstore');
const { Vaults } = require('./vaults');
const { VaultStore } = require('./vaultstore');
const { resolveDataDir, migrateIfNeeded } = require('./datadir');
const { createServer } = require('./server');

const ROOT = path.join(__dirname, '..');

let win = null;
let store = null;            /* a VaultStore: one FolderStore per vault, routed by key */
let vaults = null;
let dataDir = null;          /* { dir, kind } - the first vault, where legacy keys live */
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
/* Who is writing. Every note and comment this app saves goes in that coach's own file,
   which is what lets a vault be shared without two machines touching one file. */
ipcMain.handle('store:author', (e, author) => { store.setAuthor(author); return true; });
/* Removes a session's notes for good. The renderer confirms first; this does not. */
ipcMain.handle('store:delete', (e, key) => store.delete(key));

/* where the notes actually are, and what the first run did with them */
ipcMain.handle('app:dataDir', () => ({
  dir: dataDir.dir, kind: dataDir.kind, migration: migration
}));
/* Read from package.json rather than app.getVersion(): that reports Electron's own
   version when main.js is launched as a script, which is how every test runs. */
const APP_VERSION = require('../package.json').version;
ipcMain.handle('app:version', () => APP_VERSION);

ipcMain.handle('app:reveal', (e, target) => {
  shell.openPath(target || dataDir.dir);
  return true;
});

/* ---------- vaults ---------- */
/* Counting sessions means opening the vault, so it is done here rather than asked of
   the renderer, which only ever sees keys. An unavailable vault reports nothing rather
   than failing: a Drive folder that has not synced yet is normal, not broken. */
function vaultRows(){
  return vaults.list().map((v) => {
    let sessions = 0;
    if (v.available){
      try {
        const s = store.storeFor(v.id);
        const lib = s ? JSON.parse(s.get('vnotes:index') || '[]') : [];
        sessions = Array.isArray(lib) ? lib.length : 0;
      } catch (e) { sessions = 0; }
    }
    return Object.assign({ sessions: sessions }, v);
  });
}

ipcMain.handle('vault:list', () => vaultRows());

/* folders, which are real directories in a vault */
ipcMain.handle('vault:folders', (e, id) => store.folders(id));
ipcMain.handle('folder:create', (e, id, rel) => store.createFolder(id, rel));
ipcMain.handle('folder:rename', (e, id, a, b) => store.renameFolder(id, a, b));
ipcMain.handle('folder:remove', (e, id, rel) => store.removeFolder(id, rel));

/* dragging a session into another vault moves its files between roots */
ipcMain.handle('session:toVault', (e, key, toVaultId, groupPath) =>
  store.moveSessionToVault(key, toVaultId, groupPath));

ipcMain.handle('vault:add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to keep notes in',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const added = vaults.add(r.filePaths[0]);
  return { vault: added.vault, added: added.added, list: vaultRows() };
});

ipcMain.handle('vault:rename', (e, id, name) => {
  vaults.rename(id, name);
  return vaultRows();
});

/* Forgets the vault. The folder is left exactly where it is - it holds someone's work,
   and removing a row from a list is not a request to delete it. */
ipcMain.handle('vault:remove', (e, id) => {
  const ok = vaults.remove(id);
  if (ok) store.forget(id);
  return { ok: ok, list: vaultRows() };
});

ipcMain.handle('vault:default', (e, id) => {
  vaults.setDefault(id);
  return vaultRows();
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
  /* The folder notes lived in before vaults existed becomes the first vault, in place. */
  dataDir = resolveDataDir(app);
  vaults = new Vaults(app.getPath('userData'), dataDir.dir);
  store = new VaultStore(vaults, path.join(app.getPath('userData'), 'prefs.json'));

  /* One-time move out of the old base64-blob store, into the first vault. It writes a
     backup first and never deletes the old copy: this is work that cannot be recreated. */
  try {
    migration = migrateIfNeeded(path.join(app.getPath('userData'), 'store'),
      store.storeFor(vaults.first().id),
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
  for (const v of vaults.list()){
    console.log('[vault] ' + v.name + '  ' + v.path +
                (v.available ? '' : '  (NOT FOUND)') + (v.isDefault ? '  [default]' : ''));
  }
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
