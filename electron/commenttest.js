'use strict';
/*
 * Multiple coaches on one moment, driven in the real window.
 *
 *   npx electron electron/commenttest.js
 *
 * Uses its own userData and its own Notes folder, and plays a five-second fixture
 * video, so real notes and real videos are never touched.
 *
 * The thing being proved: a note written before authorship existed keeps its text,
 * gains the name captured at first startup, and can then collect comments from more
 * than one person - and merging two people's files unions their threads instead of
 * dropping one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-commenttest-'));
app.setPath('userData', SANDBOX);

/* a real, playable video, copied so the allowlist has something to stat */
const VIDEO = path.join(SANDBOX, 'tiny.mp4');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'tiny.mp4'), VIDEO);
const SIZE = fs.statSync(VIDEO).size;
const KEY = 'vnotes:tiny.mp4_' + SIZE;

require('./main.js');

const results = [];
function check(name, cond, detail){ results.push({ name, pass: !!cond, detail }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function run(win, code){ return win.webContents.executeJavaScript(code); }

/* the note as it looked before this feature: one text field, no author */
const LEGACY = [{
  id: 'legacy-1', time: 1, text: 'back line steps up too early',
  shapes: [], canvasW: 320, canvasH: 240,
  image: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
}];

app.whenReady().then(() => {
  const poll = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;
    const win = wins[0];
    if (win.webContents.isLoading()) return;
    clearInterval(poll);

    try {
      await wait(1500);

      /* seed one session holding one note from before comments existed */
      await run(win, `(async function(){
        await window.storage.set('vnotes:index', JSON.stringify([{
          key: ${JSON.stringify(KEY)}, kind:'file', label:'tiny.mp4',
          customName:'Legacy session', fileName:'tiny.mp4', fileSize:${SIZE},
          filePath: ${JSON.stringify(VIDEO)}, noteCount:1, lastOpened: Date.now()
        }]));
        await window.storage.set(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(LEGACY))});
      })()`);
      await wait(600);
      await run(win, `location.reload()`);
      await wait(2500);

      /* ---------- 1. the name is asked for once, at first startup ---------- */
      const prompt = await run(win, `({
        open: document.getElementById('name-modal').classList.contains('open'),
        title: document.getElementById('name-title').textContent,
        cancelHidden: document.getElementById('name-cancel').classList.contains('hidden')
      })`);
      check('first startup asks who is commenting', prompt.open, JSON.stringify(prompt));
      check('the first prompt cannot be dismissed without a name', prompt.cancelHidden,
            JSON.stringify(prompt));

      await run(win, `(function(){
        var i = document.getElementById('name-input');
        i.value = 'Carel';
        document.getElementById('name-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(700);
      const named = await run(win, `({
        open: document.getElementById('name-modal').classList.contains('open'),
        who: document.getElementById('who-name').textContent
      })`);
      check('entering a name closes the prompt', !named.open, JSON.stringify(named));
      check('the home screen says who is signing notes', named.who === 'Carel', named.who);

      /* it must not be asked again */
      await run(win, `location.reload()`);
      await wait(2500);
      const again = await run(win, `document.getElementById('name-modal').classList.contains('open')`);
      check('the name is remembered, so it is asked only once', !again, String(again));

      /* ---------- 2. an old note reads as that person's comment ---------- */
      await run(win, `(function(){
        document.querySelectorAll('.recent-row .recent-label')[0].click();
      })()`);
      await wait(3000);

      const first = await run(win, `({
        items: document.querySelectorAll('.note-item').length,
        authors: [].slice.call(document.querySelectorAll('.note-item .cmt-author'))
                   .map(function(e){ return e.textContent; }),
        texts: [].slice.call(document.querySelectorAll('.note-item .cmt-text'))
                 .map(function(e){ return e.textContent; }),
        composers: document.querySelectorAll('.note-item .cmt-input').length
      })`);
      check('the session opened with its note', first.items === 1, JSON.stringify(first));
      check('the old note is signed with the name given at startup',
            first.authors.join() === 'Carel', JSON.stringify(first.authors));
      check('the old note keeps its exact text',
            first.texts.join() === 'back line steps up too early', JSON.stringify(first.texts));
      check('every moment has a box for another comment', first.composers === 1,
            String(first.composers));

      /* ---------- 3. a second comment on the same moment ---------- */
      await run(win, `(function(){
        var i = document.querySelector('.note-item .cmt-input');
        i.value = 'and the winger is late';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      await wait(900);
      let thread = await run(win, `[].slice.call(document.querySelectorAll('.note-item .cmt'))
        .map(function(r){ return (r.querySelector('.cmt-author')||{}).textContent + '|' +
                                 r.querySelector('.cmt-text').textContent; })`);
      check('a moment holds more than one comment', thread.length === 2, JSON.stringify(thread));
      check('the new comment is signed by the current user',
            thread[1] === 'Carel|and the winger is late', JSON.stringify(thread));

      /* ---------- 4. a second coach ---------- */
      await run(win, `(function(){
        document.getElementById('who-change').click();
      })()`);
      await wait(400);
      const changing = await run(win, `({
        open: document.getElementById('name-modal').classList.contains('open'),
        cancelHidden: document.getElementById('name-cancel').classList.contains('hidden')
      })`);
      check('the name can be changed later', changing.open && !changing.cancelHidden,
            JSON.stringify(changing));

      await run(win, `(function(){
        document.getElementById('name-input').value = 'Marius';
        document.getElementById('name-form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await wait(700);
      await run(win, `(function(){
        var i = document.querySelector('.note-item .cmt-input');
        i.value = 'agree, but watch the far side';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      await wait(900);
      thread = await run(win, `[].slice.call(document.querySelectorAll('.note-item .cmt'))
        .map(function(r){ return (r.querySelector('.cmt-author')||{}).textContent + '|' +
                                 r.querySelector('.cmt-text').textContent; })`);
      check('a second coach can comment on the same moment', thread.length === 3,
            JSON.stringify(thread));
      check('each comment carries the name of whoever wrote it',
            thread[2] === 'Marius|agree, but watch the far side', JSON.stringify(thread));
      check('renaming does not rewrite who wrote the earlier ones',
            thread[0].indexOf('Carel|') === 0 && thread[1].indexOf('Carel|') === 0,
            JSON.stringify(thread));

      /* ---------- 5. what is on disk ---------- */
      const stored = await run(win, `(async function(){
        var v = await window.storage.get(${JSON.stringify(KEY)});
        var n = JSON.parse(v.value)[0];
        return { text: n.text, count: (n.comments||[]).length,
                 authors: (n.comments||[]).map(function(c){ return c.author; }),
                 ids: (n.comments||[]).map(function(c){ return !!c.id; }) };
      })()`);
      check('the original text is still there, untouched',
            stored.text === 'back line steps up too early', stored.text);
      check('all three comments were saved', stored.count === 3, JSON.stringify(stored));
      check('every saved comment has an author and an id',
            stored.authors.join() === 'Carel,Carel,Marius' &&
            stored.ids.every(Boolean), JSON.stringify(stored));

      /* ---------- 6. the panel over the video shows the whole thread ---------- */
      await run(win, `document.querySelector('.note-item .note-time').click()`);
      await wait(1200);
      const panel = await run(win, `({
        lines: [].slice.call(document.querySelectorAll('#note-view-text .nv-cmt'))
                 .map(function(e){ return e.textContent; }),
        scrolls: getComputedStyle(document.getElementById('note-view-text')).overflowY
      })`);
      check('the panel over the video lists every comment', panel.lines.length === 3,
            JSON.stringify(panel.lines));
      check('and scrolls when there are more than fit', panel.scrolls === 'auto',
            panel.scrolls);

      /* ---------- 6b. the other places a note's text is shown ---------- */
      const elsewhere = await run(win, `(function(){
        document.querySelector('.panel-tab[data-pane="summary"]').click();
        var tabLines = [].slice.call(document.querySelectorAll('#summary-notes .summary-line .s div'))
                          .map(function(e){ return e.textContent; });
        document.querySelector('.panel-tab[data-pane="notes"]').click();
        return {
          tabLines: tabLines,
          tip: document.querySelector('.mark-strip .mark').title
        };
      })()`);
      check('the summary tab lists every comment with its author',
            elsewhere.tabLines.length === 3 &&
            elsewhere.tabLines[0] === 'Carel: back line steps up too early',
            JSON.stringify(elsewhere.tabLines));
      check('the timeline tooltip covers the whole thread',
            elsewhere.tip.indexOf('Carel:') >= 0 && elsewhere.tip.indexOf('Marius:') >= 0,
            elsewhere.tip);

      await run(win, `document.getElementById('view-summary-btn').click()`);
      await wait(700);
      const modal = await run(win, `(function(){
        var out = [].slice.call(document.querySelectorAll('#summary-modal-list .mx div'))
                    .map(function(e){ return e.textContent; });
        document.getElementById('summary-modal-close').click();
        return out;
      })()`);
      check('the summary modal lists every comment', modal.length === 3 &&
            modal[2] === 'Marius: agree, but watch the far side', JSON.stringify(modal));
      await wait(400);

      const lb = await run(win, `(function(){
        document.querySelector('.note-item .note-thumb').click();
        var out = [].slice.call(document.querySelectorAll('#lightbox-text .lb-cmt'))
                    .map(function(e){ return e.textContent; });
        document.getElementById('lightbox-close').click();
        return out;
      })()`);
      check('the enlarged drawing lists every comment', lb.length === 3, JSON.stringify(lb));
      await wait(400);

      /* ---------- 7. it all survives a restart ---------- */
      await run(win, `location.reload()`);
      await wait(2500);
      await run(win, `document.querySelectorAll('.recent-row .recent-label')[0].click()`);
      await wait(3000);
      const after = await run(win, `document.querySelectorAll('.note-item .cmt').length`);
      check('the thread survives a restart', after === 3, String(after));

      /* ---------- 8. deleting one comment leaves the rest ---------- */
      await run(win, `window.confirm = function(){ return true; };
        document.querySelectorAll('.note-item .cmt .cmt-del')[1].click()`);
      await wait(900);
      const left = await run(win, `(async function(){
        var v = await window.storage.get(${JSON.stringify(KEY)});
        var n = JSON.parse(v.value)[0];
        return { dom: document.querySelectorAll('.note-item .cmt').length,
                 saved: (n.comments||[]).length, text: n.text };
      })()`);
      check('a single comment can be deleted', left.dom === 2 && left.saved === 2,
            JSON.stringify(left));
      check('deleting one leaves the others alone',
            left.text === 'back line steps up too early', JSON.stringify(left));

      /* ---------- 9. two coaches merging their files ---------- */
      /* Marius sends back the same note with a comment Carel has never seen. */
      const backup = {
        format: 'video-notes-backup', version: 1, saved: new Date().toISOString(),
        library: [],
        videos: {
          [KEY]: [{
            id: 'legacy-1', time: 1, text: 'back line steps up too early',
            comments: [
              { id: 'c-remote', author: 'Marius', text: 'from a file they sent back', at: 5 }
            ]
          }, {
            id: 'brand-new', time: 2, text: 'a moment only they marked',
            comments: [{ id: 'c-new', author: 'Marius', text: 'a moment only they marked', at: 6 }]
          }]
        },
        summaries: {}
      };
      await run(win, `(function(){
        var dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(JSON.stringify(backup))}],
                     'backup.json', { type: 'application/json' }));
        var inp = document.getElementById('restore-input');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(2000);
      const merged = await run(win, `(async function(){
        var v = await window.storage.get(${JSON.stringify(KEY)});
        var list = JSON.parse(v.value);
        var one = list.filter(function(n){ return n.id === 'legacy-1'; })[0];
        return {
          notes: list.length,
          comments: (one.comments||[]).map(function(c){ return c.author + '|' + c.text; })
        };
      })()`);
      check('a note only the other coach had is added', merged.notes === 2,
            JSON.stringify(merged));
      check('their comment joins the thread instead of replacing it',
            merged.comments.length === 3 &&
            merged.comments.indexOf('Marius|from a file they sent back') >= 0,
            JSON.stringify(merged.comments));
      check('nothing of yours is lost in the merge',
            merged.comments.indexOf('Carel|back line steps up too early') >= 0 &&
            merged.comments.indexOf('Marius|agree, but watch the far side') >= 0,
            JSON.stringify(merged.comments));

      /* and merging the same file twice must not duplicate anything */
      await run(win, `(function(){
        var dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(JSON.stringify(backup))}],
                     'backup.json', { type: 'application/json' }));
        var inp = document.getElementById('restore-input');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(2000);
      const twice = await run(win, `(async function(){
        var v = await window.storage.get(${JSON.stringify(KEY)});
        var list = JSON.parse(v.value);
        return { notes: list.length,
                 comments: (list.filter(function(n){ return n.id === 'legacy-1'; })[0].comments||[]).length };
      })()`);
      check('merging the same file twice changes nothing',
            twice.notes === 2 && twice.comments === 3, JSON.stringify(twice));

    } catch (err) {
      check('test ran without throwing', false, String(err && err.stack || err));
    }

    let failed = 0;
    for (const r of results){
      if (!r.pass) failed++;
      console.log((r.pass ? '  ok   ' : '  FAIL ') + r.name +
                  (r.pass || !r.detail ? '' : '  -> ' + r.detail));
    }
    console.log(failed ? '\n' + failed + ' FAILURE(S)\n' : '\ncomment checks passed\n');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    app.exit(failed ? 1 : 0);
  }, 250);

  setTimeout(() => { console.log('  FAIL timed out'); app.exit(1); }, 180000);
});
