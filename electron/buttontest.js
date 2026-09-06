'use strict';
/*
 * Click every button in the app and see whether anything throws.
 *
 *   npx electron electron/buttontest.js
 *
 * This exists because of a bug that shipped: window.prompt is not implemented in
 * Electron - it throws - so New folder, both folder renames and the vault rename all did
 * nothing at all, silently. Every one of them had a test, and every test passed, because
 * the tests stubbed prompt and so exercised the stub rather than the app.
 *
 * A handler that throws takes the rest of itself with it and says nothing on screen, so
 * the only reliable signal is the error itself. Native dialogs are answered rather than
 * stubbed away: showOpenDialog is cancelled and confirm returns false, which is enough to
 * run each handler up to the point where it asks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-buttontest-'));
app.setPath('userData', SANDBOX);

const SECOND = path.join(SANDBOX, 'Second vault');
fs.mkdirSync(SECOND, { recursive: true });

/* every picker cancels, so nothing blocks on a dialog nobody can click */
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

const LIB = [
  { key: 'vnotes:one.mp4_1', kind: 'file', label: 'one.mp4', customName: 'A session',
    noteCount: 2, folder: 'A folder', lastOpened: Date.now() },
  { key: 'vnotes:two.mp4_2', kind: 'youtube', label: 'A link', videoId: 'dQw4w9WgXcQ',
    noteCount: 1, lastOpened: Date.now() - 1000 }
];

/* Each surface: how to open it, and which buttons live there. */
const SURFACES = [
  { name: 'home', open: `document.getElementById('recent-btn').click()` },
  { name: 'All sessions', open: `document.getElementById('sessions-btn').click()` },
  { name: 'Preferences', open: `document.getElementById('settings-btn').click()` },
  { name: 'Help', open: `document.getElementById('settings-btn').click();
                         document.getElementById('help-btn').click()` },
  { name: 'New session', open: `document.getElementById('new-session-btn').click()` }
];

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
        await window.storage.set('vnotes:one.mp4_1', JSON.stringify(
          [{ id: 'x1', time: 1, text: 'a note', author: 'Carel',
             comments: [{ id: 'c1', author: 'Carel', text: 'a note', at: 1 }] }]));
      })()`);
      await wait(500);
      await run(win, `window.desktop.vaultAdd()`);          /* cancels; harmless */
      await run(win, `location.reload()`);
      await wait(2600);

      /* catch what a thrown handler leaves behind */
      await run(win, `(function(){
        window.__errs = [];
        window.addEventListener('error', function(e){
          window.__errs.push(String((e.error && e.error.message) || e.message));
        });
        window.addEventListener('unhandledrejection', function(e){
          window.__errs.push('unhandled rejection: ' + String((e.reason && e.reason.message) || e.reason));
        });
        /* answering rather than removing: the handler still runs up to the question */
        window.confirm = function(){ return false; };
      })()`);

      let clicked = 0;
      const broken = [];

      for (const surface of SURFACES){
        const ids = await run(win, `(function(){
          ${surface.open};
          return [].slice.call(document.querySelectorAll('button'))
            .filter(function(b){
              return b.id && b.offsetParent !== null && !b.disabled;
            })
            .map(function(b){ return b.id; });
        })()`);
        await wait(500);

        for (const id of ids){
          /* reopen first: the previous click may have closed the surface */
          const outcome = await run(win, `(async function(){
            ${surface.open};
            await new Promise(function(r){ setTimeout(r, 120); });
            var before = window.__errs.length;
            var el = document.getElementById(${JSON.stringify(id)});
            if (!el || el.offsetParent === null) return { skipped: true };
            try { el.click(); } catch (e) { window.__errs.push(String(e && e.message || e)); }
            await new Promise(function(r){ setTimeout(r, 260); });
            var fresh = window.__errs.slice(before);
            /* leave nothing open for the next one */
            ['ask-modal','trash-modal','help-modal','settings-modal','sessions-modal',
             'new-session-modal','summary-modal','lightbox','name-modal'].forEach(function(m){
              var el2 = document.getElementById(m);
              if (el2) el2.classList.remove('open');
            });
            return { errs: fresh };
          })()`);
          if (outcome.skipped) continue;
          clicked++;
          if (outcome.errs && outcome.errs.length){
            broken.push(surface.name + ' #' + id + ': ' + outcome.errs.join(' | '));
          }
        }
      }

      check('every button on every surface was clicked', clicked >= 25, String(clicked));
      check('no button throws when clicked', broken.length === 0, broken.join('\n        '));

      /* the groups wired by class rather than by id */
      await run(win, `document.getElementById('settings-btn').click()`);
      await wait(400);
      const themes = await run(win, `(async function(){
        var before = window.__errs.length;
        var chips = [].slice.call(document.querySelectorAll('#theme-row .theme-chip'));
        chips.forEach(function(c){ c.click(); });
        await new Promise(function(r){ setTimeout(r, 300); });
        var was = document.documentElement.getAttribute('data-theme');
        chips[0].click();
        return { count: chips.length, errs: window.__errs.slice(before), applied: !!was };
      })()`);
      check('every theme chip applies without throwing',
            themes.count === 8 && !themes.errs.length && themes.applied,
            JSON.stringify(themes));

      await run(win, `document.getElementById('settings-close').click()`);
      await wait(300);

      /* the drawing toolbar and the panel tabs, which have no ids either */
      const groups = await run(win, `(async function(){
        var before = window.__errs.length;
        [].slice.call(document.querySelectorAll('.panel-tab')).forEach(function(t){ t.click(); });
        [].slice.call(document.querySelectorAll('.tool-btn, .size-btn, .swatch'))
          .forEach(function(b){ b.click(); });
        await new Promise(function(r){ setTimeout(r, 300); });
        return { errs: window.__errs.slice(before),
                 tabs: document.querySelectorAll('.panel-tab').length,
                 tools: document.querySelectorAll('.tool-btn, .size-btn, .swatch').length };
      })()`);
      check('the tabs and the drawing toolbar do not throw either',
            !groups.errs.length && groups.tabs >= 2 && groups.tools >= 10,
            JSON.stringify(groups));

      /* and the one that started this: a text prompt has to actually appear */
      await run(win, `document.getElementById('sessions-btn').click()`);
      await wait(400);
      await run(win, `document.getElementById('new-folder-btn').click()`);
      await wait(400);
      const asked = await run(win, `document.getElementById('ask-modal').classList.contains('open')`);
      check("asking for a name opens the app's own prompt, not the browser's",
            asked, String(asked));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '\n        ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nbutton checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 240000);
});
