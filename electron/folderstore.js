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
 *     paths.json                  key -> folder: a cache, rebuilt by scanning
 *     library.<author>.json       the session index, one per coach
 *     Competition 2026/           a group folder, mirroring the app's folders
 *       Jack_1/
 *         notes.carel-7f3a.json   only this coach's app ever writes this file
 *         notes.marius-2b91.json  another coach's, sitting alongside
 *         deleted.carel-7f3a.json note ids this coach removed
 *         summary.carel-7f3a.md
 *         trash.carel-7f3a.json   deleted notes, kept
 *         session.json            written before this, still read
 *         drawings/
 *           1788593316500-jt19c.png
 *
 * One file per coach is what makes a vault safe to share through Google Drive or
 * Dropbox. Two machines never write the same file, so the sync tool has nothing to
 * conflict over; everyone's files are unioned on read instead. A note or comment
 * belongs to whoever's file it is in, recorded as `by` so the split survives a round
 * trip through the renderer, which only ever sees one merged list.
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

/* One coach's files. The patterns are loose on purpose: Drive and Dropbox fork a file
   they cannot merge into "notes.carel (Carel's conflicted copy 2026-09-05).json", and a
   fork that is never read is work that has quietly vanished. Adopting them costs
   nothing - they merge by id like any other author's file. */
const NOTES_FILE = /^notes\..+\.json$/i;
const DELETED_FILE = /^deleted\..+\.json$/i;
const LIBRARY_FILE = /^library\..+\.json$/i;
const SUMMARY_FILE = /^summary\..+\.md$/i;
const TRASH_FILE = /^trash\..+\.json$/i;

