# Video Notes

A match analysis tool. Play a video — a local file or a YouTube link — pause on a moment,
draw on the frame, and write a note against that timestamp. Play back and your drawings
reappear over the moving picture at the moments they belong to.

Everything stays on your machine. Nothing is uploaded.

---

## Installing

**[Download the latest release.](https://github.com/Carel-Haasbroek/Match-Analysis-Tool/releases/latest)**
That link always points at the newest one, and every release carries both builds below.
Take one file, run it; nothing else here is needed.

Building them yourself puts the same two in `dist/`, one per folder so they cannot be
confused:

| | |
|---|---|
| **`dist/installer/Video Notes Setup 1.0.0.exe`** | Normal installer. Start Menu entry, uninstaller, lets you choose the install folder. |
| **`dist/portable/VideoNotes-1.0.0-portable.exe`** | Single file, no installation. Copy it anywhere and double-click. Good for a USB stick or a machine you don't want to install on. |

### Running the installer

1. Double-click **`Video Notes Setup 1.0.0.exe`**.
2. **Windows will show a blue "Windows protected your PC" box.** This is expected —
   the build isn't code-signed, and Windows warns about any unsigned installer.
   Click **More info**, then **Run anyway**.
3. Choose an install folder if you want to change it, and finish.
4. Launch **Video Notes** from the Start Menu.

The portable exe shows the same warning on first run, and is dismissed the same way.
Signing the build would remove it, but that needs a paid certificate.

Copy the portable exe somewhere of its own before you use it — **not** left inside `dist/`.
It keeps your notes in a `Notes` folder beside itself, and `dist/` is build output that a
rebuild or a clean-up can empty.

Uninstall through Settings → Apps, or the uninstaller in the install folder. **Uninstalling
does not delete your notes** — see below.

---

## Where your notes live

In a **`Notes` folder beside the app** — a plain folder tree you can open, browse, copy to a
USB stick or put in Dropbox. The home screen shows the exact path at the top; click it to
open the folder.

```
Notes/
  library.json                  the sessions you have opened
  prefs.json                    your name, theme, hold time, volume
  Competition 2026/             a folder you made on the home screen
    Jack round 1/               one session
      session.json              the moments and their comment threads
      summary.md                your written summary, as plain markdown
      drawings/                 one PNG per drawing, named for its timestamp
```

Grouping a session into a folder on the home screen moves its folder on disk, and the other
way round works too. The exact location depends on how the app is running:

| | |
|---|---|
| Installed | `Notes` beside the installed exe |
| Portable | `Notes` beside the portable exe — carry both on a stick together |
| From source | `Notes` in the project folder |
| If none of those can be written to | `%APPDATA%\video-notes\Notes` |

An installed build lands on that last row when it is installed under Program Files, which
needs elevation to write to.

Three consequences worth knowing:

- Uninstalling the app leaves your notes untouched. Reinstalling picks them straight back up.
- Notes from before this layout, in `%APPDATA%\video-notes\store`, are moved across
  automatically the first time you run the app. The old copy is left exactly where it was
  and a backup is written first, so the move cannot cost you anything.
- Notes made in the **browser** version live somewhere else entirely (the browser's own
  storage, per site). They do not appear in the desktop app. To carry them across, use
  **Export all notes** in the browser and **Import backup** in the app.

### Backing up

On the home screen, **Export all notes** writes one JSON file holding every note, every
comment, every summary and every session name. **Import backup** merges it back — it only
ever adds, never overwrites or deletes, so restoring an old backup can't cost you newer
work. Threads are merged comment by comment, which is also how you take another coach's
file: their remarks land alongside yours on the same moments.

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

Artifacts land in `dist/installer/` and `dist/portable/`; `dist/win-unpacked/` is the
intermediate both are built from. The first build downloads a Windows toolchain, so give it
a few minutes.

### Releasing

Tagging a version is what publishes it. A workflow builds on Windows and uploads both exes
to a GitHub Release, so binaries stay out of the repo and clones stay small.

```bash
npm version 1.0.1                        # bumps package.json, commits, tags v1.0.1
git push origin master --follow-tags     # the tag is what triggers the build
```

Use `npm version` rather than tagging by hand. electron-builder names every artifact from
`package.json`, never from the tag, so a tag that disagrees with it publishes a release full
of files from the wrong version — the workflow refuses to build in that case rather than
letting it happen quietly.

### The browser version

The same app runs as a plain web page, but it must be served over `http://` — YouTube
refuses to embed into a `file://` page, and opening `app.html` directly gives
"error 153". Any static server works:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/app.html>. Local video files work either way; only
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

**Several coaches on one video** — the first time you open the app it asks for your name,
and everything you write is signed with it. Every marked moment holds a thread rather than a
single line: the box under a moment in the notes panel adds another comment, so two coaches
can disagree about the same tackle and you can see who said what. Change your name from
**Who is commenting** on the home screen; comments already saved keep the name they were
written under. Notes made before this existed are signed with the name you give at that
first prompt.

Send a coach your **Export all notes** file and have them import it: threads are merged
comment by comment, so their remarks land alongside yours instead of replacing them, and
importing the same file twice changes nothing.

**Sessions** — each video you open becomes a session on the home screen, with its notes,
summary and name. Rename one with the pencil that appears when you hover it; the video
itself is remembered, so clicking a session reopens it. If the file has moved, the session
says so and offers to point at its new location — your notes reattach either way.

**Grouping** — the dropdown on a session puts it in a folder, and **New folder…** makes one.
Folders nest, and they are real folders: grouping a session moves its folder inside the
`Notes` tree, so what you see on the home screen is what you see in Explorer.

**Look** — eight themes on the home screen, including MS-DOS phosphor green, an amber CRT,
Windows 95 grey with proper bevels, Game Boy olive, blueprint, paper for daylight and
vaporwave. The pen colours are deliberately left alone by all of them: those are your
content, not decoration.

---

## Development

```bash
npm test                          # store and byte-range streaming, headless
npx electron electron/smoke.js       # launches the real window and checks it
npx electron electron/commenttest.js # names, threads and merging, in the real window
npm run icon                      # regenerates build/icon.ico from build/make-icon.js
```

The app itself is three files — `app.html`, `styles.css`, `app.js` — with no build
step and no framework. `electron/` adds the desktop shell: a loopback server (which is what
lets YouTube embed and lets local video stream with seeking), a file-backed store, and a
preload bridge. Adding `?test=1` to the URL routes all storage to a throwaway database, so
tests can never touch real notes.
