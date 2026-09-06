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

  /* ---------- deleting a session ---------- */
  console.log('\ndeleting a whole session');
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-synctest-del-'));
  const a1 = new FolderStore(shared, 'carel-7f3a');
  const b1 = new FolderStore(shared, 'marius-2b91');
  a1.set('vnotes:index', JSON.stringify([{ key: 'vnotes:shared.mp4_4', customName: 'Shared' }]));
  a1.set('vnotes:shared.mp4_4', JSON.stringify([{ id: 'a1', time: 1, text: 'mine' }]));
  b1.set('vnotes:shared.mp4_4', JSON.stringify(
    JSON.parse(b1.get('vnotes:shared.mp4_4')).concat([{ id: 'b1', time: 2, text: 'theirs' }])));

  const sharedDir = path.join(shared, 'Shared');
  eq('both coaches have notes in the session before deleting',
     JSON.parse(a1.get('vnotes:shared.mp4_4')).length, 2);

  a1.delete('vnotes:shared.mp4_4');
  ok('the deleting coach\'s own file is gone',
     !fs.existsSync(path.join(sharedDir, 'notes.carel-7f3a.json')),
     fs.readdirSync(sharedDir).join(', '));
  ok('the other coach\'s file is untouched',
     fs.existsSync(path.join(sharedDir, 'notes.marius-2b91.json')),
     fs.readdirSync(sharedDir).join(', '));
  ok('and the folder stays, because their work is still in it',
     fs.existsSync(sharedDir));
  eq('what is left is only their note',
     JSON.parse(b1.get('vnotes:shared.mp4_4')).length, 1);

  /* the last coach out takes the folder with them */
  b1.delete('vnotes:shared.mp4_4');
  ok('once nobody has notes in it, the folder goes', !fs.existsSync(sharedDir), sharedDir);

  fs.rmSync(shared, { recursive: true, force: true });

  /* ---------- moving a session into another vault ---------- */
  /*
   * The check that earns its keep: the session being moved has two coaches' files in it.
   * Reading it out of one store and writing it into the other would keep only the
   * current coach's notes whole and reduce the other's to a stub, so his work would go
   * missing. The move copies the directory, which takes everyone's files with it.
   */
  console.log('\nmoving a session between vaults');
  const { Vaults } = require('./vaults');
  const { VaultStore } = require('./vaultstore');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-move-home-'));
  const squad = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-move-squad-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-move-cfg-'));

  const vs = new Vaults(userData, home);
  const squadVault = vs.add(squad, 'Squad').vault;
  const store = new VaultStore(vs, path.join(userData, 'prefs.json'));
  store.setAuthor('carel-7f3a');

  const MK = 'vnotes:move.mp4_7';
  store.set('vnotes:index', JSON.stringify([
    { key: MK, kind: 'file', customName: 'Moving session', vault: vs.first().id }
  ]));
  store.set(MK, JSON.stringify([{ id: 'm1', time: 1, text: 'mine', 
    image: 'data:image/png;base64,iVBORw0KGgo=' }]));

  /* a second coach's file, written straight into the same session folder */
  const srcDir = store.storeFor(vs.first().id).sessionPath(MK);
  fs.writeFileSync(path.join(srcDir, 'notes.marius-2b91.json'), JSON.stringify({
    key: MK, author: 'marius-2b91',
    notes: [{ id: 'm2', time: 5, text: 'theirs', by: 'marius-2b91' }]
  }));
  eq('both coaches have notes in it before the move',
     JSON.parse(store.get(MK)).length, 2);

  const moved = store.moveSessionToVault(MK, squadVault.id, 'Nationals');
  ok('the move reports success', moved.ok, JSON.stringify(moved));
  ok('the session is gone from the vault it left', !fs.existsSync(srcDir), srcDir);

  const landed = path.join(squad, 'Nationals', 'Moving session');
  ok('and is in the one it went to', fs.existsSync(landed), landed);
  ok('the other coach\'s file came with it',
     fs.existsSync(path.join(landed, 'notes.marius-2b91.json')),
     fs.readdirSync(landed).join(', '));
  ok('so did the drawings',
     fs.existsSync(path.join(landed, 'drawings')) &&
     fs.readdirSync(path.join(landed, 'drawings')).length > 0);

  eq('and both coaches\' notes read back from the new vault',
     JSON.parse(store.get(moved.key) || '[]').length, 2);

  /* the same session in both vaults is a merge, not a move */
  store.set(MK, JSON.stringify([{ id: 'm9', time: 2, text: 'a fresh one' }]));
  const refused = store.moveSessionToVault(MK, squadVault.id, '');
  ok('moving onto a session the other vault already has is refused',
     !refused.ok && refused.reason === 'exists', JSON.stringify(refused));
  eq('and nothing was taken from the source', JSON.parse(store.get(MK)).length, 1);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(squad, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });

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

  /*
   * One session, two folders.
   *
   * A vault copied by hand, or a folder moved while a copy stayed behind, leaves two
   * directories carrying the same key. rescan used to keep whichever it walked last,
   * so the notes in the other one were on disk and invisible - which is how five notes
   * went missing from a real vault without anything appearing to be wrong.
   */
  console.log('\none session, two folders');

  const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-duptest-'));
  const DKEY = 'vnotes:linc.mp4_7';

  const writeNotes = (dir, notes) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.carel-7f3a.json'), JSON.stringify({
      key: DKEY, author: 'carel-7f3a', saved: new Date().toISOString(), notes: notes
    }, null, 2));
  };

  /* the folder the store will write to: walked first, so it becomes canonical */
  writeNotes(path.join(dupRoot, 'Linc'), [
    { id: 'a', time: 1, text: 'in both', by: 'carel-7f3a' },
    { id: 'b', time: 2, text: 'in both too', by: 'carel-7f3a' }
  ]);
  /* the copy left behind, with a note the first one has never had */
  const nested = path.join(dupRoot, 'Sub kings', 'Linc');
  writeNotes(nested, [
    { id: 'a', time: 1, text: 'in both', by: 'carel-7f3a' },
    { id: 'c', time: 3, text: 'only in the second folder', by: 'carel-7f3a',
      image: { file: 'pic.png' } }
  ]);
  fs.mkdirSync(path.join(nested, 'drawings'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'drawings', 'pic.png'), Buffer.from([1, 2, 3, 4]));

  const dup = new FolderStore(dupRoot, 'carel-7f3a');
  const dupNotes = () => JSON.parse(dup.get(DKEY) || '[]');

  eq('both folders are found for the one key', dup.duplicateDirs(DKEY).length, 1);
  eq('reading gives every note from both', dupNotes().length, 3);
  ok('including the one only the second folder has',
     !!byId(dupNotes(), 'c'), JSON.stringify(dupNotes().map((n) => n.id)));
  ok('and its drawing, which lives in that folder too',
     /^data:image\/png;base64,/.test((byId(dupNotes(), 'c') || {}).image || ''),
     JSON.stringify((byId(dupNotes(), 'c') || {}).image));

  /* The write goes to one folder. What must not happen is the other folder's notes
     being read as deletions and tombstoned, which is what diffing against a single
     folder would have done. */
  dup.set(DKEY, JSON.stringify(dupNotes()));
  eq('saving keeps all three', dupNotes().length, 3);
  ok('and wrote no tombstones', !fs.existsSync(path.join(dupRoot, 'Linc', 'deleted.carel-7f3a.json')) &&
     !fs.existsSync(path.join(nested, 'deleted.carel-7f3a.json')));

  /* Deleting still has to work, across both folders. */
  dup.set(DKEY, JSON.stringify(dupNotes().filter((n) => n.id !== 'c')));
  eq('deleting a note that came from the other folder sticks', dupNotes().length, 2);
  ok('and it stays gone on a fresh open',
     new FolderStore(dupRoot, 'carel-7f3a').get(DKEY).indexOf('"c"') < 0);

  /* ...and undeleting, which is the half that is easy to forget. */
  dup.set(DKEY, JSON.stringify(dupNotes().concat([{ id: 'c', time: 3, text: 'back', by: 'carel-7f3a' }])));
  eq('restoring it brings it back', dupNotes().length, 3);

  /*
   * The index written before there was one per coach is a snapshot, not a record. It
   * must lose a tie, or a session nobody has opened since - which is precisely when the
   * timestamps match - stays pinned to the folder it was in back then.
   */
  console.log('\nthe old index does not outrank a coach');

  const tieRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-tietest-'));
  const TKEY = 'vnotes:tie.mp4_9';
  fs.writeFileSync(path.join(tieRoot, 'library.json'), JSON.stringify([
    { key: TKEY, customName: 'Tie', lastOpened: 1000 }
  ]));
  fs.writeFileSync(path.join(tieRoot, 'library.carel-7f3a.json'), JSON.stringify([
    { key: TKEY, customName: 'Tie', folder: 'Comp 2026', lastOpened: 1000 }
  ]));
  const tie = new FolderStore(tieRoot, 'carel-7f3a');
  const tieEntry = JSON.parse(tie.get('vnotes:index') || '[]')[0] || {};
  eq('on an equal timestamp the coach index wins, not the old one', tieEntry.folder, 'Comp 2026');

  fs.writeFileSync(path.join(tieRoot, 'library.json'), JSON.stringify([
    { key: TKEY, customName: 'Tie', folder: 'Older', lastOpened: 5000 }
  ]));
  const tie2 = new FolderStore(tieRoot, 'carel-7f3a');
  const tieEntry2 = JSON.parse(tie2.get('vnotes:index') || '[]')[0] || {};
  eq('but a genuinely newer entry still wins', tieEntry2.folder, 'Older');
  fs.rmSync(tieRoot, { recursive: true, force: true });

  /* A tombstone in the folder that is not written to still has to be cleared when the
     note comes back, or the restore would last exactly one read. */
  fs.writeFileSync(path.join(nested, 'deleted.carel-7f3a.json'), JSON.stringify(['b']));
  eq('a tombstone in the other folder hides the note', dupNotes().length, 2);
  dup.set(DKEY, JSON.stringify(dupNotes().concat([{ id: 'b', time: 2, text: 'back too', by: 'carel-7f3a' }])));
  eq('restoring it clears the tombstone in that folder too', dupNotes().length, 3);
  ok('and it survives a fresh open',
     JSON.parse(new FolderStore(dupRoot, 'carel-7f3a').get(DKEY) || '[]').length === 3);

  /* Trash and summaries live in folders too. */
  fs.writeFileSync(path.join(nested, 'trash.carel-7f3a.json'),
    JSON.stringify([{ id: 'z', deleted: 1, text: 'binned' }]));
  ok('trash in the second folder is listed by keys()',
     dup.keys().indexOf('vnotes:trash:' + DKEY) >= 0, dup.keys().join(', '));
  ok('and can be read', (dup.get('vnotes:trash:' + DKEY) || '').indexOf('binned') >= 0);

  fs.writeFileSync(path.join(nested, 'summary.marius-2b91.md'), 'their summary');
  ok('a summary only the second folder has is found',
     (dup.get('vnotes:summary:' + DKEY) || '').indexOf('their summary') >= 0,
     String(dup.get('vnotes:summary:' + DKEY)));

  /* Deleting the session must clear this coach out of both folders, or the copy left
     behind would put the notes back on the next read. */
  dup.delete(DKEY);
  ok('deleting the session empties both folders',
     !fs.existsSync(path.join(dupRoot, 'Linc')) && !fs.existsSync(nested),
     'Linc: ' + fs.existsSync(path.join(dupRoot, 'Linc')) + ', nested: ' + fs.existsSync(nested));
  ok('and it reads back as gone', dup.get(DKEY) === null, String(dup.get(DKEY)));

  fs.rmSync(dupRoot, { recursive: true, force: true });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });

  console.log(failures ? '\n' + failures + ' FAILURE(S)\n' : '\nsync checks passed\n');
  process.exit(failures ? 1 : 0);
}

main();
