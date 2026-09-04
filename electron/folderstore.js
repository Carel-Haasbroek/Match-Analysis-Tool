'use strict';
/*
 * A notes folder you can actually open.
 *
 * The renderer still sees the same flat key/value store it always has, so app.js
 * needs no knowledge of any of this. What changes is the shape on disk: instead of
 * base64-named blobs in AppData, each session is a folder holding a small readable
 * session.json, its summary as markdown, and its drawings as real PNG files.
 *
 *   <root>/
 *     paths.json                  key -> folder, so nothing is ever guessed
 *     library.json                the session index
 *     prefs.json
 *     Competition 2026/           a group folder, mirroring the app's folders
 *       Jack_1/
 *         session.json            notes, with drawings referenced by filename
 *         summary.md
 *         trash.json              deleted notes, kept
 *         drawings/
 *           0-12.400.png
 *
 * Writes go through a temp file and a rename, as before: an interrupted write can
 * never truncate a session.
 */

const fs = require('fs');
const path = require('path');

const INDEX_KEY = 'vnotes:index';
const PREFS_KEY = 'vnotes:prefs';
const SUMMARY_PREFIX = 'vnotes:summary:';
const TRASH_PREFIX = 'vnotes:trash:';

/* data:image/png;base64,.... */
const DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/;

