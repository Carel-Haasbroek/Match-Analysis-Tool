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

const { FolderStore } = require('./folderstore');

const INDEX_KEY = 'vnotes:index';
const PREFS_KEY = 'vnotes:prefs';
const VAULT_RE = /^vault:([^|]+)\|([\s\S]+)$/;

function withVault(id, inner){ return 'vault:' + id + '|' + inner; }

class VaultStore {
  constructor(vaults){
    this.vaults = vaults;
    this.stores = new Map();
  }

  /* Opened lazily, so an unplugged drive costs nothing until something asks for it. */
  storeFor(id){
    const v = this.vaults.byId(id);
    if (!v || !this.vaults.available(v)) return null;
    if (!this.stores.has(id)) this.stores.set(id, new FolderStore(v.path));
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
    /* prefs are this machine's, not a vault's - always the first one */
    if (key === PREFS_KEY){
      const s = this.storeFor(this.vaults.first().id);
      return s ? s.get(PREFS_KEY) : null;
    }
    const { id, inner } = this.route(key);
    const store = this.storeFor(id);
    return store ? store.get(inner) : null;
  }

  set(key, value){
    if (key === INDEX_KEY) return this._writeLibrary(value);
    if (key === PREFS_KEY){
      const s = this.storeFor(this.vaults.first().id);
      return s ? s.set(PREFS_KEY, value) : false;
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

  /* Every vault's keys, each carrying its vault, plus the two that are not a vault's:
     the merged library and this machine's prefs. */
  keys(){
    const out = [INDEX_KEY];
    let sawPrefs = false;
    for (const v of this.vaults.list()){
      const store = this.storeFor(v.id);
      if (!store) continue;
      for (const k of store.keys()){
        if (k === INDEX_KEY) continue;
        if (k === PREFS_KEY){
          if (v.id === this.vaults.first().id && !sawPrefs){ out.push(PREFS_KEY); sawPrefs = true; }
          continue;
        }
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