function listDir(dir){
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function parseJson(buf){
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

/*
 * Union several coaches' note lists. Matches on note id and merges comment threads by
 * comment id, which is the same rule the renderer's own mergeNoteLists applies to an
 * imported file - the two are deliberate mirrors of each other, kept apart only
 * because app.js is a plain browser script with no require.
 *
 * A file may hold a stub: { id, time, comments } for a note someone else created that
 * this coach commented on. Whichever copy is seen first, the full note fills in the
 * fields the stub does not carry.
 */
function unionNotes(lists){
  const byId = new Map();
  for (const list of lists){
    if (!Array.isArray(list)) continue;
    for (const n of list){
      if (!n || typeof n.id === 'undefined') continue;
      const have = byId.get(n.id);
      if (!have){ byId.set(n.id, Object.assign({}, n)); continue; }

      const seen = new Set((have.comments || []).map((c) => c && c.id));
      const merged = (have.comments || []).slice();
      for (const c of (n.comments || [])){
        if (c && !seen.has(c.id)){ merged.push(c); seen.add(c.id); }
      }
      if (merged.length) have.comments = merged;

      for (const k of Object.keys(n)){
        if (k === 'comments') continue;
        if (have[k] === undefined) have[k] = n[k];
      }
    }
  }
  const out = Array.from(byId.values());
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

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
  constructor(root, author){
    this.root = root;
    fs.mkdirSync(this.root, { recursive: true });
    this.pathsFile = path.join(this.root, 'paths.json');
    this.paths = this._readPaths();
    this.others = this._readOthers();
    /* Until the renderer says who is here, writes land in a neutral file rather than
       being guessed at. It sends the name at boot, before anything can be saved. */
    this.author = author || 'me';
    this.rescan();
  }

  setAuthor(author){ if (author) this.author = safeSegment(author); }

  _mine(kind, ext){ return kind + '.' + this.author + (ext || '.json'); }

  /*
   * paths.json is a cache, not the truth. A coach sharing a vault writes their own
   * copy of it, so trusting it would hide sessions another coach created - the folders
   * are there, but this machine's index has never heard of them. Reading the key out
   * of the files themselves cannot go stale.
   */
  rescan(){
    const found = {};
    const walk = (dir, rel) => {
      for (const name of listDir(dir)){
        if (name === 'drawings' || name === 'other') continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        const childRel = rel ? rel + path.sep + name : name;
        const key = this._keyInFolder(full);
        if (key) found[key] = childRel;
        walk(full, childRel);
      }
    };
    walk(this.root, '');

    let changed = false;
    for (const key of Object.keys(found)){
      if (this.paths[key] !== found[key]){ this.paths[key] = found[key]; changed = true; }
    }
    /* a folder that has gone stops being claimed, but nothing on disk is touched */
    for (const key of Object.keys(this.paths)){
      if (!fs.existsSync(path.join(this.root, this.paths[key]))){
        delete this.paths[key]; changed = true;
      }
    }
    if (changed){ try { this._savePaths(); } catch (e) {} }
  }

  _keyInFolder(dir){
    const names = listDir(dir);
    for (const n of names){
      if (n !== 'session.json' && !NOTES_FILE.test(n)) continue;
      const doc = parseJson(readIfPresent(path.join(dir, n)));
      if (doc && doc.key) return doc.key;
    }
    return null;
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
    if (key === INDEX_KEY) return this._readLibrary();
    if (key === PREFS_KEY) return this._readJsonFile('prefs.json');

    if (key.startsWith(SUMMARY_PREFIX)){
      const dir = this._existingDir(key.slice(SUMMARY_PREFIX.length));
      if (!dir) return null;
      return this._readSummary(dir);
    }

    if (key.startsWith(TRASH_PREFIX)){
      const dir = this._existingDir(key.slice(TRASH_PREFIX.length));
      if (!dir) return null;
      const all = [];
      for (const name of listDir(dir)){
        if (name !== 'trash.json' && !TRASH_FILE.test(name)) continue;
        const list = parseJson(readIfPresent(path.join(dir, name)));
        if (Array.isArray(list)) for (const item of list) all.push(item);
      }
      if (!all.length) return null;
      all.sort((a, b) => (b.deleted || 0) - (a.deleted || 0));
      return JSON.stringify(all);
    }

    /* a session's notes, or a plain value stored under an unrecognised key */
    const dir = this._existingDir(key);
    if (!dir){
      const other = readIfPresent(this._otherFile(key));
      return other ? other.toString('utf8') : null;
    }
    const notes = this._readNotes(dir);
    if (!notes) return null;
    return JSON.stringify(this._inlineImages(dir, notes));
  }

  /* Every coach's file in this session, unioned, with anyone's deletions honoured. */
  _readNotes(dir){
    const lists = [];
    let any = false;

    const legacy = parseJson(readIfPresent(path.join(dir, 'session.json')));
    if (legacy){ lists.push(legacy.notes || []); any = true; }

    for (const name of listDir(dir)){
      if (!NOTES_FILE.test(name)) continue;
      const doc = parseJson(readIfPresent(path.join(dir, name)));
      if (!doc) continue;
      lists.push(Array.isArray(doc) ? doc : (doc.notes || []));
      any = true;
    }
    if (!any) return null;

    const merged = unionNotes(lists);
    const gone = this._tombstones(dir);
    return gone.size ? merged.filter((n) => !gone.has(n.id)) : merged;
  }

  /* A deletion has to travel too, or a note another coach removed would come back from
     their file on the next read. The note itself stays in their trash. */
  _tombstones(dir){
    const out = new Set();
    for (const name of listDir(dir)){
      if (!DELETED_FILE.test(name)) continue;
      const ids = parseJson(readIfPresent(path.join(dir, name)));
      if (Array.isArray(ids)) for (const id of ids) out.add(id);
    }
    return out;
  }

  /*
   * A summary is one free-text field, so it cannot be unioned the way notes can. Yours
   * wins when you have one; otherwise you see whoever wrote most recently, and if you
   * edit it, it becomes yours as well. Nobody's file is ever written by anyone else.
   */
  _readSummary(dir){
    let best = null;
    const mine = path.join(dir, this._mine('summary', '.md'));

    for (const name of listDir(dir)){
      const isMine = name === path.basename(mine);
      if (name !== 'summary.md' && !SUMMARY_FILE.test(name)) continue;
      const md = readIfPresent(path.join(dir, name));
      if (!md) continue;
      const metaName = name.replace(/\.md$/i, '.meta.json');
      const meta = parseJson(readIfPresent(path.join(dir, metaName)));
      const rec = { text: md.toString('utf8'), updated: (meta && meta.updated) || 0 };
      if (isMine) return JSON.stringify(rec);
      if (!best || rec.updated > best.updated) best = rec;
    }
    return best ? JSON.stringify(best) : null;
  }

  /* Each coach keeps their own index; they are merged by key, newest opening winning. */
  _readLibrary(){
    const lists = [];
    const legacy = parseJson(readIfPresent(path.join(this.root, 'library.json')));
    if (Array.isArray(legacy)) lists.push(legacy);
    for (const name of listDir(this.root)){
      if (!LIBRARY_FILE.test(name)) continue;
      const doc = parseJson(readIfPresent(path.join(this.root, name)));
      if (Array.isArray(doc)) lists.push(doc);
    }
    if (!lists.length) return null;

    const byKey = new Map();
    for (const list of lists){
      for (const e of list){
        if (!e || !e.key) continue;
        const have = byKey.get(e.key);
        if (!have || (e.lastOpened || 0) > (have.lastOpened || 0)) byKey.set(e.key, e);
      }
    }
    const out = Array.from(byKey.values());
    out.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
    return JSON.stringify(out);
  }

  set(key, value){
    if (key === INDEX_KEY){
      writeAtomic(path.join(this.root, this._mine('library')), value);
      return true;
    }
    if (key === PREFS_KEY){ writeAtomic(path.join(this.root, 'prefs.json'), value); return true; }

    if (key.startsWith(SUMMARY_PREFIX)){
      const rec = JSON.parse(value);
      const dir = this.sessionDir(key.slice(SUMMARY_PREFIX.length), this._hintFor(key.slice(SUMMARY_PREFIX.length)));
      writeAtomic(path.join(dir, this._mine('summary', '.md')), rec.text || '');
      writeAtomic(path.join(dir, this._mine('summary', '.meta.json')),
        JSON.stringify({ updated: rec.updated || Date.now() }, null, 2));
      return true;
    }

    if (key.startsWith(TRASH_PREFIX)){
      const dir = this.sessionDir(key.slice(TRASH_PREFIX.length), this._hintFor(key.slice(TRASH_PREFIX.length)));
      writeAtomic(path.join(dir, this._mine('trash')), value);
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
    /* a shared vault can have grown since this store was opened */
    this.rescan();

    const out = [];
    const rootNames = listDir(this.root);
    if (rootNames.some((n) => n === 'library.json' || LIBRARY_FILE.test(n))) out.push(INDEX_KEY);
    if (rootNames.indexOf('prefs.json') >= 0) out.push(PREFS_KEY);
    for (const k of Object.keys(this.others)) out.push(k);

    for (const key of Object.keys(this.paths)){
      const names = listDir(path.join(this.root, this.paths[key]));
      if (names.some((n) => n === 'session.json' || NOTES_FILE.test(n))) out.push(key);
      if (names.some((n) => n === 'summary.md' || SUMMARY_FILE.test(n))) out.push(SUMMARY_PREFIX + key);
      if (names.some((n) => n === 'trash.json' || TRASH_FILE.test(n))) out.push(TRASH_PREFIX + key);
    }
    return out;
  }

  /*
   * Deleting a session removes this coach's files from it and nothing else. In a shared
   * vault the folder holds other people's notes too, and one person tidying up must not
   * take the squad's work with it. The folder itself goes only when no notes of any kind
   * are left - which, in a vault nobody shares, is always.
   */
  delete(key){
    const dir = this._existingDir(key);
    if (!dir) return false;

    for (const name of listDir(dir)){
      const mine = name === this._mine('notes') || name === this._mine('deleted') ||
                   name === this._mine('trash') || name === this._mine('summary', '.md') ||
                   name === this._mine('summary', '.meta.json');
      if (!mine) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
    }

    const left = listDir(dir);
    const someoneElse = left.some((n) => n === 'session.json' || NOTES_FILE.test(n));
    if (someoneElse) return true;                 /* their notes stay, and so does the folder */

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

  /*
   * A key this store has never seen may be a session another coach has just created in a
   * shared vault: the library lists it, because that is read from their file directly,
   * but nothing here knows which folder it is in. Scan once before giving up, or the
   * session would show in the list and read back empty until the app was restarted.
   *
   * Only a genuinely unknown key gets here - a summary or trash key resolves through
   * its session's folder like any other - so the scan is rare rather than per-read.
   */
  _existingDir(key){
    let rel = this.paths[key];
    if (!rel){
      this.rescan();
      rel = this.paths[key];
    }
    if (!rel) return null;
    const dir = path.join(this.root, rel);
    return fs.existsSync(dir) ? dir : null;
  }

  /* A readable folder name, taken from the library entry when there is one. */
  _hintFor(key){
    const raw = this._readLibrary();
    if (!raw) return null;
    try {
      const lib = JSON.parse(raw);
      const e = lib.find((x) => x && x.key === key);
      if (!e) return null;
      return (e.customName && e.customName.trim()) || e.label || e.fileName || e.videoId || null;
    } catch (err) { return null; }
  }

  /*
   * Drawings become real files. Base64 inside json is a third larger than the bytes it
   * carries and cannot be opened by anything else.
   *
   * They are named for the note rather than its position, because two coaches adding a
   * note would otherwise both write 000_*.png - and because inserting a note used to
   * rename every file after it. The drawings folder is shared, so the keep-set is built
   * from everyone's notes: reclaiming space must never take another coach's picture.
   */
  _writeSession(dir, key, notes){
    const drawings = path.join(dir, 'drawings');
    fs.mkdirSync(drawings, { recursive: true });

    const before = this._readNotes(dir) || [];
    const keep = new Set();

    const slim = notes.map((n, i) => {
      const out = Object.assign({}, n);
      ['image', 'overlayImage'].forEach((field) => {
        const val = n[field];
        if (val && typeof val === 'object' && val.file){ keep.add(val.file); return; }
        if (typeof val !== 'string') return;
        const m = DATA_URL.exec(val);
        if (!m) return;
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const base = safeSegment(String(n.id || i)) || String(i);
        const name = base + (field === 'overlayImage' ? '_overlay' : '') + '.' + ext;
        writeAtomic(path.join(drawings, name), Buffer.from(m[2], 'base64'));
        keep.add(name);
        out[field] = { file: name };            /* referenced, not embedded */
      });
      return out;
    });

    /* Keep only what is this coach's: their own notes whole, and for a note somebody
       else created, a stub carrying nothing but their comments. Ownership is recorded
       rather than inferred, so it survives the round trip through the renderer - which
       only ever sees one merged list and cannot tell the files apart. */
    const me = this.author;
    const mine = [];
    for (const n of slim){
      const comments = (n.comments || []).filter((c) => {
        if (c && !c.by) c.by = me;              /* new: claim it */
        return c && c.by === me;
      });
      if (!n.by) n.by = me;                     /* a note nobody has claimed is new */
      if (n.by === me){
        mine.push(Object.assign({}, n, comments.length ? { comments: comments } : {}));
      } else if (comments.length){
        mine.push({ id: n.id, time: n.time, by: me, stub: true, comments: comments });
      }
    }

    writeAtomic(path.join(dir, this._mine('notes')), JSON.stringify({
      key: key,
      author: me,
      saved: new Date().toISOString(),
      notes: mine
    }, null, 2));

    /*
     * What was here a moment ago and is not now was deleted. Recording the ids is the
     * only way a deletion reaches the coach whose file the note lives in.
     *
     * And the other way: an id that is back must come off the list, or restoring a note
     * from the trash would put it on screen and then lose it again on the next read,
     * which filters tombstoned ids out. The two halves have to move together.
     */
    const now = new Set(notes.map((n) => n.id));
    const removed = before.filter((n) => !now.has(n.id)).map((n) => n.id);
    const file = path.join(dir, this._mine('deleted'));
    const had = parseJson(readIfPresent(file));
    const all = new Set(Array.isArray(had) ? had : []);
    const was = all.size;
    for (const id of removed) all.add(id);
    for (const id of now) all.delete(id);
    if (all.size !== was || removed.length){
      if (all.size) writeAtomic(file, JSON.stringify(Array.from(all), null, 2));
      else { try { fs.unlinkSync(file); } catch (e) {} }
    }

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
