'use strict';
/*
 * Routing between vaults.
 *
 * The renderer still sees one flat key/value store. What changes is that a session key
 * now says which vault it belongs to, because two vaults can hold the same video and a
 * flat store cannot tell them apart otherwise:
 *
 *   vault:v2|vnotes:Jack_1.mp4_65939131
 *   vault:v2|vnotes:summary:vnotes:Jack_1.mp4_65939131
 *
 * The vault goes outermost so routing is one split. A key with no prefix belongs to the
 * first vault - every note written before vaults existed keeps working untouched.
 *
 * Underneath, each vault is an ordinary FolderStore doing exactly what it did when
 * there was only one folder. Nothing here knows how a session is stored.
 */

const fs = require('fs');
const path = require('path');

const { FolderStore } = require('./folderstore');

const INDEX_KEY = 'vnotes:index';
const PREFS_KEY = 'vnotes:prefs';
const VAULT_RE = /^vault:([^|]+)\|([\s\S]+)$/;

function withVault(id, inner){ return 'vault:' + id + '|' + inner; }

/* Every file, by path and size. Returns what differs, or null when the two match -
   the check that has to pass before the original is removed. */
function compareTrees(a, b){
  const list = (root) => {
    const out = new Map();
    const walk = (dir, rel) => {
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of names){
        const full = path.join(dir, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(full, r);
        else { try { out.set(r, fs.statSync(full).size); } catch (err) { out.set(r, -1); } }
      }
    };
    walk(root, '');
    return out;
  };
  const A = list(a), B = list(b);
  if (A.size !== B.size) return A.size + ' files became ' + B.size;
  for (const [name, size] of A){
    if (!B.has(name)) return name + ' is missing';
    if (B.get(name) !== size) return name + ' is a different size';
  }
  return null;
}

class VaultStore {
  /*
   * prefsFile sits in userData rather than in a vault. Your name, theme and volume are
   * this machine's, and a shared vault is the last place they belong - two coaches
   * would otherwise take turns overwriting each other's settings.
   */
  constructor(vaults, prefsFile){
    this.vaults = vaults;
    this.prefsFile = prefsFile;
    this.author = 'me';
    this.stores = new Map();
  }

  setAuthor(author){
    if (!author) return;
    this.author = author;
    for (const s of this.stores.values()) s.setAuthor(author);
  }

  /* Opened lazily, so an unplugged drive costs nothing until something asks for it. */
  storeFor(id){
    const v = this.vaults.byId(id);
    if (!v || !this.vaults.available(v)) return null;
    if (!this.stores.has(id)) this.stores.set(id, new FolderStore(v.path, this.author));
    return this.stores.get(id);
  }

  /* A vault removed from the list, or one whose folder has gone, drops its store so a
     later re-add opens the folder afresh rather than reusing a stale index. */
  forget(id){ this.stores.delete(id); }

  route(key){
    const m = VAULT_RE.exec(key);
    if (m) return { id: m[1], inner: m[2] };
    const first = this.vaults.first();
    return { id: first ? first.id : null, inner: key };
  }

  get(key){
    if (key === INDEX_KEY) return this._readLibrary();
    if (key === PREFS_KEY) return this._readPrefs();
    const { id, inner } = this.route(key);
    const store = this.storeFor(id);
    return store ? store.get(inner) : null;
  }

