'use strict';
/*
 * One file per key under <userData>/store/.
 *
 * Per-key files rather than one blob: a single document would rewrite every note's
 * base64 image on each save, and one bad write would take the whole library with it.
 *
 * Every write goes to a temp file and is renamed into place. rename() is atomic on
 * the same volume, so an interrupted write can never leave a truncated key behind —
 * the old contents simply survive.
 */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir){
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /* Keys are arbitrary strings ("vnotes:summary:vnotes:match.mp4_123"), so encode
     rather than sanitise: sanitising would collide two different keys onto one file. */
  fileFor(key){
    return path.join(this.dir, Buffer.from(String(key), 'utf8').toString('base64url') + '.json');
  }

  get(key){
    try {
      return fs.readFileSync(this.fileFor(key), 'utf8');
    } catch (e) {
      return null;                       /* missing key is not an error */
    }
  }

  set(key, value){
    const target = this.fileFor(key);
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, String(value), 'utf8');
    fs.renameSync(tmp, target);          /* atomic swap */
    return true;
  }

  keys(){
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      return [];
    }
    const out = [];
    for (const name of names){
      if (!name.endsWith('.json')) continue;      /* skips any stray .tmp */
      try {
        out.push(Buffer.from(name.slice(0, -5), 'base64url').toString('utf8'));
      } catch (e) { /* not one of ours; ignore */ }
    }
    return out;
  }

  delete(key){
    try { fs.unlinkSync(this.fileFor(key)); return true; }
    catch (e) { return false; }
  }
}

module.exports = { Store };
