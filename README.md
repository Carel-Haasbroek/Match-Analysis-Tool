# Video Notes

A match analysis tool. Play a video — a local file or a YouTube link — pause on a moment,
draw on the frame, and write a note against that timestamp. Play back and your drawings
reappear over the moving picture at the moments they belong to.

Everything stays on your machine. Nothing is uploaded.

---

## Installing

Two builds come out of `dist/`. Pick one:

| | |
|---|---|
| **`Video Notes Setup 1.0.0.exe`** | Normal installer. Start Menu entry, uninstaller, lets you choose the install folder. |
| **`VideoNotes-1.0.0-portable.exe`** | Single file, no installation. Copy it anywhere and double-click. Good for a USB stick or a machine you don't want to install on. |

### Running the installer

1. Double-click **`Video Notes Setup 1.0.0.exe`**.
2. **Windows will show a blue "Windows protected your PC" box.** This is expected —
   the build isn't code-signed, and Windows warns about any unsigned installer.
   Click **More info**, then **Run anyway**.
3. Choose an install folder if you want to change it, and finish.
4. Launch **Video Notes** from the Start Menu.

The portable exe shows the same warning on first run, and is dismissed the same way.
Signing the build would remove it, but that needs a paid certificate.

Uninstall through Settings → Apps, or the uninstaller in the install folder. **Uninstalling
does not delete your notes** — see below.

---

## Where your notes live

`%APPDATA%\video-notes\store` — one small file per video, keyed by the video's filename and
size. Both the installed app and a run from source use this same folder, so they share
notes.

Two consequences worth knowing:

- Uninstalling the app leaves your notes untouched. Reinstalling picks them straight back up.
- Notes made in the **browser** version live somewhere else entirely (the browser's own
  storage, per site). They do not appear in the desktop app. To carry them across, use
  **Export all notes** in the browser and **Import backup** in the app.

### Backing up

On the home screen, **Export all notes** writes one JSON file holding every note, every
summary and every session name. **Import backup** merges it back — it only ever adds, never
overwrites or deletes, so restoring an old backup can't cost you newer work.

Worth doing before you rely on the app for anything you'd hate to redo.

---

## Running from source

Needs [Node.js](https://nodejs.org/) (LTS is fine).

```bash
npm install
npm start
```

Or just double-click **`serve.cmd`**, which installs dependencies on first run and then
launches the app.

### Building the exes yourself

```bash
npm run dist
```

Both artifacts land in `dist/`. The first build downloads a Windows toolchain, so give it a
few minutes.

### The browser version

The same app runs as a plain web page, but it must be served over `http://` — YouTube
refuses to embed into a `file://` page, and opening `video-notes.html` directly gives
"error 153". Any static server works:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/video-notes.html>. Local video files work either way; only
YouTube needs the server. In the browser you also have to re-pick a local video each session
— remembering the file's path is the main thing the desktop app adds.

---

## Using it

**Marking a moment** — pause where you want, click **Mark this moment**, draw on the frame
(pen, arrow or box, twelve colours plus a custom picker), optionally type a note, and save.

**Playback** — controls float in the bottom-right of the player:

| | |
|---|---|
| Play / pause | also <kbd>Space</kbd> |
| −5s / +5s | also <kbd>←</kbd> / <kbd>→</kbd> |
| Play to next note | also <kbd>N</kbd> — runs on and stops at the next marked moment |
| Speed | cycles 1× → 0.5× → 0.25× |
| Mute / volume | also <kbd>M</kbd> |
| Rotate | also <kbd>R</kbd> — 90° at a time, remembered per session, for footage shot sideways |

**While you watch**, each drawing reappears as playback reaches its moment and clears again
shortly after — the **Hold** slider sets how long, from a flash to two seconds. The note's
text shows across the bottom of the picture; the chevron collapses it, and reaching the next
note opens it again. **Pause at notes** in the top bar stops playback on each marked moment.

**The notes panel** lists every mark, highlights the one you've most recently reached, and
scrolls to keep it in view. Click any note to jump there. The **Summary** tab holds a
rundown of every note plus your own written thoughts on the match, and **View summary**
opens both side by side.

**Sessions** — each video you open becomes a session on the home screen, with its notes,
summary and name. Rename one with the pencil that appears when you hover it; the video
itself is remembered, so clicking a session reopens it. If the file has moved, the session
says so and offers to point at its new location — your notes reattach either way.

---

## Development

```bash
npm test                          # store and byte-range streaming, headless
npx electron electron/smoke.js    # launches the real window and checks it
npm run icon                      # regenerates build/icon.ico from build/make-icon.js
```

The app itself is three files — `video-notes.html`, `styles.css`, `app.js` — with no build
step and no framework. `electron/` adds the desktop shell: a loopback server (which is what
lets YouTube embed and lets local video stream with seeking), a file-backed store, and a
preload bridge. Adding `?test=1` to the URL routes all storage to a throwaway database, so
tests can never touch real notes.
