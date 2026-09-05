'use strict';
/*
 * Making a segment session straight from a link, driven in the real window.
 *
 *   npx electron electron/segmenttest.js
 *
 * Uses its own userData and its own Notes folder, so real notes are never touched.
 * No network is needed: a session registers itself as soon as it opens, before the
 * YouTube player has loaded anything, and that is what these checks look at.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-segmenttest-'));
app.setPath('userData', SANDBOX);

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function run(win, code){ return win.webContents.executeJavaScript(code); }

/* fill the modal in and submit it */
function fillAndSubmit(win, url, start, end, name){
  return run(win, `(function(){
    document.getElementById('segment-url').value = ${JSON.stringify(url)};
    document.getElementById('segment-start').value = ${JSON.stringify(start)};
    document.getElementById('segment-end').value = ${JSON.stringify(end)};
    document.getElementById('segment-name').value = ${JSON.stringify(name || '')};
    document.getElementById('segment-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return {
      open: document.getElementById('segment-modal').classList.contains('open'),
      error: document.getElementById('segment-error').textContent
    };
  })()`);
}

function libraryState(win){
  return run(win, `(async function(){
    var v = await window.storage.get('vnotes:index');
    var lib = v ? JSON.parse(v.value) : [];
    return lib.map(function(e){
      return { key: e.key, name: e.customName || e.label,
               segment: e.segment || null, videoId: e.videoId || null };
    });
  })()`);
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
      /* a name already set, so the first-run prompt is not in the way */
      await run(win, `window.storage.set('vnotes:prefs', JSON.stringify({ userName: 'Carel' }))`);
      await wait(500);
      await run(win, `location.reload()`);
      await wait(2500);

      /* ---------- the button and the modal ---------- */
      const home = await run(win, `({
        button: !!document.getElementById('segment-btn'),
        onHome: !document.getElementById('home').classList.contains('hidden'),
        modalOpen: document.getElementById('segment-modal').classList.contains('open')
      })`);
      check('the home screen offers a segment button', home.button && home.onHome,
            JSON.stringify(home));
      check('the modal starts closed', !home.modalOpen, JSON.stringify(home));

      await run(win, `document.getElementById('segment-btn').click()`);
      await wait(400);
      const opened = await run(win, `({
        open: document.getElementById('segment-modal').classList.contains('open'),
        fields: ['segment-url','segment-start','segment-end','segment-name']
                  .every(function(id){ return !!document.getElementById(id); })
      })`);
      check('the button opens the modal', opened.open && opened.fields, JSON.stringify(opened));

      /* ---------- what it refuses ---------- */
      let r = await fillAndSubmit(win, 'https://example.com/not-youtube', '1:00', '2:00');
      check('a link that is not YouTube is refused',
            r.open && /youtube link/i.test(r.error), JSON.stringify(r));

      r = await fillAndSubmit(win, 'https://youtu.be/dQw4w9WgXcQ', '1:00', 'half past two');
      check('an unreadable end is refused', r.open && /end/i.test(r.error), JSON.stringify(r));

      r = await fillAndSubmit(win, 'https://youtu.be/dQw4w9WgXcQ', '4:00', '2:00');
      check('an end before the start is refused',
            r.open && /after the start/i.test(r.error), JSON.stringify(r));

      r = await fillAndSubmit(win, 'https://youtu.be/dQw4w9WgXcQ', '1:70', '2:00');
      check('a nonsense clock like 1:70 is refused',
            r.open && /start/i.test(r.error), JSON.stringify(r));

      let lib = await libraryState(win);
      check('nothing was created by any of the refusals', lib.length === 0,
            JSON.stringify(lib));

      /* ---------- what it accepts ---------- */
      r = await fillAndSubmit(win, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                              '1:30', '4:00', 'The scramble');
      await wait(2500);
      check('a good segment closes the modal', !r.open, JSON.stringify(r));

      const opened2 = await run(win, `({
        onHome: !document.getElementById('home').classList.contains('hidden'),
        label: document.getElementById('file-name').textContent
      })`);
      check('it opens the session rather than staying on the home screen',
            !opened2.onHome, JSON.stringify(opened2));

      lib = await libraryState(win);
      check('the session is keyed to the segment',
            lib.length === 1 && lib[0].key === 'vnotes:yt:dQw4w9WgXcQ@90.00-240.00',
            JSON.stringify(lib));
      check('the segment bounds are stored on it',
            lib[0].segment && lib[0].segment.start === 90 && lib[0].segment.end === 240,
            JSON.stringify(lib[0]));
      check('the name typed in the modal is kept', lib[0].name === 'The scramble',
            JSON.stringify(lib[0]));

      /* ---------- the same segment again is the same session ---------- */
      await run(win, `document.getElementById('recent-btn').click()`);
      await wait(600);
      await run(win, `document.getElementById('segment-btn').click()`);
      await wait(300);
      await fillAndSubmit(win, 'https://youtu.be/dQw4w9WgXcQ', '90', '240');
      await wait(2500);
      lib = await libraryState(win);
      check('making the same segment twice reopens the one session',
            lib.length === 1 && lib[0].name === 'The scramble', JSON.stringify(lib));

      /* ---------- an empty start falls back to the link's own moment ---------- */
      await run(win, `document.getElementById('recent-btn').click()`);
      await wait(600);
      await run(win, `document.getElementById('segment-btn').click()`);
      await wait(300);
      await fillAndSubmit(win, 'https://www.youtube.com/watch?v=abcdefghijk&t=45', '', '1:02:03');
      await wait(2500);
      lib = await libraryState(win);
      const made = lib.filter(function(e){ return e.videoId === 'abcdefghijk'; })[0];
      check('an empty start uses the moment the link points at',
            made && made.segment.start === 45, JSON.stringify(lib));
      check('an hours:minutes:seconds end is read correctly',
            made && made.segment.end === 3723, JSON.stringify(made));

      /* ---------- closing without making anything ---------- */
      await run(win, `document.getElementById('recent-btn').click()`);
      await wait(600);
      await run(win, `document.getElementById('segment-btn').click()`);
      await wait(300);
      await run(win, `document.getElementById('segment-cancel').click()`);
      await wait(300);
      const cancelled = await run(win, `document.getElementById('segment-modal').classList.contains('open')`);
      check('cancel closes the modal', !cancelled, String(cancelled));

      await run(win, `document.getElementById('segment-btn').click()`);
      await wait(300);
      await run(win, `document.getElementById('segment-modal')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(300);
      const escaped = await run(win, `document.getElementById('segment-modal').classList.contains('open')`);
      check('escape closes the modal', !escaped, String(escaped));

      lib = await libraryState(win);
      check('cancelling created nothing', lib.length === 2, JSON.stringify(lib.length));

      /* ---------- it survives a restart like any other session ---------- */
      await run(win, `location.reload()`);
      await wait(2500);
      const rows = await run(win, `[].slice.call(document.querySelectorAll('.recent-label'))
        .map(function(e){ return e.textContent; })`);
      check('segment sessions are listed on the home screen like any other',
            rows.indexOf('The scramble') >= 0, JSON.stringify(rows));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nsegment checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
