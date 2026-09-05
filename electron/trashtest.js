'use strict';
/*
 * Deleting a note and putting it back, driven in the real window.
 *
 *   npx electron electron/trashtest.js
 *
 * Its own userData and its own vault, so real notes are never touched.
 *
 * The check that matters is the reload. A restore that only puts the note back on screen
 * looks identical to one that works, right up until the next time the session is opened
 * and the tombstone filters it out again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-trashtest-'));
app.setPath('userData', SANDBOX);

const VIDEO = path.join(SANDBOX, 'tiny.mp4');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'tiny.mp4'), VIDEO);
const SIZE = fs.statSync(VIDEO).size;
const KEY = 'vnotes:tiny.mp4_' + SIZE;

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

const NOTES = [
  { id: 'keep-1', time: 1, text: 'the one that stays', author: 'Carel',
    comments: [{ id: 'k1', author: 'Carel', text: 'the one that stays', at: 1 }] },
  { id: 'gone-1', time: 2, text: 'the one that goes', author: 'Carel',
    comments: [{ id: 'g1', author: 'Carel', text: 'the one that goes', at: 2 },
               { id: 'g2', author: 'Marius', text: 'and my reply to it', at: 3 }] }
];

/* open the seeded session from the home screen */
async function openSession(win){
  await run(win, `document.querySelectorAll('.recent-row .recent-label')[0].click()`);
  await wait(3000);
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
      await run(win, `(async function(){
        await window.storage.set('vnotes:prefs', JSON.stringify({ userName: 'Carel' }));
        await window.storage.set('vnotes:index', JSON.stringify([{
          key: ${JSON.stringify(KEY)}, kind:'file', label:'tiny.mp4', customName:'A session',
          fileName:'tiny.mp4', fileSize:${SIZE}, filePath:${JSON.stringify(VIDEO)},
          noteCount:2, lastOpened: Date.now()
        }]));
        await window.storage.set(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(NOTES))});
      })()`);
      await wait(600);
      await run(win, `location.reload()`);
      await wait(2500);
      await openSession(win);

      const start = await run(win, `({
        notes: document.querySelectorAll('.note-item').length,
        trashShown: !document.getElementById('trash-btn').classList.contains('hidden')
      })`);
      check('the session opens with its notes', start.notes === 2, JSON.stringify(start));
      check('nothing offers a restore when nothing has been deleted',
            !start.trashShown, JSON.stringify(start));

      /* ---------- delete one ---------- */
      await run(win, `window.confirm = function(){ return true; };
        (function(){
          var rows = [].slice.call(document.querySelectorAll('.note-item'));
          var row = rows.filter(function(r){
            return r.textContent.indexOf('the one that goes') >= 0; })[0];
          row.querySelector('.note-del').click();
        })()`);
      await wait(1200);

      const deleted = await run(win, `({
        notes: document.querySelectorAll('.note-item').length,
        trashLine: document.getElementById('trash-btn').textContent,
        shown: !document.getElementById('trash-btn').classList.contains('hidden')
      })`);
      check('deleting takes the note out of the session', deleted.notes === 1,
            JSON.stringify(deleted));
      check('and offers it back, with a count',
            deleted.shown && /Recently deleted \(1\)/.test(deleted.trashLine),
            deleted.trashLine);

      /* ---------- the list ---------- */
      await run(win, `document.getElementById('trash-btn').click()`);
      await wait(600);
      const listed = await run(win, `({
        open: document.getElementById('trash-modal').classList.contains('open'),
        rows: document.querySelectorAll('#trash-list .trash-row').length,
        text: (document.querySelector('#trash-list .trash-text') || {}).textContent,
        time: (document.querySelector('#trash-list .trash-time') || {}).textContent
      })`);
      check('the deleted note is listed', listed.open && listed.rows === 1,
            JSON.stringify(listed));
      check('with its comments and its moment, so it can be told apart',
            /the one that goes/.test(listed.text) && /and my reply/.test(listed.text) &&
            listed.time === '0:02', JSON.stringify(listed));

      /* ---------- restore ---------- */
      await run(win, `document.querySelector('#trash-list .trash-row button').click()`);
      await wait(1200);
      const restored = await run(win, `({
        notes: document.querySelectorAll('.note-item').length,
        rows: document.querySelectorAll('#trash-list .trash-row').length,
        trashShown: !document.getElementById('trash-btn').classList.contains('hidden')
      })`);
      check('restoring puts the note back', restored.notes === 2, JSON.stringify(restored));
      check('and takes it off the deleted list',
            restored.rows === 0 && !restored.trashShown, JSON.stringify(restored));

      await run(win, `document.getElementById('trash-close').click()`);
      await wait(300);

      /* ---------- the check that matters ---------- */
      await run(win, `location.reload()`);
      await wait(2500);
      await openSession(win);
      const afterReload = await run(win, `({
        notes: document.querySelectorAll('.note-item').length,
        texts: [].slice.call(document.querySelectorAll('.note-item .cmt-text'))
                 .map(function(e){ return e.textContent; })
      })`);
      check('the restored note is still there after a reload',
            afterReload.notes === 2 &&
            afterReload.texts.some(function(t){ return t === 'the one that goes'; }),
            JSON.stringify(afterReload));
      check('and its whole thread came back with it',
            afterReload.texts.some(function(t){ return t === 'and my reply to it'; }),
            JSON.stringify(afterReload.texts));

      /* the tombstone must be gone, not merely ignored */
      const onDisk = await run(win, `window.desktop.dataDir()`);
      const sessionDir = path.join(onDisk.dir, 'A session');
      const tombs = fs.existsSync(sessionDir)
        ? fs.readdirSync(sessionDir).filter((n) => /^deleted\..+\.json$/.test(n))
        : [];
      check('the tombstone is cleared rather than left to be filtered around',
            tombs.every((t) => {
              const ids = JSON.parse(fs.readFileSync(path.join(sessionDir, t), 'utf8'));
              return !ids.includes('gone-1');
            }), tombs.join(', '));

      /* ---------- deleting again still works ---------- */
      await run(win, `window.confirm = function(){ return true; };
        (function(){
          var rows = [].slice.call(document.querySelectorAll('.note-item'));
          var row = rows.filter(function(r){
            return r.textContent.indexOf('the one that goes') >= 0; })[0];
          row.querySelector('.note-del').click();
        })()`);
      await wait(1200);
      await run(win, `location.reload()`);
      await wait(2500);
      await openSession(win);
      const goneAgain = await run(win, `({
        notes: document.querySelectorAll('.note-item').length,
        trashLine: document.getElementById('trash-btn').textContent
      })`);
      check('a note deleted a second time stays deleted',
            goneAgain.notes === 1, JSON.stringify(goneAgain));
      check('and is offered back again', /Recently deleted \(1\)/.test(goneAgain.trashLine),
            goneAgain.trashLine);

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\ntrash checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