function safeSegment(s){
  /* Windows forbids these outright; control codes are dropped rather than turned
     into spaces. Hyphens and spaces are legal and kept - a readable name is worth
     more here than a slug. */
  var FORBIDDEN = '\\/:*?\"<>|';
  var str = String(s || ''), out = '';
  for (var i = 0; i < str.length; i++){
    var ch = str.charAt(i);
    if (str.charCodeAt(i) < 32) continue;
    out += FORBIDDEN.indexOf(ch) >= 0 ? ' ' : ch;
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')          /* a leading dot hides the folder */
    .replace(/[. ]+$/, '')          /* Windows drops trailing dots and spaces */
    .trim()
    .slice(0, 80) || 'session';
}

function writeAtomic(file, data){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readIfPresent(file){
  try { return fs.readFileSync(file); } catch (e) { return null; }
}

class FolderStore {
  constructor(root){
    this.root = root;
    fs.mkdirSync(this.root, { recursive: true });
    this.pathsFile = path.join(this.root, 'paths.json');
    this.paths = this._readPaths();
    this.others = this._readOthers();
  }

  _readOthers(){
    const dir = path.join(this.root, 'other');
    const out = {};
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    const raw = readIfPresent(path.join(dir, '.keys.json'));
    if (raw){ try { return JSON.parse(raw.toString('utf8')); } catch (e) {} }
    for (const n of names){ if (n.endsWith('.json') && n !== '.keys.json') out[n.slice(0, -5)] = n; }
    return out;
  }

  _readPaths(){
    const raw = readIfPresent(this.pathsFile);
    if (!raw) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch (e) { return {}; }
  }
  _savePaths(){ writeAtomic(this.pathsFile, JSON.stringify(this.paths, null, 2)); }

  /* ---------- where a session lives ---------- */

  /* Folder names come from the session's display name, but the mapping is recorded
     rather than recomputed: a rename must not orphan the notes already on disk. */
  sessionDir(key, hint){
    if (this.paths[key]) return path.join(this.root, this.paths[key]);

    const base = safeSegment(hint || key.replace(/^vnotes:/, ''));
    let rel = base, n = 2;
    const taken = new Set(Object.values(this.paths));
    while (taken.has(rel) || fs.existsSync(path.join(this.root, rel))){
      rel = base + ' (' + (n++) + ')';
    }
    this.paths[key] = rel;
    this._savePaths();
    return path.join(this.root, rel);
  }

  /* Move a session's folder, which is how grouping is applied on disk. */
  moveSession(key, groupPath){
    const cur = this.paths[key];
    if (!cur) return false;
    const name = path.basename(cur);
    /* Drop empty segments BEFORE sanitising: safeSegment turns '' into 'session',
       so sanitising first would give an empty group path a folder of that name. */
    const relGroup = (groupPath || '')
      .split('/')
      .map(function(x){ return x.trim(); })
      .filter(Boolean)
      .map(safeSegment)
      .join(path.sep);
    let rel = relGroup ? path.join(relGroup, name) : name;
    if (rel === cur) return true;

    let target = path.join(this.root, rel), n = 2;
    while (fs.existsSync(target)){
      rel = relGroup ? path.join(relGroup, name + ' (' + n + ')') : name + ' (' + n + ')';
      target = path.join(this.root, rel);
      n++;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.renameSync(path.join(this.root, cur), target); }
    catch (e) { return false; }
    this.paths[key] = rel;
    this._savePaths();
    return true;
  }

  /* ---------- the key/value face the renderer sees ---------- */

  get(key){
    if (key === INDEX_KEY) return this._readJsonFile('library.json');
    if (key === PREFS_KEY) return this._readJsonFile('prefs.json');

    if (key.startsWith(SUMMARY_PREFIX)){
      const dir = this._existingDir(key.slice(SUMMARY_PREFIX.length));
      if (!dir) return null;
      const md = readIfPresent(path.join(dir, 'summary.md'));
      const meta = readIfPresent(path.join(dir, 'summary.meta.json'));
      if (!md) return null;
      const updated = meta ? (JSON.parse(meta.toString('utf8')).updated || 0) : 0;
      return JSON.stringify({ text: md.toString('utf8'), updated: updated });
    }

    if (key.startsWith(TRASH_PREFIX)){
      const dir = this._existingDir(key.slice(TRASH_PREFIX.length));
      if (!dir) return null;
      const raw = readIfPresent(path.join(dir, 'trash.json'));
      return raw ? raw.toString('utf8') : null;
    }

    /* a session's notes, or a plain value stored under an unrecognised key */
    const dir = this._existingDir(key);
    if (!dir){
      const other = readIfPresent(this._otherFile(key));
      return other ? other.toString('utf8') : null;
    }
    const raw = readIfPresent(path.join(dir, 'session.json'));
    if (!raw) return null;
    let doc;
    try { doc = JSON.parse(raw.toString('utf8')); } catch (e) { return null; }
    return JSON.stringify(this._inlineImages(dir, doc.notes || []));
  }

  set(key, value){
    if (key === INDEX_KEY){ writeAtomic(path.join(this.root, 'library.json'), value); return true; }
    if (key === PREFS_KEY){ writeAtomic(path.join(this.root, 'prefs.json'), value); return true; }

    if (key.startsWith(SUMMARY_PREFIX)){
      const rec = JSON.parse(value);
      const dir = this.sessionDir(key.slice(SUMMARY_PREFIX.length), this._hintFor(key.slice(SUMMARY_PREFIX.length)));
      writeAtomic(path.join(dir, 'summary.md'), rec.text || '');
      writeAtomic(path.join(dir, 'summary.meta.json'),
        JSON.stringify({ updated: rec.updated || Date.now() }, null, 2));
      return true;
    }

    if (key.startsWith(TRASH_PREFIX)){
      const dir = this.sessionDir(key.slice(TRASH_PREFIX.length), this._hintFor(key.slice(TRASH_PREFIX.length)));
      writeAtomic(path.join(dir, 'trash.json'), value);
      return true;
    }

    /* A session is an array of notes. Anything else with a vnotes-ish key is stored
       as a plain file rather than assumed to be one - an unexpected shape should not
       be able to break the store. */
    let parsed;
    try { parsed = JSON.parse(value); } catch (e) { parsed = null; }
    if (!Array.isArray(parsed)){
      writeAtomic(this._otherFile(key), value);
      this.others[key] = safeSegment(key) + '.json';
      writeAtomic(path.join(this.root, 'other', '.keys.json'),
        JSON.stringify(this.others, null, 2));
      return true;
    }

    const dir = this.sessionDir(key, this._hintFor(key));
    this._writeSession(dir, key, parsed);
    return true;
  }

  _otherFile(key){
    return path.join(this.root, 'other', safeSegment(key) + '.json');
  }

  keys(){
    const out = [];
    if (fs.existsSync(path.join(this.root, 'library.json'))) out.push(INDEX_KEY);
    if (fs.existsSync(path.join(this.root, 'prefs.json'))) out.push(PREFS_KEY);
    for (const k of Object.keys(this.others)) out.push(k);
    for (const key of Object.keys(this.paths)){
      const dir = path.join(this.root, this.paths[key]);
      if (fs.existsSync(path.join(dir, 'session.json'))) out.push(key);
      if (fs.existsSync(path.join(dir, 'summary.md'))) out.push(SUMMARY_PREFIX + key);
      if (fs.existsSync(path.join(dir, 'trash.json'))) out.push(TRASH_PREFIX + key);
    }
    return out;
  }

  delete(key){
    const dir = this._existingDir(key);
    if (!dir) return false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return false; }
    delete this.paths[key];
    this._savePaths();
    return true;
  }

  /* ---------- internals ---------- */

  _readJsonFile(name){
    const raw = readIfPresent(path.join(this.root, name));
    return raw ? raw.toString('utf8') : null;
  }

  _existingDir(key){
    const rel = this.paths[key];
    if (!rel) return null;
    const dir = path.join(this.root, rel);
    return fs.existsSync(dir) ? dir : null;
  }

  /* A readable folder name, taken from the library entry when there is one. */
  _hintFor(key){
    const raw = this._readJsonFile('library.json');
    if (!raw) return null;
    try {
      const lib = JSON.parse(raw);
      const e = lib.find((x) => x && x.key === key);
      if (!e) return null;
      return (e.customName && e.customName.trim()) || e.label || e.fileName || e.videoId || null;
    } catch (err) { return null; }
  }

  /* Drawings become real files. Base64 inside json is a third larger than the bytes
     it carries and cannot be opened by anything else. */
  _writeSession(dir, key, notes){
    const drawings = path.join(dir, 'drawings');
    fs.mkdirSync(drawings, { recursive: true });

    const keep = new Set();
    const slim = notes.map((n, i) => {
      const out = Object.assign({}, n);
      ['image', 'overlayImage'].forEach((field) => {
        const val = n[field];
        if (typeof val !== 'string') return;
        const m = DATA_URL.exec(val);
        if (!m) return;
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const stamp = (typeof n.time === 'number' ? n.time.toFixed(3) : String(i)).replace('.', '-');
        const name = String(i).padStart(3, '0') + '_' + stamp +
                     (field === 'overlayImage' ? '_overlay' : '') + '.' + ext;
        writeAtomic(path.join(drawings, name), Buffer.from(m[2], 'base64'));
        keep.add(name);
        out[field] = { file: name };            /* referenced, not embedded */
      });
      return out;
    });

    writeAtomic(path.join(dir, 'session.json'), JSON.stringify({
      key: key,
      saved: new Date().toISOString(),
      notes: slim
    }, null, 2));

    /* drop drawings whose note has gone, so deleting a note reclaims its file */
    for (const f of fs.readdirSync(drawings)){
      if (!keep.has(f) && !f.endsWith('.tmp')){
        try { fs.unlinkSync(path.join(drawings, f)); } catch (e) {}
      }
    }
  }

  _inlineImages(dir, notes){
    return notes.map((n) => {
      const out = Object.assign({}, n);
      ['image', 'overlayImage'].forEach((field) => {
        const ref = n[field];
        if (!ref || typeof ref !== 'object' || !ref.file) return;
        const buf = readIfPresent(path.join(dir, 'drawings', ref.file));
        if (!buf){ delete out[field]; return; }
        const ext = path.extname(ref.file).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
        out[field] = 'data:' + mime + ';base64,' + buf.toString('base64');
      });
      return out;
    });
  }
}

module.exports = { FolderStore, safeSegment };
