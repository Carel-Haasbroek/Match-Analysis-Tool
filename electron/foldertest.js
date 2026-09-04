'use strict';
/*
 * Grouping, driven in the real window: does putting a session in a folder in the
 * app actually move its folder on disk, and does it survive a restart?
 *
 *   npx electron electron/foldertest.js
 *
 * Uses its own userData and its own Notes folder, so real notes are never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-foldertest-'));
app.setPath('userData', SANDBOX);
/* resolveDataDir prefers this when the app is not packaged */
process.env.PORTABLE_EXECUTABLE_DIR = SANDBOX;

require('./main.js');

const NOTES = path.join(SANDBOX, 'Notes');
const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function run(win, code){ return win.webContents.executeJavaScript(code); }

function dirsUnder(root){
  const out = [];
  (function walk(d, rel){
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries){
      if (!e.isDirectory() || e.name === 'drawings' || e.name === 'other') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      out.push(r);
      walk(path.join(d, e.name), r);
    }
  })(root, '');
  return out.sort();
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

      /* seed three sessions straight through the storage bridge */
      await run(win, `(async function(){
        var lib = [
          { key:'vnotes:a.mp4_1', kind:'file', label:'a.mp4', customName:'Jack round 1', noteCount:1, lastOpened:Date.now() },
          { key:'vnotes:b.mp4_2', kind:'file', label:'b.mp4', customName:'Jack round 2', noteCount:1, lastOpened:Date.now()-1000 },
          { key:'vnotes:c.mp4_3', kind:'file', label:'c.mp4', customName:'Training drill', noteCount:1, lastOpened:Date.now()-2000 }
        ];
        await window.storage.set('vnotes:index', JSON.stringify(lib));
        for (var i = 0; i < lib.length; i++){
          await window.storage.set(lib[i].key, JSON.stringify(
            [{ id:'n'+i, time:i+1, text:'note '+i }]));
        }
      })()`);
      await wait(600);
      await run(win, `location.reload()`);
      await wait(2500);

      const listed = await run(win, `({
        rows: document.querySelectorAll('.recent-row').length,
        selects: document.querySelectorAll('.recent-folder').length,
        folderShown: !document.getElementById('notes-folder').classList.contains('hidden'),
        folderText: document.getElementById('notes-folder').textContent
      })`);
      check('sessions listed with a folder chooser each',
            listed.rows === 3 && listed.selects === 3, JSON.stringify(listed));
      check('the notes folder path is shown', listed.folderShown &&
            listed.folderText.indexOf('Notes') >= 0, listed.folderText);

      /* put two of them in folders, one nested */
      await run(win, `(function(){
        var rows = [].slice.call(document.querySelectorAll('.recent-row'));
        function byName(n){ return rows.filter(function(r){
          return r.querySelector('.recent-label').textContent === n; })[0]; }
        var r1 = byName('Jack round 1');
        var s1 = r1.querySelector('.recent-folder');
        var o = document.createElement('option'); o.value='Competition 2026'; s1.appendChild(o);
        s1.value = 'Competition 2026';
        s1.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(1200);
      await run(win, `(function(){
        var rows = [].slice.call(document.querySelectorAll('.recent-row'));
        function byName(n){ return rows.filter(function(r){
          return r.querySelector('.recent-label').textContent === n; })[0]; }
        var s2 = byName('Jack round 2').querySelector('.recent-folder');
        var o = document.createElement('option'); o.value='Competition 2026/Nationals'; s2.appendChild(o);
        s2.value = 'Competition 2026/Nationals';
        s2.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(1500);

      const grouped = await run(win, `({
        headers: [].slice.call(document.querySelectorAll('.recent-group'))
                   .map(function(h){ return h.firstChild.textContent; }),
        rows: document.querySelectorAll('.recent-row').length
      })`);
      check('the list groups under folder headings',
            grouped.headers.indexOf('Competition 2026') >= 0 &&
            grouped.headers.indexOf('Competition 2026/Nationals') >= 0 &&
            grouped.headers.indexOf('Not in a folder') >= 0, JSON.stringify(grouped));
      check('no session is lost when grouped', grouped.rows === 3, String(grouped.rows));

      /* the actual point: the app's folders are the folders on disk */
      const dirs = dirsUnder(NOTES);
      check('the group exists as a real directory',
            dirs.indexOf('Competition 2026') >= 0, dirs.join(' | '));
      check('the session moved inside it',
            dirs.indexOf('Competition 2026/Jack round 1') >= 0, dirs.join(' | '));
      check('nesting works on disk',
            dirs.indexOf('Competition 2026/Nationals/Jack round 2') >= 0, dirs.join(' | '));
      check('the ungrouped session stayed at the top level',
            dirs.indexOf('Training drill') >= 0, dirs.join(' | '));
      check('its notes moved with it',
            fs.existsSync(path.join(NOTES, 'Competition 2026', 'Jack round 1', 'session.json')));

      /* and it all survives a restart */
      await run(win, `location.reload()`);
      await wait(2500);
      const after = await run(win, `({
        headers: [].slice.call(document.querySelectorAll('.recent-group'))
                   .map(function(h){ return h.firstChild.textContent; }),
        rows: document.querySelectorAll('.recent-row').length
      })`);
      check('grouping survives a restart',
            after.headers.indexOf('Competition 2026/Nationals') >= 0 && after.rows === 3,
            JSON.stringify(after));

      /* moving one back out again */
      await run(win, `(function(){
        var rows = [].slice.call(document.querySelectorAll('.recent-row'));
        function byName(n){ return rows.filter(function(r){
          return r.querySelector('.recent-label').textContent === n; })[0]; }
        var s = byName('Jack round 1').querySelector('.recent-folder');
        s.value = '';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(1500);
      const out = dirsUnder(NOTES);
      check('a session can be moved back out of a folder',
            out.indexOf('Jack round 1') >= 0, out.join(' | '));
      const stillReadable = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:a.mp4_1');
        return v ? JSON.parse(v.value).length : 0;
      })()`);
      check('its notes are still readable after moving back', stillReadable === 1,
            String(stillReadable));

    } catch (err) {
      check('test ran without throwing', false, String(err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name + (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nfolder checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 120000);
});
