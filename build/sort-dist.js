'use strict';
/*
 * Sorts the build output into one folder per artifact, so the installer and the
 * portable exe are never mistaken for one another:
 *
 *   dist/
 *     installer/   Video Notes Setup <version>.exe, its blockmap, latest.yml
 *     portable/    VideoNotes-<version>-portable.exe
 *     win-unpacked/, builder-debug.yml     build intermediates, left where they are
 *
 * Run by `npm run dist` after electron-builder finishes. Doing it afterwards rather
 * than through a builder hook means latest.yml already exists by the time we look.
 *
 * Deliberately conservative: it moves only files it recognises by name, never
 * touches a directory, and leaves anything it does not recognise alone. A portable
 * build keeps its notes in a `Notes` folder beside the exe, so an unknown folder
 * here may well be someone's work.
 */

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

/* file name -> the folder it belongs in */
const RULES = [
  { dir: 'installer', test: (n) => /setup.*\.exe$/i.test(n) },
  { dir: 'installer', test: (n) => /setup.*\.exe\.blockmap$/i.test(n) },
  { dir: 'installer', test: (n) => /^latest.*\.yml$/i.test(n) },
  { dir: 'portable',  test: (n) => /portable\.exe$/i.test(n) }
];

function main(){
  if (!fs.existsSync(DIST)){
    console.log('no dist folder - nothing to sort');
    return;
  }

  const moved = [];
  for (const entry of fs.readdirSync(DIST, { withFileTypes: true })){
    if (!entry.isFile()) continue;              /* never touch a folder */
    const rule = RULES.find((r) => r.test(entry.name));
    if (!rule) continue;

    const target = path.join(DIST, rule.dir);
    fs.mkdirSync(target, { recursive: true });
    const to = path.join(target, entry.name);
    /* rename cannot cross a device here, but an existing file would stop it */
    if (fs.existsSync(to)) fs.rmSync(to);
    fs.renameSync(path.join(DIST, entry.name), to);
    moved.push(rule.dir + '/' + entry.name);
  }

  if (!moved.length){
    console.log('dist: nothing to sort (already sorted?)');
    return;
  }
  console.log('dist:');
  for (const m of moved) console.log('  ' + m);
}

main();