  set(key, value){
    if (key === INDEX_KEY) return this._writeLibrary(value);
    if (key === PREFS_KEY){
      try {
        fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true });
        const tmp = this.prefsFile + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, value);
        fs.renameSync(tmp, this.prefsFile);
        return true;
      } catch (e) { return false; }
    }
    const { id, inner } = this.route(key);
    const store = this.storeFor(id);
    return store ? store.set(inner, value) : false;
  }

  delete(key){
    const { id, inner } = this.route(key);
    const store = this.storeFor(id);
    return store ? store.delete(inner) : false;
  }

  moveSession(key, groupPath){
    const { id, inner } = this.route(key);
    const store = this.storeFor(id);
    return store ? store.moveSession(inner, groupPath) : false;
  }

  /* ---------- folders ---------- */
  /* Straight through to the vault that owns them; the paths are that vault's own. */
  folders(id){ const s = this.storeFor(id); return s ? s.folders() : []; }
  createFolder(id, rel){ const s = this.storeFor(id); return s ? s.createFolder(rel) : false; }
  renameFolder(id, a, b){ const s = this.storeFor(id); return s ? s.renameFolder(a, b) : false; }
  removeFolder(id, rel){ const s = this.storeFor(id); return s ? s.removeFolder(rel) : false; }

  /*
   * Move a session into another vault.
   *
   * This copies the session's directory rather than reading the notes out of one store
   * and writing them into the other, and the reason matters: _writeSession keeps only
   * the current coach's notes whole and reduces everybody else's to a stub carrying his
   * own comments. A read-and-write move would therefore drop every other coach's work on
   * the floor. Copying the directory takes all of their files with it.
   *
   * Nothing is removed until the copy has been checked file by file.
   */
  moveSessionToVault(key, toVaultId, groupPath){
    const { id: fromId, inner } = this.route(key);
    if (!fromId || fromId === toVaultId) return { ok: false, reason: 'same' };

    const from = this.storeFor(fromId), to = this.storeFor(toVaultId);
    if (!from || !to) return { ok: false, reason: 'unavailable' };

    /* Combining two copies of one session is a merge, and guessing at one here would be
       worse than saying so: Export and Import already does it, by note id. */
    if (to.get(inner) !== null) return { ok: false, reason: 'exists' };

    const src = from.sessionPath(inner);
    if (!src) return { ok: false, reason: 'missing' };

    const dst = to.freeSessionPath(path.basename(src), groupPath);
    try { fs.cpSync(src, dst, { recursive: true }); }
    catch (e) { return { ok: false, reason: 'copy failed: ' + e.message }; }

    const diff = compareTrees(src, dst);
    if (diff){
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e) {}
      return { ok: false, reason: 'the copy did not match: ' + diff };
    }

    try { fs.rmSync(src, { recursive: true, force: true }); }
    catch (e) { return { ok: false, reason: 'copied, but the original could not be removed' }; }

    from.rescan();
    to.rescan();
    return { ok: true, key: withVault(toVaultId, inner) };
  }

  /* Settings used to live in the first vault. Read them from there once, so upgrading
     does not hand anyone a blank name and a reset theme. */
  _readPrefs(){
    try { return fs.readFileSync(this.prefsFile, 'utf8'); } catch (e) {}
    const first = this.vaults.first();
    const s = first ? this.storeFor(first.id) : null;
    const old = s ? s.get(PREFS_KEY) : null;
    if (old) this.set(PREFS_KEY, old);
    return old;
  }

  /* Every vault's keys, each carrying its vault, plus the two that are not a vault's:
     the merged library and this machine's prefs. */
  keys(){
    const out = [INDEX_KEY, PREFS_KEY];
    for (const v of this.vaults.list()){
      const store = this.storeFor(v.id);
      if (!store) continue;
      for (const k of store.keys()){
        /* both of these are the store's own, not a vault's */
        if (k === INDEX_KEY || k === PREFS_KEY) continue;
        out.push(withVault(v.id, k));
      }
    }
    return out;
  }

  /*
   * The library is the one thing every vault has its own copy of, so it is stitched
   * together on read and taken apart again on write. On disk each vault keeps exactly
   * the library.json it always had - unprefixed keys, no vault field - so another
   * coach's app, or an older build, reads it without knowing vaults exist.
   */
  _readLibrary(){
    const all = [];
    for (const v of this.vaults.list()){
      const store = this.storeFor(v.id);
      if (!store) continue;
      let list;
      try { list = JSON.parse(store.get(INDEX_KEY) || '[]'); } catch (e) { list = []; }
      if (!Array.isArray(list)) continue;
      for (const e of list){
        if (!e || !e.key) continue;
        const copy = Object.assign({}, e);
        copy.key = withVault(v.id, e.key);
        copy.vault = v.id;
        copy.vaultName = v.name;
        all.push(copy);
      }
    }
    all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
    return JSON.stringify(all);
  }

  _writeLibrary(value){
    let list;
    try { list = JSON.parse(value); } catch (e) { return false; }
    if (!Array.isArray(list)) return false;

    const byVault = new Map();
    for (const v of this.vaults.list()) byVault.set(v.id, []);

    for (const e of list){
      if (!e || !e.key) continue;
      const { id, inner } = this.route(e.key);
      if (!byVault.has(id)) continue;              /* a vault that has since gone */
      const copy = Object.assign({}, e);
      copy.key = inner;
      delete copy.vault;
      delete copy.vaultName;
      byVault.get(id).push(copy);
    }

    let ok = true;
    for (const [id, entries] of byVault){
      const store = this.storeFor(id);
      /* An unavailable vault is skipped rather than emptied: writing [] here would
         erase a squad's index the moment someone opened the app offline. */
      if (!store) continue;
      if (!store.set(INDEX_KEY, JSON.stringify(entries))) ok = false;
    }
    return ok;
  }
}

module.exports = { VaultStore, withVault, VAULT_RE };
