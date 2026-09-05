'use strict';
/*
 * Two coaches sharing one vault.
 *
 *   node electron/synctest.js
 *
 * No Electron and no cloud: two FolderStore instances with different authors over one
 * folder are exactly what two laptops pointed at the same Drive folder look like to
 * this code. What is being proved is that neither ever writes the other's file, and
 * that reading gives you both.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { FolderStore } = require('./folderstore');

let failures = 0;
function ok(name, cond, detail){
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, a, b){ ok(name, a === b, JSON.stringify(a) + ' != ' + JSON.stringify(b)); }

const KEY = 'vnotes:jack.mp4_100';
const notesOf = (store) => JSON.parse(store.get(KEY) || '[]');
const byId = (list, id) => list.filter((n) => n.id === id)[0];

/* whichever files exist in the one session folder */
function sessionFiles(root){
  const dir = path.join(root, 'Jack round 1');
  try { return fs.readdirSync(dir).sort(); } catch (e) { return []; }
}

function main(){
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-synctest-'));

  /* both coaches point at the same folder, as they would through Drive */
  const carel = new FolderStore(root, 'carel-7f3a');
  carel.set('vnotes:index', JSON.stringify([
    { key: KEY, kind: 'file', label: 'jack.mp4', customName: 'Jack round 1' }
  ]));

  console.log('\ntwo coaches, one vault');

  /* ---------- Carel writes ---------- */
  carel.set(KEY, JSON.stringify([
    { id: 'n1', time: 12, text: 'head is outside your base', author: 'Carel',
      comments: [{ id: 'c1', author: 'Carel', text: 'head is outside your base', at: 1 }],
      image: 'data:image/png;base64,iVBORw0KGgo=' }
  ]));

  let files = sessionFiles(root);
  ok('a coach writes only their own notes file',
     files.indexOf('notes.carel-7f3a.json') >= 0 && files.indexOf('session.json') < 0,
     files.join(', '));
  ok('the drawing is named for its note, not its position',
     fs.existsSync(path.join(root, 'Jack round 1', 'drawings', 'n1.png')),
     fs.readdirSync(path.join(root, 'Jack round 1', 'drawings')).join(', '));

  /* ---------- Marius opens the same folder ---------- */
  const marius = new FolderStore(root, 'marius-2b91');
  let seen = notesOf(marius);
  eq('the other coach sees the session without importing anything', seen.length, 1);
  eq('and the note reads as written', seen[0].text, 'head is outside your base');

  /* he comments on Carel's note and adds one of his own */
  seen[0].comments.push({ id: 'c2', author: 'Marius', text: 'agree, and the grip is late', at: 2 });
  seen.push({ id: 'n2', time: 40, text: 'watch the far side', author: 'Marius',
              comments: [{ id: 'c3', author: 'Marius', text: 'watch the far side', at: 3 }] });
  marius.set(KEY, JSON.stringify(seen));

  files = sessionFiles(root);
  ok('the second coach gets a file of their own',
     files.indexOf('notes.marius-2b91.json') >= 0, files.join(', '));

  /* the crux: neither file contains the other's work */
  const carelFile = JSON.parse(fs.readFileSync(path.join(root, 'Jack round 1', 'notes.carel-7f3a.json'), 'utf8'));
  const mariusFile = JSON.parse(fs.readFileSync(path.join(root, 'Jack round 1', 'notes.marius-2b91.json'), 'utf8'));

  eq('the first coach\'s file still holds only their note', carelFile.notes.length, 1);
  eq('and only their comment on it', carelFile.notes[0].comments.length, 1);
  ok('the second coach\'s file holds his own note and a stub for the other',
     mariusFile.notes.length === 2 &&
     mariusFile.notes.some((n) => n.id === 'n1' && n.stub && n.comments.length === 1) &&
     mariusFile.notes.some((n) => n.id === 'n2' && !n.stub),
     JSON.stringify(mariusFile.notes.map((n) => n.id + (n.stub ? ':stub' : ''))));
  ok('the stub carries no copy of the other coach\'s text',
     !byId(mariusFile.notes, 'n1').text, JSON.stringify(byId(mariusFile.notes, 'n1')));

  /* ---------- Carel reads back ---------- */
  const back = notesOf(new FolderStore(root, 'carel-7f3a'));
  eq('reading gives both coaches\' notes', back.length, 2);
  const n1 = byId(back, 'n1');
  eq('the note keeps its own text', n1.text, 'head is outside your base');
  eq('with both comments on it', n1.comments.length, 2);
  ok('each comment keeps its author',
     n1.comments.map((c) => c.author).sort().join() === 'Carel,Marius',
     JSON.stringify(n1.comments.map((c) => c.author)));
  ok('the drawing survives the round trip',
     typeof n1.image === 'string' && n1.image.indexOf('data:image/png') === 0);

  /* saving again must not duplicate the other coach's comment into my file */
  carel.set(KEY, JSON.stringify(back));
  const carelAgain = JSON.parse(fs.readFileSync(path.join(root, 'Jack round 1', 'notes.carel-7f3a.json'), 'utf8'));
  eq('re-saving does not pull the other coach\'s comment into my file',
     carelAgain.notes[0].comments.length, 1);
  eq('and the merged view is still right', notesOf(carel).length, 2);
  eq('with the thread still whole', byId(notesOf(carel), 'n1').comments.length, 2);

  /* ---------- deleting travels ---------- */
  console.log('\ndeleting');
  const afterDelete = notesOf(carel).filter((n) => n.id !== 'n2');
  carel.set(KEY, JSON.stringify(afterDelete));
  ok('a deletion is recorded as a tombstone',
     fs.existsSync(path.join(root, 'Jack round 1', 'deleted.carel-7f3a.json')));
  eq('the other coach\'s note is gone for both of them', notesOf(marius).length, 1);
  ok('though their own file still has it, so nothing was destroyed',
     JSON.parse(fs.readFileSync(path.join(root, 'Jack round 1', 'notes.marius-2b91.json'), 'utf8'))
       .notes.some((n) => n.id === 'n2'));

  /* ---------- a session written before any of this ---------- */
  console.log('\nolder sessions and forked files');
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-synctest-old-'));
  fs.mkdirSync(path.join(legacyRoot, 'Old session'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'library.json'), JSON.stringify([
    { key: 'vnotes:old.mp4_5', kind: 'file', customName: 'Old session' }
  ]));
  fs.writeFileSync(path.join(legacyRoot, 'Old session', 'session.json'), JSON.stringify({
    key: 'vnotes:old.mp4_5',
    notes: [{ id: 'o1', time: 3, text: 'written before any of this' }]
  }));
  const upgraded = new FolderStore(legacyRoot, 'carel-7f3a');
  let old = JSON.parse(upgraded.get('vnotes:old.mp4_5') || '[]');
  eq('a session.json from before still reads', old.length, 1);

  old.push({ id: 'o2', time: 9, text: 'and one added after' });
  upgraded.set('vnotes:old.mp4_5', JSON.stringify(old));
  ok('the old file is left exactly where it was',
     fs.existsSync(path.join(legacyRoot, 'Old session', 'session.json')));
  eq('and both notes read back',
     JSON.parse(upgraded.get('vnotes:old.mp4_5')).length, 2);

  /* a fork the sync tool made because it could not merge */
  fs.writeFileSync(
    path.join(root, 'Jack round 1', "notes.marius-2b91 (Marius's conflicted copy 2026-09-05).json"),
    JSON.stringify({ key: KEY, notes: [
      { id: 'n9', time: 88, text: 'only in the forked copy', by: 'marius-2b91' }
    ] }));
  ok('a file the sync tool forked off is read too, not ignored',
     notesOf(carel).some((n) => n.id === 'n9'),
     JSON.stringify(notesOf(carel).map((n) => n.id)));

  /* ---------- the index is per coach as well ---------- */
  console.log('\nthe session index');
  marius.set('vnotes:index', JSON.stringify([
    { key: KEY, kind: 'file', customName: 'Jack round 1', lastOpened: 200 },
    { key: 'vnotes:only-his.mp4_7', kind: 'file', customName: 'His own session', lastOpened: 100 }
  ]));
  const rootFiles = fs.readdirSync(root).sort();
  ok('each coach keeps their own index file',
     rootFiles.indexOf('library.carel-7f3a.json') >= 0 &&
     rootFiles.indexOf('library.marius-2b91.json') >= 0, rootFiles.join(', '));
  const lib = JSON.parse(carel.get('vnotes:index'));
  ok('and reading gives every coach\'s sessions',
     lib.length === 2 && lib.some((e) => e.key === 'vnotes:only-his.mp4_7'),
     JSON.stringify(lib.map((e) => e.key)));

  /* ---------- a session another coach created, found by scanning ---------- */
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-synctest-scan-'));
  fs.mkdirSync(path.join(fresh, 'Theirs'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'Theirs', 'notes.marius-2b91.json'), JSON.stringify({
    key: 'vnotes:theirs.mp4_3',
    notes: [{ id: 't1', time: 1, text: 'made on the other laptop', by: 'marius-2b91' }]
  }));
  const scanning = new FolderStore(fresh, 'carel-7f3a');
  eq('a session only the other coach has is found by scanning, with no paths.json',
     JSON.parse(scanning.get('vnotes:theirs.mp4_3') || '[]').length, 1);
  ok('and it is listed by keys()',
     scanning.keys().indexOf('vnotes:theirs.mp4_3') >= 0, scanning.keys().join(', '));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });

  console.log(failures ? '\n' + failures + ' FAILURE(S)\n' : '\nsync checks passed\n');
  process.exit(failures ? 1 : 0);
}

main();
