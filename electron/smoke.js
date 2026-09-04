'use strict';
/*
 * Launches the real app, asserts the window actually loaded and that the renderer
 * can see both bridges, then quits. Run with:
 *
 *   npx electron electron/smoke.js
 *
 * This is not a substitute for using the app; it catches the failures that would
 * otherwise only show up as a blank window.
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

process.env.VN_SMOKE = '1';
require('./main.js');

const results = [];
function check(name, cond, detail){
  results.push({ name, pass: !!cond, detail });
}

app.whenReady().then(() => {
  const wait = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(wait);

    try {
      const url = win.webContents.getURL();
      check('window loaded over http://127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+\/video-notes\.html$/.test(url), url);

      const probe = await win.webContents.executeJavaScript(`(function(){
        return {
          storage: typeof window.storage === 'object' && typeof window.storage.get === 'function'
                   && typeof window.storage.keys === 'function',
          desktop: typeof window.desktop === 'object' && typeof window.desktop.openVideo === 'function',
          nodeLeaked: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
          home: !!document.getElementById('home'),
          homeIsLanding: !document.getElementById('home').classList.contains('hidden'),
          workspaceHidden: document.querySelector('.workspace').classList.contains('hidden'),
          noPageScroll: document.body.scrollHeight <= window.innerHeight,
          notesList: !!document.getElementById('notes-list'),
          exportBtn: (document.getElementById('backup-btn') || {}).textContent
        };
      })()`);

      check('window.storage bridge present (with keys)', probe.storage);
      check('window.desktop bridge present', probe.desktop);
      check('node is not exposed to the page', !probe.nodeLeaked);
      check('home screen exists and is the landing view', probe.home && probe.homeIsLanding);
      check('workspace hidden behind home', probe.workspaceHidden);
      check('no page scrollbar', probe.noPageScroll);
      check('export button reads "Export all notes"', probe.exportBtn === 'Export all notes', probe.exportBtn);

      /* Styles are easy to delete by accident when removing a neighbouring block, and
         a missing rule shows up as a working button that renders as unstyled soup.
         Assert the modal is actually laid out, not merely present in the DOM. */
      const modal = await win.webContents.executeJavaScript(`(function(){
        document.getElementById('view-summary-btn').click();
        var panel = document.querySelector('.summary-modal-panel');
        var body  = document.querySelector('.summary-modal-body');
        var cs = getComputedStyle(panel), cb = getComputedStyle(body);
        var r = panel.getBoundingClientRect();
        var out = {
          open: document.getElementById('summary-modal').classList.contains('open'),
          panelIsFlex: cs.display === 'flex',
          bodyIsGrid: cb.display === 'grid',
          twoColumns: cb.gridTemplateColumns.split(' ').length === 2,
          bounded: r.width > 0 && r.width <= window.innerWidth && r.height <= window.innerHeight
        };
        document.getElementById('summary-modal-close').click();
        return out;
      })()`);
      check('summary modal opens', modal.open);
      check('summary modal panel is styled (flex, bounded)', modal.panelIsFlex && modal.bounded,
            JSON.stringify(modal));
      check('summary modal body is a two-column grid', modal.bodyIsGrid && modal.twoColumns,
            JSON.stringify(modal));

      /* the storage bridge must actually round-trip through the main process */
      const rt = await win.webContents.executeJavaScript(`(async function(){
        await window.storage.set('vn:smoke', JSON.stringify({ hello: 'world' }));
        const got = await window.storage.get('vn:smoke');
        const keys = await window.storage.keys();
        return { value: got && got.value, hasKey: keys.indexOf('vn:smoke') >= 0 };
      })()`);
      check('storage round-trips to disk', rt.value === '{"hello":"world"}', rt.value);
      check('keys() reports it', rt.hasKey);
    } catch (err) {
      check('probe ran without throwing', false, String(err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name + (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nsmoke passed\n');
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out waiting for the window'); app.exit(1); }, 30000);
});
