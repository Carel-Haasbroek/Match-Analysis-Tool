'use strict';
/*
 * Checks for the folder store and the migration into it.
 *
 *   node electron/storetest.js            synthetic data only
 *   node electron/storetest.js --real     also migrates a COPY of the real store
 *
 * The --real pass copies %APPDATA%/video-notes/store to a temp folder first and
 * works only on the copy. The original is opened read-only, never written.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { FolderStore } = require('./folderstore');
const { Store } = require('./store');
const { migrateIfNeeded } = require('./datadir');

let failures = 0;
function ok(name, cond, detail){
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, a, b){ ok(name, a === b, JSON.stringify(a) + ' != ' + JSON.stringify(b)); }

/* a tiny valid PNG, so image extraction has something real to move */
function pngDataUrl(seed){
  function crc(buf){
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++){
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data){
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((2 * 4 + 1) * 2);
  raw.fill(seed % 251);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

function main(){
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-storetest-'));

  /* ---------------- folder store ---------------- */
  console.log('\nfolder store');
  const root = path.join(tmp, 'Notes');
  const fsx = new FolderStore(root);

  fsx.set('vnotes:index', JSON.stringify([
    { key: 'vnotes:Jack_1.mp4_65939131', kind: 'file', label: 'Jack_1.mp4', customName: 'Jack round 1' },
    { key: 'vnotes:yt:abcdefghijk', kind: 'youtube', label: 'A YouTube match' }
  ]));

  const notes = [
    { id: 'a', time: 12.4, text: 'guard pass', image: pngDataUrl(1), shapes: [{ tool: 'rect' }] },
    { id: 'b', time: 65.9, text: '', image: pngDataUrl(2), overlayImage: pngDataUrl(3) }
  ];
  fsx.set('vnotes:Jack_1.mp4_65939131', JSON.stringify(notes));
  fsx.set('vnotes:summary:vnotes:Jack_1.mp4_65939131',
    JSON.stringify({ text: 'Solid round.', updated: 1756900000000 }));

  const back = JSON.parse(fsx.get('vnotes:Jack_1.mp4_65939131'));
  eq('notes round-trip: count', back.length, 2);
  eq('note text survives', back[0].text, 'guard pass');
  eq('drawing comes back as a data url', back[0].image, notes[0].image);
  eq('the second image field survives too', back[1].overlayImage, notes[1].overlayImage);
  ok('shapes survive', JSON.stringify(back[0].shapes) === JSON.stringify(notes[0].shapes));

  /* the point of the exercise: is it actually browsable */
  const dir = path.join(root, 'Jack round 1');
  ok('session folder is named for the session', fs.existsSync(dir), dir);
  ok('session.json is small and readable',
     fs.statSync(path.join(dir, 'session.json')).size < 2000);
  const drawings = fs.readdirSync(path.join(dir, 'drawings'));
  eq('drawings written as separate files', drawings.length, 3);
  ok('drawings are real PNGs', drawings.every((f) => {
    const b = fs.readFileSync(path.join(dir, 'drawings', f));
    return b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG';
  }), drawings.join(', '));
  ok('drawing filenames carry their timestamp', drawings.some((f) => f.indexOf('12-400') >= 0),
     drawings.join(', '));
  eq('summary is markdown on disk',
     fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), 'Solid round.');
  eq('summary round-trips with its timestamp',
     JSON.parse(fsx.get('vnotes:summary:vnotes:Jack_1.mp4_65939131')).updated, 1756900000000);

  /* deleting a note should reclaim its drawing */
  fsx.set('vnotes:Jack_1.mp4_65939131', JSON.stringify([notes[0]]));
  eq('removing a note drops its drawing file',
     fs.readdirSync(path.join(dir, 'drawings')).length, 1);

  /* grouping = moving the folder */
  ok('a session can be moved into a group', fsx.moveSession('vnotes:Jack_1.mp4_65939131', 'Competition 2026'));
  ok('it lives in the group folder now',
     fs.existsSync(path.join(root, 'Competition 2026', 'Jack round 1', 'session.json')));
  eq('and still reads back after the move',
     JSON.parse(fsx.get('vnotes:Jack_1.mp4_65939131')).length, 1);
  ok('nested groups work', fsx.moveSession('vnotes:Jack_1.mp4_65939131', 'Competition 2026/Nationals'));
  eq('still readable when nested',
     JSON.parse(fsx.get('vnotes:Jack_1.mp4_65939131')).length, 1);

  eq('keys() lists what is there', fsx.keys().sort().join(','),
     ['vnotes:index', 'vnotes:Jack_1.mp4_65939131', 'vnotes:summary:vnotes:Jack_1.mp4_65939131'].sort().join(','));

  /* a name that would be illegal as a folder */
  fsx.set('vnotes:index', JSON.stringify([
    { key: 'vnotes:odd', kind: 'file', customName: 'A/B: "test" <clip>' }
  ]));
  fsx.set('vnotes:odd', JSON.stringify([{ id: 'z', time: 1, text: 'x' }]));
  eq('an unsafe name is still stored and read back',
     JSON.parse(fsx.get('vnotes:odd')).length, 1);
  ok('and produced a legal folder name',
     Object.values(fsx.paths).every((p) => !/[\\/:*?"<>|]/.test(path.basename(p))),
     JSON.stringify(fsx.paths));

  /* moving back out must not invent a folder from the empty path */
  ok('a session can be moved back to the top level', fsx.moveSession('vnotes:Jack_1.mp4_65939131', ''));
  ok('and lands at the top level, not in a folder called session',
     fs.existsSync(path.join(root, 'Jack round 1', 'session.json')) &&
     !fs.existsSync(path.join(root, 'session')),
     JSON.stringify(fsx.paths));
  eq('still readable at the top level',
     JSON.parse(fsx.get('vnotes:Jack_1.mp4_65939131')).length, 1);

  /* a key that is not a session must not break the store */
  fsx.set('vn:smoke', JSON.stringify({ hello: 'world' }));
  eq('a non-session key round-trips', fsx.get('vn:smoke'), JSON.stringify({ hello: 'world' }));
  ok('and is listed by keys()', fsx.keys().indexOf('vn:smoke') >= 0, fsx.keys().join(','));
  ok('without creating a bogus session folder',
     !fs.existsSync(path.join(root, 'vn smoke', 'session.json')));

  /* survives a restart */
  const reopened = new FolderStore(root);
  eq('reopening finds the moved session',
     JSON.parse(reopened.get('vnotes:Jack_1.mp4_65939131')).length, 1);

  /* ---------------- migration ---------------- */
  console.log('\nmigration from the old store');
  const oldDir = path.join(tmp, 'old', 'store');
  const oldStore = new Store(oldDir);
  oldStore.set('vnotes:index', JSON.stringify([
    { key: 'vnotes:m1', kind: 'file', label: 'match one.mp4', customName: 'Match one' }
  ]));
  oldStore.set('vnotes:m1', JSON.stringify([
    { id: 'p', time: 3, text: 'one', image: pngDataUrl(7) },
    { id: 'q', time: 9, text: 'two', image: pngDataUrl(8) }
  ]));
  oldStore.set('vnotes:summary:vnotes:m1', JSON.stringify({ text: 'notes on match one', updated: 1 }));
  oldStore.set('vnotes:prefs', JSON.stringify({ overlayHold: 1 }));

  const target = new FolderStore(path.join(tmp, 'Notes2'));
  const res = migrateIfNeeded(oldDir, target, function(){});
  eq('every key migrated', res.migrated, 4);
  eq('note count is unchanged', res.notesAfter, res.notesBefore);
  ok('migration reports intact', res.intact, JSON.stringify(res));
  ok('a backup was written first', fs.existsSync(res.backup), res.backup);
  ok('the old store is left untouched', oldStore.keys().length === 4);
  eq('a migrated note keeps its drawing',
     JSON.parse(target.get('vnotes:m1'))[0].image, pngDataUrl(7));
  eq('the migrated summary survives',
     JSON.parse(target.get('vnotes:summary:vnotes:m1')).text, 'notes on match one');
  ok('migrated session uses its real name',
     fs.existsSync(path.join(tmp, 'Notes2', 'Match one', 'session.json')));

  const again = migrateIfNeeded(oldDir, target, function(){});
  eq('migration does not run twice', again.migrated, 0);

  fs.rmSync(tmp, { recursive: true, force: true });

  /* ---------------- optional: a copy of the real store ---------------- */
  if (process.argv.indexOf('--real') >= 0){
    console.log('\nmigration of a COPY of the real store');
    const realDir = path.join(process.env.APPDATA || '', 'video-notes', 'store');
    if (!fs.existsSync(realDir)){
      console.log('  (no real store found, skipped)');
    } else {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-realcopy-'));
      const copyDir = path.join(sandbox, 'store');
      fs.mkdirSync(copyDir, { recursive: true });
      for (const f of fs.readdirSync(realDir)){
        fs.copyFileSync(path.join(realDir, f), path.join(copyDir, f));
      }
      const before = new Store(copyDir);
      const beforeKeys = before.keys().length;

      const out = new FolderStore(path.join(sandbox, 'Notes'));
      const r = migrateIfNeeded(copyDir, out, function(m){ console.log('  ' + m); });
      eq('all real keys migrated', r.migrated, beforeKeys);
      ok('every real note survived: ' + r.notesBefore + ' -> ' + r.notesAfter, r.intact,
         JSON.stringify({ before: r.notesBefore, after: r.notesAfter }));

      const sizeOf = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
        const p = path.join(d, e.name);
        return n + (e.isDirectory() ? sizeOf(p) : fs.statSync(p).size);
      }, 0);
      const oldSize = sizeOf(copyDir), newSize = sizeOf(path.join(sandbox, 'Notes'));
      console.log('  size: ' + Math.round(oldSize / 1024) + ' KB -> ' +
                  Math.round(newSize / 1024) + ' KB (' +
                  Math.round((1 - newSize / oldSize) * 100) + '% smaller)');
      console.log('  folders created:');
      for (const e of fs.readdirSync(path.join(sandbox, 'Notes'), { withFileTypes: true })){
        if (e.isDirectory()) console.log('    ' + e.name);
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }

  console.log(failures ? '\n' + failures + ' FAILURE(S)\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main();
