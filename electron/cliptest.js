'use strict';
/*
 * End-to-end check of the clip feature, driven inside the real app window.
 *
 *   npx electron electron/cliptest.js
 *
 * Runs against Electron's file-backed store rather than the browser's IndexedDB,
 * which is both the primary target and immune to a wedged test database.
 *
 * It uses its own userData directory, so it never touches real notes.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

/* isolate before anything reads the path */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-cliptest-'));
app.setPath('userData', SANDBOX);

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }

const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const IN = 120, OUT = 240;

function run(win, code){ return win.webContents.executeJavaScript(code); }

/* Resolves once the video has a real duration, or gives up loudly. */
async function ready(win, ms){
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until){
    const d = await run(win, `(function(){
      /* "1:23 / 10:34" - the half after the slash is the duration */
      var t = document.getElementById('time-display').textContent || '';
      var parts = (t.split('/')[1] || '').trim().split(':');
      return parts.length === 2 ? (+parts[0]) * 60 + (+parts[1]) : 0;
    })()`);
    if (d > 0) return d;
    await wait(400);
  }
  throw new Error('the video never reported a duration');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(() => {
  const poll = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(poll);

    try {
      await wait(1200);

      /* --- open the full video and cut a clip from it --- */
      await run(win, `
        document.getElementById('new-session-btn').click();
        document.getElementById('segment-url').value = ${JSON.stringify(VIDEO)};
        document.getElementById('segment-form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }));
      `);
      /* Wait for the player, not for a stopwatch: a fixed pause fails whenever YouTube
         is slower than the guess, and wastes the difference when it is faster. */
      await ready(win);

      const full = await run(win, `({
        loaded: document.getElementById('file-name').textContent.length > 0,
        clipRow: !document.getElementById('clip-control').classList.contains('hidden'),
        duration: document.getElementById('time-display').textContent
      })`);
      check('full video opens with the clip row offered', full.loaded && full.clipRow,
            JSON.stringify(full));

      await run(win, `
        (function(){
          var s = document.getElementById('seek');
          s.value = ${IN}; s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      await wait(1500);
      await run(win, `document.getElementById('clip-in-btn').click()`);
      await run(win, `
        (function(){
          var s = document.getElementById('seek');
          s.value = ${OUT}; s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      await wait(1500);
      await run(win, `document.getElementById('clip-out-btn').click()`);
      await wait(400);

      const marks = await run(win, `({
        range: document.getElementById('clip-range').textContent,
        edges: document.querySelectorAll('.mark.clip-edge').length,
        ready: !document.getElementById('clip-make-btn').disabled
      })`);
      check('in/out marks set and shown on the timeline',
            marks.edges === 2 && marks.ready, JSON.stringify(marks));

      await run(win, `document.getElementById('clip-make-btn').click()`);
      await wait(9000);

      const clip = await run(win, `({
        timecode: document.getElementById('time-display').textContent,
        seekMax: Math.round(parseFloat(document.getElementById('seek').max)),
        name: document.getElementById('file-name').textContent,
        share: !document.getElementById('share-clip-btn').classList.contains('hidden'),
        clipRowGone: document.getElementById('clip-control').classList.contains('hidden')
      })`);
      check('clip plays as its own timeline (relative timecode)',
            /^0:0\d \/ (1:59|2:00)$/.test(clip.timecode), clip.timecode);
      check('seek bar spans the segment only', Math.abs(clip.seekMax - (OUT - IN)) <= 2, String(clip.seekMax));
      check('clip is named for its segment', /\d+:\d\d.\d+:\d\d/.test(clip.name), clip.name);
      check('share offered, and no clip-of-a-clip', clip.share && clip.clipRowGone, JSON.stringify(clip));

      /* --- a note inside the clip uses clip time --- */
      await run(win, `
        (function(){
          var s = document.getElementById('seek');
          s.value = 20; s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      await wait(1500);
      await run(win, `
        (function(){
          var c = document.getElementById('draw-canvas');
          c.setPointerCapture = function(){};
          document.getElementById('mark-btn').click();
          setTimeout(function(){
            document.querySelector('[data-tool="rect"]').click();
            var r = c.getBoundingClientRect(), o = { bubbles: true, pointerId: 1 };
            function p(fx, fy){ return { clientX: r.left + r.width*fx, clientY: r.top + r.height*fy }; }
            c.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, o, p(0.3, 0.3))));
            c.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, p(0.6, 0.55))));
            c.dispatchEvent(new PointerEvent('pointerup',   Object.assign({}, o, p(0.6, 0.55))));
            document.getElementById('note-text').value = 'Guard pass';
            document.getElementById('save-btn').click();
          }, 500);
        })()`);
      await wait(2500);

      const noted = await run(win, `({
        heading: document.getElementById('notes-heading').textContent,
        label: (document.querySelector('.note-item .note-time') || {}).textContent
      })`);
      check('note saved against clip time, not source time',
            noted.heading === 'Notes (1)' && noted.label === '0:20', JSON.stringify(noted));

      /* --- playback stops at the clip's end, and can be seeked back out of --- */
      await run(win, `
        (function(){
          var s = document.getElementById('seek');
          s.value = ${OUT - IN - 6}; s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      await wait(1500);
      await run(win, `document.getElementById('play-btn').click()`);
      await wait(12000);
      const ended = await run(win, `({
        playing: document.getElementById('player-hud').classList.contains('playing'),
        timecode: document.getElementById('time-display').textContent
      })`);
      check('playback stops at the clip end', !ended.playing, JSON.stringify(ended));

      await run(win, `
        (function(){
          var s = document.getElementById('seek');
          s.value = 30; s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      await wait(2000);
      const back = await run(win, `document.getElementById('time-display').textContent`);
      check('can seek back out of the end (end-stop does not pin)',
            /^0:(2\d|3\d) \//.test(back), back);

      /* --- share, then open it as if it came from someone else --- */
      const shared = await run(win, `(async function(){
        var cap = null, oc = URL.createObjectURL;
        URL.createObjectURL = function(b){ if (b instanceof Blob && b.type === 'application/json') cap = b; return oc.call(URL, b); };
        var ac = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
        document.getElementById('share-clip-btn').click();
        /* Wait for the blob rather than for a fixed 800ms. On a busy machine - six
           Electron suites into a run - the write took longer than that, cap stayed
           null, and the next line parsed null and threw. The test failed, the app was
           fine, and it only ever happened in a batch. */
        for (var i = 0; i < 80 && !cap; i++){
          await new Promise(function(r){ setTimeout(r, 100); });
        }
        URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ac;
        return cap ? await cap.text() : null;
      })()`);
      const parsed = shared ? JSON.parse(shared) : null;
      check('share writes a clip file', !!parsed && parsed.format === 'video-notes-clip',
            shared === null ? 'nothing was written' : String(shared).slice(0, 80));
      /* Everything below reads this file; carrying on without it reports one real
         failure as ten, and buries which one actually went wrong. */
      if (!parsed) throw new Error('share produced no clip file - nothing below can run');
      check('clip file carries the video url and a deep link to the segment',
            parsed && parsed.url && /[?&]t=\d+/.test(parsed.sourceUrl || ''),
            parsed && parsed.sourceUrl);
      check('clip file notes are clip-relative with drawings',
            parsed && parsed.notes.length === 1 && Math.round(parsed.notes[0].time) === 20 &&
            !!parsed.notes[0].image, parsed && JSON.stringify(parsed.notes.map((n) => n.time)));

      /* re-import with different note ids: stands in for a clip from someone else */
      const theirs = JSON.parse(shared);
      theirs.notes.forEach((n, i) => { n.id = 'theirs-' + i; });
      theirs.name = 'Shared by a teammate';

      await run(win, `document.getElementById('recent-btn').click()`);
      await run(win, `
        (function(){
          var ri = document.getElementById('clip-input'), dt = new DataTransfer();
          dt.items.add(new File([${JSON.stringify(JSON.stringify(theirs))}], 't.json', { type: 'application/json' }));
          ri.files = dt.files;
          ri.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      await wait(11000);

      const opened = await run(win, `({
        status: document.getElementById('status').textContent,
        heading: document.getElementById('notes-heading').textContent,
        timecode: document.getElementById('time-display').textContent,
        onPlayer: document.getElementById('home').classList.contains('hidden')
      })`);
      check('opening a shared clip loads it straight away',
            opened.onPlayer && /Opened shared clip/.test(opened.status), JSON.stringify(opened));
      check('its notes merge in alongside your own',
            opened.heading === 'Notes (2)', opened.heading);

      /* opening the same file twice must not duplicate */
      await run(win, `document.getElementById('status').textContent = '(cleared)'`);
      await run(win, `
        (function(){
          var ri = document.getElementById('clip-input'), dt = new DataTransfer();
          dt.items.add(new File([${JSON.stringify(JSON.stringify(theirs))}], 't.json', { type: 'application/json' }));
          ri.files = dt.files;
          ri.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      await wait(11000);
      const again = await run(win, `({
        status: document.getElementById('status').textContent,
        heading: document.getElementById('notes-heading').textContent
      })`);
      check('opening it again adds nothing', again.heading === 'Notes (2)' &&
            /already had every note/.test(again.status), JSON.stringify(again));

    } catch (err) {
      check('test ran without throwing', false, String(err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name + (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\nclip checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
