'use strict';
/*
 * The cleaned-up home page, the sessions tree and the one-modal session creation,
 * driven in the real window.
 *
 *   npx electron electron/hometest.js
 *
 * Uses its own userData and its own Notes folder, so real notes are never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-hometest-'));
app.setPath('userData', SANDBOX);

require('./main.js');

const PKG_VERSION = require('../package.json').version;

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

/* ten sessions, three of them nested, so the tree has a shape to draw */
const LIB = [
  { key: 'vnotes:a.mp4_1', kind: 'file', label: 'a.mp4', customName: 'Jack round 1',
    folder: 'Competition 2026', noteCount: 3 },
  { key: 'vnotes:b.mp4_2', kind: 'file', label: 'b.mp4', customName: 'Jack round 2',
    folder: 'Competition 2026/Nationals', noteCount: 5 },
  { key: 'vnotes:c.mp4_3', kind: 'file', label: 'c.mp4', customName: 'Linc semi',
    folder: 'Competition 2026/Nationals', noteCount: 2 },
  { key: 'vnotes:d.mp4_4', kind: 'file', label: 'd.mp4', customName: 'Guard drill',
    folder: 'Training', noteCount: 1 },
  { key: 'vnotes:e.mp4_5', kind: 'file', label: 'e.mp4', customName: 'Loose one', noteCount: 4 }
];
for (let i = 6; i <= 11; i++){
  LIB.push({ key: 'vnotes:x' + i + '.mp4_' + i, kind: 'file', label: 'x' + i + '.mp4',
             customName: 'Filler ' + i, noteCount: i });
}
LIB.forEach((e, i) => { e.lastOpened = Date.now() - i * 1000; });

