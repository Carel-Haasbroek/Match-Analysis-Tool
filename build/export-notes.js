'use strict';
/*
 * Export a Notes folder to the same backup file the app's "Export all notes" button
 * writes, so it can be imported back through the app's own restore path.
 *
 *   node build/export-notes.js "<path to a Notes folder>" "<output.json>"
 *
 * Read-only on the source: it opens the folder with FolderStore and writes one file
 * somewhere else. Use it to pull notes out of a copy of the app you no longer run.
 */

const fs = require('fs');
const path = require('path');

const { FolderStore } = require('../electron/folderstore');

const LIB_KEY = 'vnotes:index';
const SUMMARY_PREFIX = 'vnotes:summary:';
const TRASH_PREFIX = 'vnotes:trash:';

/* the same shape the renderer checks before it will merge anything */
function isNoteList(v){
  return Array.isArray(v) && v.every((n) =>
    n && typeof n === 'object' && typeof n.id !== 'undefined' && typeof n.time === 'number');
}

function parse(raw){
  if (raw == null) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return null; }
}

function main(){
  const source = process.argv[2];
  const out = process.argv[3];
  if (!source || !out){
    console.error('usage: node build/export-notes.js "<Notes folder>" "<output.json>"');
    process.exit(2);
  }
  if (!fs.existsSync(source)){
    console.error('no such folder: ' + source);
    process.exit(1);
  }

  const store = new FolderStore(source);
  const videos = {}, summaries = {};
  let notes = 0, sessions = 0;

  for (const key of store.keys()){
    if (key.indexOf('vnotes:') !== 0) continue;
    if (key === LIB_KEY || key.indexOf(TRASH_PREFIX) === 0) continue;

    const value = parse(store.get(key));
    if (key.indexOf(SUMMARY_PREFIX) === 0){
      if (value && typeof value.text === 'string' && value.text.trim()) summaries[key] = value;
      continue;
    }
    if (isNoteList(value) && value.length){
      videos[key] = value;
      notes += value.length;
      sessions++;
    }
  }

  const library = parse(store.get(LIB_KEY));
  const payload = {
    format: 'video-notes-backup', version: 1,
    saved: new Date().toISOString(),
    library: Array.isArray(library) ? library : [],
    videos: videos,
    summaries: summaries
  };

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(source);
  console.log('  ' + sessions + ' sessions, ' + notes + ' notes, ' +
              Object.keys(summaries).length + ' summaries -> ' + out);
}

main();
