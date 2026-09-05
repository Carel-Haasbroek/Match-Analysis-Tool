'use strict';
/*
 * The vaults: named root folders holding notes, all live at once.
 *
 * A vault is somewhere notes live - this machine, or a folder inside Google Drive or
 * Dropbox that a squad shares. They are not modes you switch between: every vault is
 * read and written, and `default` only decides where a *new* session goes.
 *
 * The list lives in userData rather than in any vault, because it cannot live inside
 * the thing it points at, and because it is per-machine: each coach registers the
 * shared folder on their own laptop, under whatever name and drive letter it has there.
 *
 *   { "default": "v1",
 *     "vaults": [ { "id": "v1", "name": "My notes",   "path": "...\\video-notes\\Notes" },
 *                 { "id": "v2", "name": "Squad 2026", "path": "G:\\My Drive\\Match notes" } ] }
 */

const fs = require('fs');
const path = require('path');

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomic(file, data){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Vaults {
  /*
   * `legacyDir` is where notes lived before vaults existed. On a first run it becomes
   * the first vault, in place: nothing is moved and nothing is asked.
   */
  constructor(userDataDir, legacyDir){
    this.file = path.join(userDataDir, 'vaults.json');
    const saved = readJson(this.file);

    if (saved && Array.isArray(saved.vaults) && saved.vaults.length){
      this.vaults = saved.vaults.filter((v) => v && v.id && v.path);
      this.defaultId = saved.default;
    } else {
      this.vaults = [{ id: 'v1', name: 'My notes', path: legacyDir }];
      this.defaultId = 'v1';
      this._save();
    }
    if (!this.byId(this.defaultId)) this.defaultId = this.vaults[0].id;
  }

  _save(){
    writeAtomic(this.file, JSON.stringify({
      default: this.defaultId,
      vaults: this.vaults
    }, null, 2));
  }

  /* An id is never reused, so a key naming a removed vault can never quietly start
     pointing at a different one. */
  _nextId(){
    let n = 1;
    for (const v of this.vaults){
      const m = /^v(\d+)$/.exec(v.id);
      if (m && +m[1] >= n) n = +m[1] + 1;
    }
    return 'v' + n;
  }

  byId(id){ return this.vaults.find((v) => v.id === id) || null; }

  /* The vault that unprefixed keys belong to - everything written before vaults. */
  first(){ return this.vaults[0] || null; }

  /* A path that is not there yet is not an error: a Drive folder may not have synced,
     and an external drive may be unplugged. Say so rather than inventing an empty one. */
  available(v){
    try { return fs.statSync(v.path).isDirectory(); } catch (e) { return false; }
  }

  list(){
    return this.vaults.map((v) => ({
      id: v.id,
      name: v.name || path.basename(v.path),
      path: v.path,
      available: this.available(v),
      isDefault: v.id === this.defaultId
    }));
  }

  add(dir, name){
    const resolved = path.resolve(dir);
    const already = this.vaults.find((v) => path.resolve(v.path) === resolved);
    if (already) return { vault: already, added: false };

    const v = {
      id: this._nextId(),
      name: (name || path.basename(resolved) || 'Vault').slice(0, 60),
      path: resolved
    };
    this.vaults.push(v);
    this._save();
    return { vault: v, added: true };
  }

  rename(id, name){
    const v = this.byId(id);
    if (!v) return false;
    v.name = String(name || '').trim().slice(0, 60) || path.basename(v.path);
    this._save();
    return true;
  }

  /* Removing forgets the vault. It never touches the folder: that is somebody's work,
     and a list entry is not the notes. */
  remove(id){
    if (this.vaults.length <= 1) return false;      /* always keep somewhere to write */
    const before = this.vaults.length;
    this.vaults = this.vaults.filter((v) => v.id !== id);
    if (this.vaults.length === before) return false;
    if (this.defaultId === id) this.defaultId = this.vaults[0].id;
    this._save();
    return true;
  }

  setDefault(id){
    if (!this.byId(id)) return false;
    this.defaultId = id;
    this._save();
    return true;
  }
}

module.exports = { Vaults };