app.whenReady().then(() => {
  const poll = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(poll);

    /* Only real faults from the page. Electron's own dev warnings and YouTube's
       cross-origin postMessage chatter are noise, and neither is ours to fix. */
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2 && /Uncaught|ReferenceError|TypeError|is not a function|is not defined|Cannot read/.test(message)){
        errors.push(message);
      }
    });

    try {
      await wait(1500);
      await run(win, `(async function(){
        await window.storage.set('vnotes:prefs', JSON.stringify({ userName: 'Carel' }));
        await window.storage.set('vnotes:index', ${JSON.stringify(JSON.stringify(LIB))});
      })()`);
      await wait(600);
      await run(win, `location.reload()`);
      await wait(2500);

      /* ---------- 1. the home page is recent sessions and nothing else ---------- */
      const home = await run(win, `({
        newBtn: !!document.getElementById('new-session-btn'),
        gone: ['load-btn','top-url-form','url-input','empty-load-btn','segment-btn']
                .filter(function(id){ return !!document.getElementById(id); }),
        rows: document.querySelectorAll('#recent-list .recent-row').length,
        controlsOnRows: document.querySelectorAll('#recent-list .recent-folder, ' +
                        '#recent-list .recent-edit, #recent-list .recent-forget').length,
        seeAll: document.getElementById('see-all-btn').textContent,
        version: document.getElementById('app-version').textContent
      })`);
      check('the home page offers one way to start a session', home.newBtn, JSON.stringify(home));
      check('the duplicated ways in are gone', home.gone.length === 0, JSON.stringify(home.gone));
      check('it lists only the recent few, not all 11', home.rows === 8, String(home.rows));
      check('home rows carry no management controls', home.controlsOnRows === 0,
            String(home.controlsOnRows));
      check('there is a way through to the rest', /All 11 sessions/.test(home.seeAll), home.seeAll);
      check('the version shows bottom-right and matches package.json',
            home.version === 'v' + PKG_VERSION, home.version + ' vs v' + PKG_VERSION);

      /* the top bar keeps navigation, and the player controls moved down */
      const bars = await run(win, `({
        topbar: [].slice.call(document.querySelectorAll('.topbar button'))
                  .map(function(b){ return b.id; }).filter(Boolean),
        controls: [].slice.call(document.querySelectorAll('.controls-bar button, .controls-bar input'))
                    .map(function(b){ return b.id; }).filter(Boolean)
      })`);
      check('the top bar is navigation only',
            bars.topbar.indexOf('sessions-btn') >= 0 && bars.topbar.indexOf('settings-btn') >= 0 &&
            bars.topbar.indexOf('recent-btn') >= 0 && bars.topbar.indexOf('load-btn') < 0,
            JSON.stringify(bars.topbar));
      check('pause-at-notes and view-summary moved to the controls bar',
            bars.controls.indexOf('auto-pause') >= 0 && bars.controls.indexOf('view-summary-btn') >= 0,
            JSON.stringify(bars.controls));

      /* ---------- 2. the sessions tree ---------- */
      await run(win, `document.getElementById('sessions-btn').click()`);
      await wait(500);
      const tree = await run(win, `({
        open: document.getElementById('sessions-modal').classList.contains('open'),
        folders: [].slice.call(document.querySelectorAll('#sessions-tree .tree-folder .tree-name'))
                   .map(function(e){ return e.textContent; }),
        counts: [].slice.call(document.querySelectorAll('#sessions-tree .tree-folder .recent-group-count'))
                  .map(function(e){ return e.textContent; }),
        rows: document.querySelectorAll('#sessions-tree .recent-row').length,
        indents: [].slice.call(document.querySelectorAll('#sessions-tree .tree-folder'))
                   .map(function(e){ return e.style.paddingLeft; })
      })`);
      check('All sessions opens a tree', tree.open, JSON.stringify(tree.open));
      check('folders are drawn by name, nested ones included',
            tree.folders.indexOf('Competition 2026') >= 0 &&
            tree.folders.indexOf('Nationals') >= 0 &&
            tree.folders.indexOf('Training') >= 0, JSON.stringify(tree.folders));
      check('a folder counts everything beneath it, not just its own',
            tree.counts[0] === '3', JSON.stringify(tree.counts));
      check('nesting is drawn as indentation',
            tree.indents[0] === '10px' && tree.indents[1] === '26px', JSON.stringify(tree.indents));
      check('every session is in the tree, not just the recent ones',
            tree.rows === 11, String(tree.rows));
      check('the tree rows carry the management controls',
            (await run(win, `document.querySelectorAll('#sessions-tree .recent-folder').length`)) === 11);

      /* folding */
      await run(win, `[].slice.call(document.querySelectorAll('#sessions-tree .tree-folder'))
        .filter(function(f){ var n = f.querySelector('.tree-name');
                             return n && n.textContent === 'Competition 2026'; })[0].click()`);
      await wait(400);
      const folded = await run(win, `({
        rows: document.querySelectorAll('#sessions-tree .recent-row').length,
        nationals: [].slice.call(document.querySelectorAll('#sessions-tree .tree-name'))
                     .map(function(e){ return e.textContent; }).indexOf('Nationals')
      })`);
      check('folding a folder hides what is under it, nested folders too',
            folded.rows === 8 && folded.nationals < 0, JSON.stringify(folded));

      /* search auto-expands, so a hit inside the folded folder still shows */
      await run(win, `(function(){
        var f = document.getElementById('session-filter');
        f.value = 'Linc';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(400);
      const searched = await run(win, `({
        rows: [].slice.call(document.querySelectorAll('#sessions-tree .recent-label'))
                .map(function(e){ return e.textContent; }),
        folders: [].slice.call(document.querySelectorAll('#sessions-tree .tree-name'))
                   .map(function(e){ return e.textContent; })
      })`);
      check('search narrows to the match', searched.rows.join() === 'Linc semi',
            JSON.stringify(searched.rows));
      check('and opens the folded folders it is hiding in',
            searched.folders.indexOf('Competition 2026') >= 0 &&
            searched.folders.indexOf('Nationals') >= 0, JSON.stringify(searched.folders));

      await run(win, `(function(){
        var f = document.getElementById('session-filter');
        f.value = 'nothing here';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(400);
      check('a search with no hits says so',
            /No session matches/.test(await run(win, `document.getElementById('sessions-tree').textContent`)));

      await run(win, `(function(){
        var f = document.getElementById('session-filter');
        f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(400);

      /* renaming still works, from the tree now */
      await run(win, `(function(){
        var rows = [].slice.call(document.querySelectorAll('#sessions-tree .recent-row'));
        var row = rows.filter(function(r){
          var l = r.querySelector('.recent-label');
          return l && l.textContent === 'Loose one'; })[0];
        row.querySelector('.recent-edit').click();
        var i = row.querySelector('.recent-rename');
        i.value = 'Renamed in the tree';
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      await wait(900);
      const renamed = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        var lib = JSON.parse(v.value);
        return lib.filter(function(e){ return e.key.split('|').pop() === 'vnotes:e.mp4_5'; })[0].customName;
      })()`);
      check('a session can be renamed from the tree', renamed === 'Renamed in the tree', renamed);

      await run(win, `document.getElementById('sessions-close').click()`);
      await wait(300);
      check('the tree closes',
            !(await run(win, `document.getElementById('sessions-modal').classList.contains('open')`)));

      /* ---------- 3. one modal for starting a session ---------- */
      await run(win, `document.getElementById('new-session-btn').click()`);
      await wait(400);
      const modal = await run(win, `({
        open: document.getElementById('new-session-modal').classList.contains('open'),
        timesHidden: document.getElementById('segment-times').classList.contains('hidden'),
        hasFileBtn: !!document.getElementById('segment-file-btn')
      })`);
      check('one modal handles starting a session', modal.open && modal.hasFileBtn,
            JSON.stringify(modal));
      check('the segment fields stay out of the way until asked for', modal.timesHidden,
            JSON.stringify(modal));

      await run(win, `(function(){
        var t = document.getElementById('segment-toggle');
        t.checked = true;
        t.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(300);
      check('ticking the box reveals them',
            !(await run(win, `document.getElementById('segment-times').classList.contains('hidden')`)));

      /* a segment, through the same form */
      await run(win, `(function(){
        document.getElementById('segment-url').value = 'https://youtu.be/dQw4w9WgXcQ';
        document.getElementById('segment-start').value = '1:30';
        document.getElementById('segment-end').value = '4:00';
        document.getElementById('segment-name').value = 'The scramble';
        document.getElementById('segment-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(2500);
      const madeClip = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).filter(function(e){
          return e.key.split('|').pop() === 'vnotes:yt:dQw4w9WgXcQ@90.00-240.00'; })[0] || null;
      })()`);
      check('a segment made from the modal is keyed to its bounds',
            madeClip && madeClip.segment.start === 90 && madeClip.segment.end === 240,
            JSON.stringify(madeClip));

      /* a whole video, same form, box unticked */
      await run(win, `document.getElementById('recent-btn').click()`);
      await wait(500);
      await run(win, `document.getElementById('new-session-btn').click()`);
      await wait(300);
      await run(win, `(function(){
        var t = document.getElementById('segment-toggle');
        t.checked = false;
        t.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('segment-url').value = 'https://youtu.be/abcdefghijk';
        document.getElementById('segment-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(2500);
      const madeFull = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        return JSON.parse(v.value).filter(function(e){
          return e.key.split('|').pop() === 'vnotes:yt:abcdefghijk'; })[0] || null;
      })()`);
      check('the same form opens a whole video when the box is clear',
            madeFull && !madeFull.segment, JSON.stringify(madeFull));

      await run(win, `document.getElementById('recent-btn').click()`);
      await wait(400);
      await run(win, `document.getElementById('new-session-btn').click()`);
      await wait(300);
      await run(win, `(function(){
        document.getElementById('segment-url').value = 'not a link';
        document.getElementById('segment-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(400);
      check('rubbish in the link box is refused, and the modal stays open',
            (await run(win, `document.getElementById('new-session-modal').classList.contains('open')`)) &&
            /YouTube link/.test(await run(win, `document.getElementById('segment-error').textContent`)));
      await run(win, `document.getElementById('segment-cancel').click()`);
      await wait(300);

      /* ---------- 4. settings behind the gear ---------- */
      await run(win, `document.getElementById('settings-btn').click()`);
      await wait(400);
      const settings = await run(win, `({
        open: document.getElementById('settings-modal').classList.contains('open'),
        who: document.getElementById('who-name').textContent,
        themes: document.querySelectorAll('#theme-row .theme-chip').length,
        backup: document.getElementById('backup-btn').textContent,
        inModal: !!document.getElementById('backup-btn').closest('#settings-modal')
      })`);
      check('the gear opens settings', settings.open, JSON.stringify(settings.open));
      check('with the name, the themes and the backup buttons in it',
            settings.who === 'Carel' && settings.themes === 8 &&
            settings.backup === 'Export all notes' && settings.inModal,
            JSON.stringify(settings));
      /* ---------- 5. help, from settings ---------- */
      await run(win, `document.getElementById('help-btn').click()`);
      await wait(500);
      const help = await run(win, `({
        open: document.getElementById('help-modal').classList.contains('open'),
        headings: [].slice.call(document.querySelectorAll('#help-modal .help-body h3'))
                    .map(function(h){ return h.textContent; }),
        keys: document.querySelectorAll('#help-modal .help-keys kbd').length,
        scrolls: getComputedStyle(document.querySelector('#help-modal .help-body')).overflowY,
        settingsStillOpen: document.getElementById('settings-modal').classList.contains('open')
      })`);
      check('settings has a help button that opens instructions', help.open,
            JSON.stringify(help.open));
      check('the instructions cover the app, not just one corner of it',
            help.headings.length >= 7 &&
            help.headings.some(function(h){ return /vault/i.test(h); }) &&
            help.headings.some(function(h){ return /keyboard/i.test(h); }),
            JSON.stringify(help.headings));
      check('the keyboard shortcuts are listed', help.keys >= 6, String(help.keys));
      check('long instructions scroll inside the panel', help.scrolls === 'auto', help.scrolls);
      check('help opens over settings rather than replacing it',
            help.settingsStillOpen, String(help.settingsStillOpen));

      await run(win, `document.getElementById('help-close').click()`);
      await wait(300);
      const afterHelp = await run(win, `({
        help: document.getElementById('help-modal').classList.contains('open'),
        settings: document.getElementById('settings-modal').classList.contains('open')
      })`);
      check('closing help puts you back in settings',
            !afterHelp.help && afterHelp.settings, JSON.stringify(afterHelp));

      await run(win, `document.getElementById('settings-close').click()`);
      await wait(300);

      /* ---------- 6. a dropped video is remembered like a picked one ---------- */
      /* Electron 32 removed File.path, so dropping used to open the video and then save
         a session that could not find it again - the same action as Choose a video file,
         quietly worse. The drop is synthesised; what is checked is that a path comes back
         and reaches the library entry. */
      /* A handful of bytes rather than the whole fixture: what is checked is that the
         drop registers a session keyed by name and size, and injecting 28 KB of base64
         through executeJavaScript was flaky for no benefit. */

      /* A File built in the page has no filesystem origin, so getPathForFile rightly
         returns nothing for it and a real drag cannot be synthesised from here. What is
         checked is the bridge and the fallback; the path itself needs a real drag. */
      const bridged = await run(win, `typeof window.desktop.pathForFile === 'function'`);
      check('the preload can turn a dropped file into a path', bridged, String(bridged));

      await run(win, `(function(){
        var bytes = new Uint8Array(64);
        var file = new File([bytes], 'dropped.mp4', { type: 'video/mp4' });
        var dt = new DataTransfer();
        dt.items.add(file);
        document.getElementById('video-wrap').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      })()`);
      await wait(3500);

      const dropped = await run(win, `(async function(){
        var v = await window.storage.get('vnotes:index');
        var e = JSON.parse(v.value).filter(function(x){
          return (x.fileName || '') === 'dropped.mp4'; })[0];
        return e ? { path: e.filePath, key: e.key } : null;
      })()`);
      check('dropping a video still opens it when no path can be had',
            !!dropped, JSON.stringify(dropped));
      check('and it is keyed by name and size like any other file session',
            dropped && /vnotes:dropped\.mp4_/.test(dropped.key), JSON.stringify(dropped));

      check('nothing threw along the way', errors.length === 0, errors.join(' | '));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nhome checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
