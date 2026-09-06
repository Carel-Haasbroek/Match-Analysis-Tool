'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/*
 * window.storage is deliberately the shape app.js already probes for, so the
 * renderer's storage layer needs no Electron-specific branch: values are JSON
 * strings, get() resolves to { value } or null.
 */
contextBridge.exposeInMainWorld('storage', {
  get: (key) => ipcRenderer.invoke('store:get', key)
    .then((value) => (value == null ? null : { value })),
  set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  keys: () => ipcRenderer.invoke('store:keys'),
  setAuthor: (author) => ipcRenderer.invoke('store:author', author),
  remove: (key) => ipcRenderer.invoke('store:delete', key)
});

/* Everything the browser cannot do. Its presence is how app.js detects desktop. */
contextBridge.exposeInMainWorld('desktop', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  /* Electron 32 removed File.path, so a dropped video has no path the page can see.
     This is the sanctioned replacement, and it has to live here: webUtils is not
     available to the page itself. */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; }
  },
  statVideo: (filePath) => ipcRenderer.invoke('video:stat', filePath),
  dataDir: () => ipcRenderer.invoke('app:dataDir'),
  version: () => ipcRenderer.invoke('app:version'),
  reveal: (target) => ipcRenderer.invoke('app:reveal', target),
  moveSession: (key, groupPath) => ipcRenderer.invoke('session:move', key, groupPath),

  /* vaults: named root folders, all live at once */
  vaults: () => ipcRenderer.invoke('vault:list'),
  vaultAdd: () => ipcRenderer.invoke('vault:add'),
  vaultRename: (id, name) => ipcRenderer.invoke('vault:rename', id, name),
  vaultRemove: (id) => ipcRenderer.invoke('vault:remove', id),
  vaultDefault: (id) => ipcRenderer.invoke('vault:default', id),

  /* folders, and moving a session into another vault */
  folders: (id) => ipcRenderer.invoke('vault:folders', id),
  folderCreate: (id, rel) => ipcRenderer.invoke('folder:create', id, rel),
  folderRename: (id, a, b) => ipcRenderer.invoke('folder:rename', id, a, b),
  folderRemove: (id, rel) => ipcRenderer.invoke('folder:remove', id, rel),
  moveToVault: (key, toVaultId, groupPath) =>
    ipcRenderer.invoke('session:toVault', key, toVaultId, groupPath)
});
