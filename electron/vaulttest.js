'use strict';
/*
 * Vaults, all live at once, driven in the real window.
 *
 *   npx electron electron/vaulttest.js
 *
 * Its own userData and its own vaults, so real notes are never touched. The second
 * vault is a plain temp folder standing in for one inside Google Drive - as far as the
 * app is concerned a shared vault is just a folder somebody else also writes to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-vaulttest-'));
app.setPath('userData', SANDBOX);

/* the second vault, and a third that already holds notes, to be adopted */
const DRIVE = path.join(SANDBOX, 'Drive', 'Squad 2026');
const ADOPT = path.join(SANDBOX, 'Handed over');
fs.mkdirSync(DRIVE, { recursive: true });
fs.mkdirSync(ADOPT, { recursive: true });

/* a folder that already looks like a vault, written the way FolderStore writes one */
fs.mkdirSync(path.join(ADOPT, 'Inherited session', 'drawings'), { recursive: true });
fs.writeFileSync(path.join(ADOPT, 'library.json'), JSON.stringify([
  { key: 'vnotes:inherited.mp4_9', kind: 'file', label: 'inherited.mp4',
    customName: 'Inherited session', noteCount: 2, lastOpened: Date.now() }
]));
fs.writeFileSync(path.join(ADOPT, 'paths.json'), JSON.stringify({
  'vnotes:inherited.mp4_9': 'Inherited session'
}));
fs.writeFileSync(path.join(ADOPT, 'Inherited session', 'session.json'), JSON.stringify({
  key: 'vnotes:inherited.mp4_9',
  saved: new Date().toISOString(),
  notes: [{ id: 'i1', time: 1, text: 'from the other coach' },
          { id: 'i2', time: 2, text: 'and another' }]
}));

/* the picker cannot be clicked from a test, so answer it */
let nextFolder = null;
const { dialog } = require('electron');
const realOpen = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = async (win, opts) => {
  if (opts && opts.properties && opts.properties.indexOf('openDirectory') >= 0){
    return nextFolder ? { canceled: false, filePaths: [nextFolder] } : { canceled: true, filePaths: [] };
  }
  return realOpen(win, opts);
};

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

/* Each coach keeps their own index, named for them, so a vault has one or more
   library.<author>.json rather than a single file with a fixed name. */
function libraryFiles(root){
  try { return fs.readdirSync(root).filter((n) => /^library\..+\.json$/.test(n)); }
  catch (e) { return []; }
}
function readLibrary(root){
  const out = [];
  for (const name of libraryFiles(root)){
    try {
      const list = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
      if (Array.isArray(list)) for (const e of list) out.push(e);
    } catch (e) {}
  }
  return out;
}

function addVault(win, dir){
  nextFolder = dir;
  return run(win, `window.desktop.vaultAdd()`).then((r) => { nextFolder = null; return r; });
}

