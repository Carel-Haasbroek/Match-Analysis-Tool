'use strict';
/*
 * A loopback HTTP server for the app itself and for video.
 *
 * Why HTTP rather than file:// — YouTube refuses to embed into a null origin (the
 * "error 153" the browser build hits), and http://127.0.0.1 gives it a real one.
 *
 * Why streaming rather than an object URL — a match can be several gigabytes, and
 * Range support is what makes seeking work at all.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg'
};

function createServer(opts){
  const root = opts.root;
  /* Only paths the user has actually chosen may be read. Without this, any page
     loaded in the window could pull arbitrary files off the disk. */
  const allowed = new Set();

  const server = http.createServer((req, res) => {
    let parsed;
    try { parsed = new URL(req.url, 'http://127.0.0.1'); }
    catch (e) { res.writeHead(400).end('bad request'); return; }

    if (parsed.pathname === '/media'){ return serveMedia(req, res, parsed.searchParams.get('p')); }
    return serveStatic(req, res, decodeURIComponent(parsed.pathname));
  });

  /* An explicit list, not "anything under the app folder": the folder also holds
     package.json and the main-process sources, and none of those belong on a socket.
     URL normalisation already collapses "..", so this is the real guard. */
  const SERVE = new Set(['app.html', 'styles.css', 'app.js']);

  function serveStatic(req, res, pathname){
    const rel = (!pathname || pathname === '/') ? 'app.html' : pathname.replace(/^\/+/, '');
    if (!SERVE.has(rel)){ res.writeHead(404).end('not found'); return; }
    const file = path.join(root, rel);
    fs.readFile(file, (err, buf) => {
      if (err){ res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  }

  function serveMedia(req, res, encoded){
    if (!encoded){ res.writeHead(400).end('missing path'); return; }
    let file;
    try { file = Buffer.from(String(encoded), 'base64url').toString('utf8'); }
    catch (e){ res.writeHead(400).end('bad path'); return; }

    if (!allowed.has(path.resolve(file))){ res.writeHead(403).end('not permitted'); return; }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()){ res.writeHead(404).end('not found'); return; }

      const type = TYPES[path.extname(file).toLowerCase()] || 'video/mp4';
      const range = req.headers.range;

      if (!range){
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (!m){ res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }).end(); return; }

      let start, end;
      if (m[1] === ''){
        /* suffix form: "bytes=-500" means the last 500 bytes */
        const len = parseInt(m[2], 10);
        if (!isFinite(len) || len <= 0){ res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }).end(); return; }
        start = Math.max(0, stat.size - len);
        end = stat.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
      }

      if (!isFinite(start) || start >= stat.size || start < 0){
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }).end();
        return;
      }
      if (!isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (end < start){ res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }).end(); return; }

      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': (end - start) + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    });
  }

  return {
    server,
    allow(file){ allowed.add(path.resolve(file)); },
    isAllowed(file){ return allowed.has(path.resolve(file)); },
    listen(){
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        /* port 0: the OS picks a free one. Storage no longer depends on the origin,
           so the port can change between runs without stranding any notes. */
        server.listen(opts.port || 0, '127.0.0.1', () => resolve(server.address().port));
      });
    }
  };
}

module.exports = { createServer };
