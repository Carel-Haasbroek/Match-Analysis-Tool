'use strict';
/*
 * Dragging a session into a folder, in the shape a real install has.
 *
 *   npx electron electron/dragtest.js
 *
 * This exists because of a bug nothing else could have caught. Only the folder's own
 * one-line header accepted a drop, so letting go anywhere over the sessions inside the
 * folder - most of what a folder looks like on screen - did nothing at all.
 *
 * And it was worse than nothing with more than one vault. A second vault makes the tree
 * grow a row for the vault itself, sitting directly above its folders and accepting
 * drops with "no folder" as the target, so a miss of one row upwards quietly took the
 * session OUT of its folder. Five sessions were un-filed that way in a real vault.
 *
 * Every other suite runs with a single vault, which is exactly why they all passed.
 * This one seeds vaults.json before the app boots, so the vault row is there.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-dragtest-'));
app.setPath('userData', SANDBOX);

const NOTES = path.join(SANDBOX, 'Notes');
const SECOND = path.join(SANDBOX, 'Second vault');
fs.mkdirSync(NOTES, { recursive: true });
fs.mkdirSync(SECOND, { recursive: true });

/* two vaults, before anything reads the file - this is the shape being tested */
fs.writeFileSync(path.join(SANDBOX, 'vaults.json'), JSON.stringify({
  default: 'v1',
  vaults: [
    { id: 'v1', name: 'My notes', path: NOTES },
    { id: 'v2', name: 'Second vault', path: SECOND }
  ]
}, null, 2));

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

const LIB = [
  { key: 'vnotes:loose.mp4_1', kind: 'file', label: 'loose.mp4', customName: 'Loose one',
    noteCount: 1, lastOpened: Date.now() },
  { key: 'vnotes:filed.mp4_2', kind: 'file', label: 'filed.mp4', customName: 'Already filed',
    noteCount: 1, folder: 'Comp 2026', lastOpened: Date.now() - 1000 }
];

/* the browser's own sequence: set the payload on dragstart, read it back on drop */
function dragCode(rowMatch, targetPick){
  return `(function(){
    var rows = [].slice.call(document.querySelectorAll('#sessions-tree .recent-row'));
    var row = rows.filter(function(r){ return /${rowMatch}/.test(r.textContent); })[0];
    var target = ${targetPick};
    if (!row || !target) return { fail: 'row ' + !!row + ' target ' + !!target };
    var dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    var over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    return { carried: dt.getData('text/plain'), effect: over.dataTransfer.dropEffect };
  })()`;
}

const folderOf = (win, name) => run(win, `(async function(){
  var v = await window.storage.get('vnotes:index');
  var e = JSON.parse(v.value).filter(function(x){ return x.customName === ${JSON.stringify(name)}; })[0];
  return e ? (e.folder || '') : 'NOT IN THE LIBRARY';
})()`);

app.whenReady().then(() => {
  const poll = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(poll);

    try {
      await wait(1500);
      await run(win, `(async function(){
        await window.storage.set('vnotes:prefs', JSON.stringify({ userName: 'Carel' }));
        await window.storage.set('vnotes:index', ${JSON.stringify(JSON.stringify(LIB))});
        await window.storage.set('vnotes:loose.mp4_1', JSON.stringify([{ id:'a', time:1, text:'x' }]));
        await window.storage.set('vnotes:filed.mp4_2', JSON.stringify([{ id:'b', time:1, text:'y' }]));
      })()`);
      await run(win, `location.reload()`);
      await wait(2800);

      await run(win, `document.getElementById('sessions-btn').click()`);
      await wait(800);

      const shape = await run(win, `(function(){
        return {
          vaultRows: document.querySelectorAll('#sessions-tree .tree-folder.vault-root').length,
          folders: [].slice.call(document.querySelectorAll('#sessions-tree .tree-folder'))
            .map(function(f){ return (f.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24); })
        };
      })()`);
      check('with two vaults the tree draws a row for the vault itself',
            shape.vaultRows >= 1, JSON.stringify(shape));

      /* the bug: letting go over the sessions inside a folder, not its header line */
      const onRow = await run(win, dragCode('Loose one',
        `[].slice.call(document.querySelectorAll('#sessions-tree .recent-row'))
           .filter(function(r){ return /Already filed/.test(r.textContent); })[0]`));
      await wait(1200);
      const landed = await folderOf(win, 'Loose one');
      check('dropping onto a session inside a folder files it into that folder',
            landed === 'Comp 2026', JSON.stringify(onRow) + ' -> folder ' + JSON.stringify(landed));

      /* and the folder's own header still works, which is what used to be the only way */
      await run(win, `document.getElementById('sessions-btn').click()`);
      await wait(600);
      await run(win, dragCode('Loose one',
        `[].slice.call(document.querySelectorAll('#sessions-tree .tree-folder'))
           .filter(function(f){ return /My notes/.test(f.textContent); })[0]`));
      await wait(1200);
      const outAgain = await folderOf(win, 'Loose one');
      check('dropping onto the vault row takes it out of the folder, as it says',
            outAgain === '', JSON.stringify(outAgain));

      await run(win, dragCode('Loose one',
        `[].slice.call(document.querySelectorAll('#sessions-tree .tree-folder'))
           .filter(function(f){ return /Comp 2026/.test(f.textContent); })[0]`));
      await wait(1200);
      const backIn = await folderOf(win, 'Loose one');
      check('and the folder header still files it', backIn === 'Comp 2026', JSON.stringify(backIn));

      /* dropping a session where it already is must not be offered as a move */
      const inert = await run(win, dragCode('Loose one',
        `[].slice.call(document.querySelectorAll('#sessions-tree .recent-row'))
           .filter(function(r){ return /Already filed/.test(r.textContent); })[0]`));
      check('dropping it where it already is is refused rather than highlighted',
            inert.effect === 'none', JSON.stringify(inert));

      const onDisk = fs.existsSync(path.join(NOTES, 'Comp 2026', 'Loose one'));
      check('and the folder on disk matches what the app shows', onDisk,
            JSON.stringify(fs.readdirSync(path.join(NOTES, 'Comp 2026'))));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '\n        ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\ndrag checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
