'use strict';
/*
 * Where the notes folder lives, and moving existing notes into it.
 *
 * One folder, the same one for every build. This used to be resolved - beside a
 * portable exe, beside an installed one, or the project when run from source - which
 * meant each copy of the app quietly kept its own separate notes. Installing the app
 * while also running the portable build produced three sets that drifted apart within
 * the hour. A fixed location cannot do that.
 */

const fs = require('fs');
const path = require('path');

const { FolderStore } = require('./folderstore');
const { Store } = require('./store');

/*
 * Returns { dir, kind }. Still a folder tree you can open and read - browsable
 * sessions, markdown summaries, PNG drawings - just always in the same place. The
 * app shows the path on its home screen and opens it on click, so it stays findable.
 */
function resolveDataDir(app){
  const dir = path.join(app.getPath('userData'), 'Notes');
  fs.mkdirSync(dir, { recursive: true });
  return { dir: dir, kind: 'appdata' };
}

/*
 * Move notes out of the old base64-blob store, once.
 *
 * The old store is never deleted and a backup is written first: this runs against
 * work that cannot be recreated, so it errs entirely toward leaving copies behind.
 */
function migrateIfNeeded(oldStoreDir, folderStore, log){
  const say = log || function(){};
  if (!fs.existsSync(oldStoreDir)) return { migrated: 0, skipped: 'no old store' };
  if (folderStore.keys().length) return { migrated: 0, skipped: 'new folder already has notes' };

  const old = new Store(oldStoreDir);
  const keys = old.keys();
  if (!keys.length) return { migrated: 0, skipped: 'old store empty' };

  /* a single-file snapshot of everything, before touching anything */
  const backupDir = path.join(path.dirname(oldStoreDir), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const snapshot = {};
  let noteTotal = 0;
  for (const k of keys){
    const v = old.get(k);
    snapshot[k] = v;
    if (/^vnotes:(?!index$|prefs$|summary:|trash:)/.test(k)){
      try { noteTotal += (JSON.parse(v) || []).length; } catch (e) {}
    }
  }
  const backupFile = path.join(backupDir,
    'pre-migration-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json');
  fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2));
  say('backup written: ' + backupFile);

  /* index first, so session folders get their real names rather than raw keys */
  const ordered = keys.slice().sort((a, b) => (a === 'vnotes:index' ? -1 : b === 'vnotes:index' ? 1 : 0));
  let moved = 0;
  for (const k of ordered){
    try { folderStore.set(k, snapshot[k]); moved++; }
    catch (e) { say('could not migrate ' + k + ': ' + e.message); }
  }

  /* count the notes back out of the new store and compare */
  let after = 0;
  for (const k of folderStore.keys()){
    if (!/^vnotes:(?!index$|prefs$|summary:|trash:)/.test(k)) continue;
    try { after += (JSON.parse(folderStore.get(k)) || []).length; } catch (e) {}
  }

  return {
    migrated: moved,
    notesBefore: noteTotal,
    notesAfter: after,
    intact: noteTotal === after,
    backup: backupFile
  };
}

module.exports = { resolveDataDir, migrateIfNeeded };
