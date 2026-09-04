'use strict';
/*
 * Headless checks for the two pieces that carry real risk: byte-range streaming
 * (get it wrong and seeking silently breaks) and the on-disk store (get it wrong
 * and notes are lost). Runs under plain node — no Electron, no window.
 *
 *   node electron/selftest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./store');
const { createServer } = require('./server');

let failures = 0;
function ok(name, cond, detail){
  if (cond){ console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, actual, expected){
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function req(port, pathname, headers){
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function main(){
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vnotes-selftest-'));

  /* ---------------- store ---------------- */
  console.log('\nstore');
  const store = new Store(path.join(tmp, 'store'));

  store.set('vnotes:index', '[{"key":"a"}]');
  store.set('vnotes:match one.mp4_123', '["note"]');
  store.set('vnotes:summary:vnotes:match one.mp4_123', '{"text":"hi"}');

  eq('round-trips a value', store.get('vnotes:index'), '[{"key":"a"}]');
  eq('missing key returns null', store.get('nope'), null);

  const keys = store.keys().sort();
  eq('keys() lists everything written', keys.length, 3);
  ok('keys survive punctuation and spaces', keys.indexOf('vnotes:summary:vnotes:match one.mp4_123') >= 0,
     JSON.stringify(keys));

  /* two keys that a naive sanitiser would collapse onto one file */
  store.set('a/b', 'first');
  store.set('a:b', 'second');
  ok('similar keys do not collide', store.get('a/b') === 'first' && store.get('a:b') === 'second');

  store.set('vnotes:index', '[{"key":"b"}]');
  eq('overwrite replaces cleanly', store.get('vnotes:index'), '[{"key":"b"}]');
  const stray = fs.readdirSync(path.join(tmp, 'store')).filter((f) => f.indexOf('.tmp') >= 0);
  eq('no temp files left behind', stray.length, 0);

  /* ---------------- range streaming ---------------- */
  console.log('\nmedia streaming');
  const media = path.join(tmp, 'clip.mp4');
  const payload = crypto.randomBytes(100000);
  fs.writeFileSync(media, payload);

  const srv = createServer({ root: path.join(__dirname, '..') });
  const port = await srv.listen();
  const enc = Buffer.from(media, 'utf8').toString('base64url');

  const denied = await req(port, '/media?p=' + enc);
  eq('a path never opened is refused', denied.status, 403);

  srv.allow(media);

  const full = await req(port, '/media?p=' + enc);
  eq('full GET returns 200', full.status, 200);
  eq('advertises range support', full.headers['accept-ranges'], 'bytes');
  eq('full body length', full.body.length, payload.length);
  ok('full body matches the file', full.body.equals(payload));

  const part = await req(port, '/media?p=' + enc, { Range: 'bytes=100-199' });
  eq('range returns 206', part.status, 206);
  eq('range content-range', part.headers['content-range'], 'bytes 100-199/100000');
  eq('range length', part.body.length, 100);
  ok('range bytes are the right ones', part.body.equals(payload.slice(100, 200)));

  const openEnded = await req(port, '/media?p=' + enc, { Range: 'bytes=99990-' });
  eq('open-ended range 206', openEnded.status, 206);
  eq('open-ended length', openEnded.body.length, 10);

  const suffix = await req(port, '/media?p=' + enc, { Range: 'bytes=-500' });
  eq('suffix range 206', suffix.status, 206);
  ok('suffix range is the tail', suffix.body.equals(payload.slice(-500)));

  const past = await req(port, '/media?p=' + enc, { Range: 'bytes=200000-200100' });
  eq('range past the end is 416', past.status, 416);

  /* reassemble the whole file from ranges, as a player seeking around would */
  const chunks = [];
  for (let start = 0; start < payload.length; start += 7000){
    const end = Math.min(start + 6999, payload.length - 1);
    const r = await req(port, '/media?p=' + enc, { Range: 'bytes=' + start + '-' + end });
    chunks.push(r.body);
  }
  ok('file reassembled from ranges is byte-identical', Buffer.concat(chunks).equals(payload));

  const escape = await req(port, '/../package.json');
  eq('traversal cannot reach package.json', escape.status, 404);
  const src = await req(port, '/electron/main.js');
  eq('main-process sources are not served', src.status, 404);
  const appjs = await req(port, '/app.js');
  eq('the app itself is served', appjs.status, 200);

  srv.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures ? '\n' + failures + ' FAILURE(S)\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