app.whenReady().then(() => {
  const poll = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(poll);

    try {
      await wait(1500);
      await run(win, `window.storage.set('vnotes:prefs', JSON.stringify({ userName: 'Carel' }))`);
      await wait(400);

      /* ---------- 1. the first run registers what was already there ---------- */
      let list = await run(win, `window.desktop.vaults()`);
      check('the existing notes folder becomes the first vault',
            list.length === 1 && list[0].isDefault && list[0].available, JSON.stringify(list));

      /* a session in it, through the app's own key building */
      await run(win, `(async function(){
        await window.storage.set('vnotes:index', JSON.stringify([
          { key: 'vnotes:home.mp4_1', kind: 'file', label: 'home.mp4',
            customName: 'At home', noteCount: 1, lastOpened: Date.now() }
        ]));
        await window.storage.set('vnotes:home.mp4_1', JSON.stringify(
          [{ id: 'h1', time: 1, text: 'my own note' }]));
      })()`);
      await wait(500);
      await run(win, `location.reload()`);
      await wait(2500);

      /* ---------- 2. a second vault, and both are live ---------- */
      const added = await addVault(win, DRIVE);
      check('a folder can be added as a vault', added && added.added,
            JSON.stringify(added && added.vault));
      await run(win, `location.reload()`);
      await wait(2500);

      list = await run(win, `window.desktop.vaults()`);
      check('both vaults are listed, and only one is the default',
            list.length === 2 && list.filter(function(v){ return v.isDefault; }).length === 1,
            JSON.stringify(list.map((v) => v.name + (v.isDefault ? '*' : ''))));

      /* put a session in the second vault by making it the default first */
      await run(win, `window.desktop.vaultDefault(${JSON.stringify(added.vault.id)})`);
      await run(win, `location.reload()`);
      await wait(2500);
      await run(win, `(async function(){
        document.getElementById('new-session-btn').click();
        document.getElementById('segment-url').value = 'https://youtu.be/dQw4w9WgXcQ';
        document.getElementById('segment-name').value = 'Squad video';
        document.getElementById('segment-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(2500);

      const keyed = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).map(function(e){
          return { key: e.key, vault: e.vault, name: e.customName || e.label };
        });
      })()`);
      const squad = keyed.filter((e) => e.name === 'Squad video')[0];
      check('a new session goes into the default vault',
            squad && squad.vault === added.vault.id, JSON.stringify(keyed));
      check('its key names the vault it is in',
            squad && squad.key.indexOf('vault:' + added.vault.id + '|') === 0,
            squad && squad.key);
      check('sessions from every vault are listed together',
            keyed.length === 2 && keyed.some((e) => e.name === 'At home'),
            JSON.stringify(keyed.map((e) => e.name)));

      /* it landed in the right folder on disk, and not in the other one */
      check('the second vault has its own library on disk',
            libraryFiles(DRIVE).length > 0, DRIVE);
      const firstLib = readLibrary(path.join(SANDBOX, 'Notes'));
      check('the first vault was not touched by it',
            firstLib.length === 1 && firstLib[0].key === 'vnotes:home.mp4_1',
            JSON.stringify(firstLib.map((e) => e.key)));
      check('keys are stored unprefixed on disk, so another build still reads them',
            firstLib[0].key.indexOf('vault:') < 0, firstLib[0].key);

      /* ---------- 3. the same video in two vaults stays two sessions ---------- */
      await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        var lib = JSON.parse(v.value);
        lib.push({ key: 'vault:' + ${JSON.stringify(added.vault.id)} + '|vnotes:home.mp4_1',
                   vault: ${JSON.stringify(added.vault.id)}, kind: 'file', label: 'home.mp4',
                   customName: 'Same video, squad copy', noteCount: 1, lastOpened: Date.now() });
        await window.storage.set('vnotes:index', JSON.stringify(lib));
        await window.storage.set('vault:' + ${JSON.stringify(added.vault.id)} + '|vnotes:home.mp4_1',
          JSON.stringify([{ id: 's1', time: 5, text: 'the squad copy' }]));
      })()`);
      await wait(700);
      const both = await run(win, `(async function(){
        var mine = await window.storage.get('vnotes:home.mp4_1');
        var theirs = await window.storage.get('vault:' + ${JSON.stringify(added.vault.id)} + '|vnotes:home.mp4_1');
        return { mine: JSON.parse(mine.value), theirs: JSON.parse(theirs.value) };
      })()`);
      check('the same video in two vaults keeps two separate sets of notes',
            both.mine.length === 1 && both.mine[0].text === 'my own note' &&
            both.theirs.length === 1 && both.theirs[0].text === 'the squad copy',
            JSON.stringify(both));

      /* ---------- 4. adopting a folder that already holds notes ---------- */
      const adopted = await addVault(win, ADOPT);
      check('a folder that already has notes can be added', adopted && adopted.added,
            JSON.stringify(adopted && adopted.vault));
      await run(win, `location.reload()`);
      await wait(2500);
      const withAdopted = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).map(function(e){ return e.customName || e.label; });
      })()`);
      check('its sessions appear without importing anything',
            withAdopted.indexOf('Inherited session') >= 0, JSON.stringify(withAdopted));

      const inherited = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        var e = JSON.parse(v.value).filter(function(x){
          return (x.customName || x.label) === 'Inherited session'; })[0];
        var notes = await window.storage.get(e.key);
        return JSON.parse(notes.value).length;
      })()`);
      check('and its notes read straight out of the folder', inherited === 2, String(inherited));

      /* ---------- 5. renaming, and forgetting without deleting ---------- */
      /* Through the pencil, not the API behind it: calling vaultRename directly would
         have gone on passing while the button did nothing, which is exactly what
         happened when window.prompt turned out to throw in Electron. */
      await run(win, `document.getElementById('settings-btn').click()`);
      await wait(600);
      await run(win, `(function(){
        var rows = [].slice.call(document.querySelectorAll('#vault-list .vault-row'));
        var row = rows.filter(function(r){
          return r.querySelector('.vault-name').textContent === 'Handed over'; })[0];
        row.querySelectorAll('button')[row.querySelectorAll('button').length - 2].click();
      })()`);
      await wait(500);
      const asked = await run(win, `document.getElementById('ask-modal').classList.contains('open')`);
      check('renaming a vault asks for the name in the app', asked, String(asked));
      await run(win, `(function(){
        document.getElementById('ask-input').value = 'From Marius';
        document.getElementById('ask-form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(900);
      await run(win, `document.getElementById('settings-close').click()`);
      await wait(300);

      list = await run(win, `window.desktop.vaults()`);
      check('a vault can be renamed',
            list.some((v) => v.name === 'From Marius'), JSON.stringify(list.map((v) => v.name)));

      const removed = await run(win, `window.desktop.vaultRemove(${JSON.stringify(adopted.vault.id)})`);
      check('a vault can be forgotten', removed.ok && removed.list.length === 2,
            JSON.stringify(removed.list.map((v) => v.name)));
      check('forgetting it leaves the folder and every note exactly where they were',
            fs.existsSync(path.join(ADOPT, 'Inherited session', 'session.json')) &&
            JSON.parse(fs.readFileSync(path.join(ADOPT, 'Inherited session', 'session.json'),
                       'utf8')).notes.length === 2, ADOPT);

      await run(win, `location.reload()`);
      await wait(2500);
      const afterRemove = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).map(function(e){ return e.customName || e.label; });
      })()`);
      check('its sessions stop being listed once it is forgotten',
            afterRemove.indexOf('Inherited session') < 0, JSON.stringify(afterRemove));

      /* ---------- 6. a vault whose folder has gone ---------- */
      fs.renameSync(DRIVE, DRIVE + ' (unplugged)');
      await run(win, `location.reload()`);
      await wait(2500);
      list = await run(win, `window.desktop.vaults()`);
      const missing = list.filter((v) => !v.available)[0];
      check('a vault whose folder is gone is reported, not invented',
            !!missing && !fs.existsSync(DRIVE), JSON.stringify(list.map((v) => v.name + ':' + v.available)));

      const survived = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).map(function(e){ return e.customName || e.label; });
      })()`);
      check('the other vault carries on regardless',
            survived.indexOf('At home') >= 0, JSON.stringify(survived));

      const stillThere = await run(win, `(async function(){
        var n = await window.storage.get('vnotes:home.mp4_1');
        return JSON.parse(n.value).length;
      })()`);
      check('and its notes are still readable', stillThere === 1, String(stillThere));

      /* the missing vault must not have been emptied by the app writing an index */
      fs.renameSync(DRIVE + ' (unplugged)', DRIVE);
      const squadLib = readLibrary(DRIVE);
      check('a vault that was offline was not emptied while it was away',
            squadLib.length >= 1, JSON.stringify(squadLib.map((e) => e.key)));

      /* ---------- 7. the settings section ---------- */
      await run(win, `document.getElementById('settings-btn').click()`);
      await wait(700);
      const ui = await run(win, `({
        rows: document.querySelectorAll('#vault-list .vault-row').length,
        names: [].slice.call(document.querySelectorAll('#vault-list .vault-name'))
                 .map(function(e){ return e.textContent; }),
        addBtn: !!document.getElementById('vault-add'),
        defaults: document.querySelectorAll('#vault-list .vault-row.is-default').length
      })`);
      check('settings lists the vaults with a way to add one',
            ui.rows === 2 && ui.addBtn && ui.defaults === 1, JSON.stringify(ui));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nvault checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
