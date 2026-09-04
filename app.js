(function(){
  "use strict";

  var $ = function(id){ return document.getElementById(id); };

  var video = $('video'), ytHolder = $('yt-holder');
  var canvas = $('draw-canvas'), ctx = canvas.getContext('2d');
  var frameBuf = document.createElement('canvas'), fctx = frameBuf.getContext('2d');
  var fileInput = $('file-input'), fileNameEl = $('file-name'), statusEl = $('status');
  var homeView = $('home'), startClose = $('start-close'), videoWrap = $('video-wrap');
  var workspace = document.querySelector('.workspace');
  var recentList = $('recent-list'), urlInput = $('url-input'), topUrlInput = $('top-url-input');
  var seek = $('seek'), markStrip = $('mark-strip');
  var playBtn = $('play-btn'), backBtn = $('back-btn'), fwdBtn = $('fwd-btn');
  var timeDisplay = $('time-display'), markBtn = $('mark-btn');
  var drawToolbar = $('draw-toolbar'), noteTextInput = $('note-text'), drawHint = $('draw-hint');
  var notesList = $('notes-list'), notesHeading = $('notes-heading');
  var summaryText = $('summary-text');
  var holdRange = $('hold-range'), holdValue = $('hold-value');
  var playerHud = $('player-hud'), nextNoteBtn = $('next-note-btn'), autoPauseBox = $('auto-pause');
  var noteView = $('note-view'), noteViewTime = $('note-view-time'), noteViewText = $('note-view-text');
  var muteBtn = $('mute-btn'), volumeRange = $('volume');
  var summaryModal = $('summary-modal'), summaryModalText = $('summary-modal-text');
  var lightbox = $('lightbox'), lightboxImg = $('lightbox-img'), lightboxTime = $('lightbox-time'),
      lightboxText = $('lightbox-text');

  var notes = [], videoKey = null, currentLabel = '';
  var player = null, source = null, library = [], pendingKey = null, pendingNotice = '';
  var drawing = false, shapes = [], activeShape = null, startPt = null;
  var tool = 'pen', color = '#ff2d78', size = 3, capturedTime = 0, lightboxNote = null;
  var hasFrame = false, reviewNote = null, overlayKey = null;
  var overlayTimer = null, overlayEndsAt = 0, overlayRemaining = 0, lastSyncTime = 0;
  var autoPause = false, playTarget = null, panelNoteId = null, notePanelOpen = true;
  var volume = 1, muted = false;
  var hudIdleTimer = null;
  var activePane = 'notes';

  var LIB_KEY = 'vnotes:index', LIB_MAX = 40;
  var IS_FILE = location.protocol === 'file:';
  /* Present only under Electron; its absence keeps every browser path untouched. */
  var DESKTOP = (typeof window.desktop === 'object' && window.desktop &&
                 typeof window.desktop.openVideo === 'function') ? window.desktop : null;

  /* How long a note's drawing stays on screen once the playhead reaches it,
     in seconds. User-adjustable; persisted in PREFS_KEY. */
  var overlayHold = 1;
  var HOLD_MIN = 0.01, HOLD_MAX = 2, PREFS_KEY = 'vnotes:prefs';

  /* Adding ?test=1 to the URL moves every read and write to a throwaway database,
     so automated checks can never reach real notes. Never remove this. */
  var TEST_MODE = /[?&]test=1\b/.test(location.search);
  var DB_NAME = TEST_MODE ? 'video-notes-test' : 'video-notes';
  var KEY_PREFIX = TEST_MODE ? 'test:' : '';

  /* ---------- storage: window.storage -> IndexedDB -> memory ---------- */
  var memStore = {};
  var store = (function(){
    var hasWinStorage = (typeof window.storage === 'object' && window.storage &&
                         typeof window.storage.get === 'function');
    var db = null, dbReady = null;

    function openDB(){
      if (dbReady) return dbReady;
      dbReady = new Promise(function(resolve){
        try{
          var req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = function(){
            req.result.createObjectStore('notes');
          };
          req.onsuccess = function(){ db = req.result; resolve(true); };
          req.onerror = function(){ resolve(false); };
        }catch(e){ resolve(false); }
      });
      return dbReady;
    }

    function idbOp(mode, fn){
      return openDB().then(function(ok){
        if (!ok || !db) return null;
        return new Promise(function(resolve){
          try{
            var tx = db.transaction('notes', mode);
            var req = fn(tx.objectStore('notes'));
            req.onsuccess = function(){ resolve(req.result); };
            req.onerror = function(){ resolve(null); };
          }catch(e){ resolve(null); }
        });
      });
    }

    return {
      label: hasWinStorage ? 'saved in this session' : 'saved on this device',
      get: function(key){
        var k = KEY_PREFIX + key;
        if (hasWinStorage){
          return window.storage.get(k, false)
            .then(function(r){ return r && r.value ? JSON.parse(r.value) : null; })
            .catch(function(){ return memStore[k] || null; });
        }
        return idbOp('readonly', function(s){ return s.get(k); })
          .then(function(v){ return v != null ? v : (memStore[k] || null); });
      },
      set: function(key, value){
        var k = KEY_PREFIX + key;
        memStore[k] = value;
        if (hasWinStorage){
          return window.storage.set(k, JSON.stringify(value), false).catch(function(){});
        }
        return idbOp('readwrite', function(s){ return s.put(value, k); });
      },
      /* Every stored key, unprefixed — used only to build a full backup.
         A host store must expose keys() of its own: falling back to memStore would
         quietly reduce "back up everything" to "back up what I opened today". */
      keys: function(){
        var source;
        if (hasWinStorage && typeof window.storage.keys === 'function'){
          source = Promise.resolve(window.storage.keys()).catch(function(){
            return Object.keys(memStore);
          });
        } else if (hasWinStorage){
          source = Promise.resolve(Object.keys(memStore));
        } else {
          source = idbOp('readonly', function(s){ return s.getAllKeys(); });
        }
        return source.then(function(list){
          if (!list) list = Object.keys(memStore);
          return list.filter(function(k){
            return typeof k === 'string' && k.indexOf(KEY_PREFIX) === 0;
          }).map(function(k){ return k.slice(KEY_PREFIX.length); });
        });
      }
    };
  })();

  /* ---------- helpers ---------- */
  function fmt(sec){
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
    var mm = h > 0 ? String(m).padStart(2,'0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2,'0');
  }
  function keyFor(file){
    return 'vnotes:' + (file.name + '_' + file.size).replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,150);
  }
  function setStatus(msg){ statusEl.textContent = msg; }

  /* A notice outranks the routine note-count line for a moment, so that async
     work finishing in any order (metadata, stored notes) cannot wipe it. */
  var noticeUntil = 0;
  function setNotice(msg, ms){
    noticeUntil = Date.now() + (ms || 6000);
    setStatus(msg);
  }
  function refreshStatus(){
    if (Date.now() < noticeUntil) return;
    setStatus(notes.length
      ? notes.length + ' note' + (notes.length === 1 ? '' : 's') + ' · ' + store.label
      : '');
  }
  /* A session's name: whatever the user typed, else the auto-derived filename or
     YouTube title. The storage key never changes, so renaming can't detach notes. */
  function entryFor(key){
    for (var i = 0; i < library.length; i++){
      if (library[i].key === key) return library[i];
    }
    return null;
  }
  function autoName(entry){
    return entry.label || entry.fileName || entry.videoId || 'Untitled';
  }
  function entryName(entry){
    return (entry.customName && entry.customName.trim()) || autoName(entry);
  }
  function displayName(){
    var e = videoKey ? entryFor(videoKey) : null;
    return (e && e.customName && e.customName.trim()) || currentLabel || '';
  }
  function refreshName(){
    var n = displayName();
    fileNameEl.textContent = n;
    fileNameEl.title = (source && source.url) ? source.url + ' — ' + n : n;
  }

  function relTime(ts){
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60e3) return 'just now';
    if (d < 3600e3) return Math.round(d/60e3) + ' min ago';
    if (d < 86400e3) return Math.round(d/3600e3) + 'h ago';
    if (d < 172800e3) return 'yesterday';
    if (d < 2592000e3) return Math.round(d/86400e3) + ' days ago';
    return new Date(ts).toLocaleDateString();
  }
  function safeName(s){
    return String(s || 'video').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim().slice(0,80);
  }

  /* ---------- youtube link parsing ---------- */
  function parseTimeParam(v){
    if (!v) return 0;
    v = String(v).trim();
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(v);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return (+(m[1]||0))*3600 + (+(m[2]||0))*60 + (+(m[3]||0));
  }

  function parseYouTube(str){
    if (!str) return null;
    str = String(str).trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(str)) return { videoId: str, startAt: 0 };

    var url;
    try{ url = new URL(/^[a-z]+:\/\//i.test(str) ? str : 'https://' + str); }
    catch(e){ return null; }

    var host = url.hostname.replace(/^www\./,'').replace(/^m\./,'');
    var id = null;
    if (host === 'youtu.be'){
      id = url.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com'){
      if (url.pathname === '/watch'){
        id = url.searchParams.get('v');
      } else {
        var m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
        if (m) id = m[1];
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return {
      videoId: id,
      startAt: parseTimeParam(url.searchParams.get('t') || url.searchParams.get('start') || '')
    };
  }

  /* ---------- source: local file ---------- */
  /* src is { url, revoke }: a browser passes an object URL that must be revoked,
     the desktop passes a /media stream URL that must not be. */
  function createFileSource(src){
    var api = { kind:'file', onReady:null, onTick:null, onPlayState:null, onError:null };
    var myUrl = null;

    function onMeta(){ if (api.onReady) api.onReady(); }
    function onTU(){ if (api.onTick) api.onTick(video.currentTime || 0); }
    function onPlay(){ if (api.onPlayState) api.onPlayState(true); }
    function onPause(){ if (api.onPlayState) api.onPlayState(false); }
    function onErr(){ if (api.onError) api.onError('This browser could not decode that video file.'); }

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('timeupdate', onTU);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onErr);

    ytHolder.style.display = 'none';
    ytHolder.innerHTML = '';
    video.style.display = 'block';
    myUrl = src.revoke ? src.url : null;
    video.src = src.url;
    video.load();

    api.play = function(){ video.play(); };
    api.pause = function(){ video.pause(); };
    api.isPaused = function(){ return video.paused; };
    api.getTime = function(){ return video.currentTime || 0; };
    api.setTime = function(t){ video.currentTime = t; };
    api.getDuration = function(){ return video.duration || 0; };
    api.getAspect = function(){
      return video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null;
    };
    api.getTitle = function(){ return ''; };
    api.getVolume = function(){ return video.volume; };            /* 0..1 */
    api.setVolume = function(v){ video.volume = v; };
    api.isMuted = function(){ return video.muted; };
    api.setMuted = function(m){ video.muted = !!m; };
    api.canCaptureFrame = function(){ return true; };
    api.captureFrame = function(c, w, h){ c.drawImage(video, 0, 0, w, h); };
    api.destroy = function(){
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('timeupdate', onTU);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('error', onErr);
      try{ video.pause(); }catch(e){}
      video.removeAttribute('src');
      try{ video.load(); }catch(e){}
      if (myUrl){ URL.revokeObjectURL(myUrl); myUrl = null; }
    };
    return api;
  }

  /* ---------- source: youtube ---------- */
  var ytApiPromise = null;
  function loadYouTubeApi(){
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise(function(resolve, reject){
      if (window.YT && window.YT.Player){ resolve(); return; }
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function(){
        if (typeof prev === 'function') prev();
        resolve();
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = function(){ reject(new Error('Could not reach YouTube — check your connection.')); };
      document.head.appendChild(s);
      setTimeout(function(){
        if (!(window.YT && window.YT.Player)){
          reject(new Error('The YouTube player did not load. Serve this page over http:// rather than opening the file directly.'));
        }
      }, 12000);
    }).catch(function(err){ ytApiPromise = null; throw err; });
    return ytApiPromise;
  }

  function ytErrorText(code){
    if (code === 2) return 'That video id is not valid.';
    if (code === 5) return 'YouTube could not play that video here.';
    if (code === 100) return 'That video is private or no longer available.';
    if (code === 101 || code === 150) return 'The owner of that video has disabled embedding, so it cannot be annotated here.';
    return 'YouTube reported an error loading that video.';
  }

  function createYouTubeSource(videoId, startAt){
    var api = { kind:'youtube', onReady:null, onTick:null, onPlayState:null, onError:null };
    var yt = null, timer = null, dead = false, dur = 0, title = '';
    /* YT.seekTo() starts playback unless the player is already paused, which would
       wipe a note's replay overlay the moment you jump to it. pauseRequested records
       what we asked for; repauseUntil is the short window in which an unwanted
       PLAYING state gets pushed back to paused. */
    var pauseRequested = false, repauseUntil = 0;
    /* Volume can be set before the iframe API is ready; apply it on load. */
    var pendingVolume = 1, pendingMuted = false;

    video.style.display = 'none';
    ytHolder.style.display = 'block'; /* the stylesheet hides it by default */
    ytHolder.innerHTML = '<div id="yt-frame"></div>';

    function tick(){
      if (!yt || dead) return;
      var d = yt.getDuration ? (yt.getDuration() || 0) : 0;
      if (d) dur = d;
      if (api.onTick) api.onTick(yt.getCurrentTime() || 0);
    }

    var vars = { playsinline:1, rel:0, modestbranding:1, start: Math.floor(startAt || 0) };
    if (location.protocol === 'http:' || location.protocol === 'https:') vars.origin = location.origin;

    loadYouTubeApi().then(function(){
      if (dead) return;
      yt = new YT.Player('yt-frame', {
        videoId: videoId,
        playerVars: vars,
        events: {
          onReady: function(){
            if (dead) return;
            dur = yt.getDuration() || 0;
            try{ title = (yt.getVideoData() || {}).title || ''; }catch(e){}
            try{
              yt.setVolume(Math.round(pendingVolume * 100));
              if (pendingMuted) yt.mute(); else yt.unMute();
            }catch(e){}
            if (startAt) yt.seekTo(startAt, true);
            timer = setInterval(tick, 150);
            if (api.onReady) api.onReady();
          },
          onStateChange: function(e){
            if (dead) return;
            if (!title){
              try{ title = (yt.getVideoData() || {}).title || ''; }catch(err){}
            }
            if (e.data === YT.PlayerState.PLAYING){
              if (repauseUntil && Date.now() < repauseUntil){
                repauseUntil = 0;
                yt.pauseVideo();
                return;
              }
              pauseRequested = false;
              dur = yt.getDuration() || dur;
              if (api.onPlayState) api.onPlayState(true);
            } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED){
              if (api.onPlayState) api.onPlayState(false);
            }
          },
          onError: function(e){
            if (!dead && api.onError) api.onError(ytErrorText(e.data));
          }
        }
      });
    }).catch(function(err){
      if (!dead && api.onError) api.onError(err.message);
    });

    api.play = function(){
      pauseRequested = false; repauseUntil = 0;
      if (yt && yt.playVideo) yt.playVideo();
    };
    api.pause = function(){
      pauseRequested = true;
      if (yt && yt.pauseVideo) yt.pauseVideo();
    };
    api.isPaused = function(){
      if (!yt || !yt.getPlayerState) return true;
      return yt.getPlayerState() !== 1;
    };
    api.getTime = function(){ return (yt && yt.getCurrentTime) ? (yt.getCurrentTime() || 0) : 0; };
    api.setTime = function(t){
      if (!yt || !yt.seekTo) return;
      var state = yt.getPlayerState();
      /* Seeking a *playing* player keeps it playing, so settle it into PAUSED first
         and seek after — otherwise a jump to a note plays straight through the
         moment you wanted to look at. */
      if (pauseRequested && state === YT.PlayerState.PLAYING){
        yt.pauseVideo();
        var tries = 0;
        var wait = setInterval(function(){
          if (dead){ clearInterval(wait); return; }
          var s = yt.getPlayerState();
          if (s === YT.PlayerState.PAUSED || ++tries > 20){
            clearInterval(wait);
            yt.seekTo(t, true);
          }
        }, 50);
        return;
      }
      /* From unstarted/cued/buffering, seekTo starts playback on its own. */
      if (pauseRequested || state !== YT.PlayerState.PLAYING) repauseUntil = Date.now() + 2500;
      yt.seekTo(t, true);
    };
    api.getDuration = function(){ return dur; };
    api.getAspect = function(){ return null; };
    api.getTitle = function(){ return title; };
    /* YouTube speaks 0..100; the rest of the app speaks 0..1. */
    api.getVolume = function(){
      return (yt && yt.getVolume) ? (yt.getVolume() / 100) : pendingVolume;
    };
    api.setVolume = function(v){
      pendingVolume = v;
      if (yt && yt.setVolume) yt.setVolume(Math.round(v * 100));
    };
    api.isMuted = function(){
      return (yt && yt.isMuted) ? yt.isMuted() : pendingMuted;
    };
    api.setMuted = function(m){
      pendingMuted = !!m;
      if (!yt) return;
      if (m){ if (yt.mute) yt.mute(); }
      else { if (yt.unMute) yt.unMute(); }
    };
    api.canCaptureFrame = function(){ return false; };
    api.captureFrame = function(){};
    api.destroy = function(){
      dead = true;
      if (timer){ clearInterval(timer); timer = null; }
      try{ if (yt && yt.destroy) yt.destroy(); }catch(e){}
      yt = null;
      ytHolder.innerHTML = '';
      ytHolder.style.display = 'none';
    };
    return api;
  }

  /* ---------- opening a source ---------- */
  /* makePlayer is a factory, not an instance: the previous source must be torn
     down before the next one touches the shared <video> / #yt-holder elements. */
  function openSource(makePlayer, src){
    if (player){ player.destroy(); player = null; }
    exitDraw();
    imgCache = {};
    playTarget = null;
    panelNoteId = null;
    noteView.classList.add('hidden');
    clearHideTimer();
    overlayRemaining = 0;
    lastSyncTime = 0;
    overlayKey = null;
    hideOverlay();

    source = src;
    videoKey = src.key;
    currentLabel = src.label;
    fileNameEl.textContent = src.label;
    fileNameEl.title = src.url || src.label;
    hideStart();

    [playBtn, backBtn, fwdBtn, nextNoteBtn, markBtn, seek, muteBtn, volumeRange]
      .forEach(function(el){ el.disabled = false; });
    videoWrap.style.setProperty('--ar', 16/9);
    seek.value = 0;
    seek.max = 100;
    playerHud.classList.remove('playing');
    noticeUntil = 0; /* a new source supersedes any notice about the previous one */
    setStatus(src.kind === 'youtube' ? 'Loading the YouTube player…' : '');

    var p = player = makePlayer();
    applySound();

    p.onReady = function(){
      var a = p.getAspect();
      if (a && a.w && a.h) videoWrap.style.setProperty('--ar', a.w / a.h);
      var d = p.getDuration();
      if (d) seek.max = d;
      var t = p.getTitle();
      if (t && t !== source.label){
        /* Refresh the auto-derived name only; a name the user typed still wins. */
        source.label = currentLabel = t;
        touchLibrary();
        refreshName();
      }
      updateTime();
      renderMarks();
      refreshStatus();
    };

    p.onTick = function(t){
      var d = p.getDuration();
      if (d && Math.abs(parseFloat(seek.max) - d) > 0.5){
        seek.max = d;
        renderMarks();
      }
      if (document.activeElement !== seek) seek.value = t;
      updateTime();

      var prev = lastSyncTime;      /* read before syncOverlay advances it */
      syncOverlay(t);
      considerStop(prev, t);
    };

    p.onPlayState = function(playing){
      playerHud.classList.toggle('playing', playing);
      if (playing){ thawHide(); hudIdleSoon(); }
      else { freezeHide(); showHud(); }
    };

    p.onError = function(msg){ setNotice(msg, 60000); };

    store.get(videoKey).then(function(saved){
      notes = Array.isArray(saved) ? saved : [];
      renderNotes();
      renderMarks();
      touchLibrary();
      refreshName();
      /* set last: renderNotes() rewrites the status line */
      if (pendingNotice){ setNotice(pendingNotice); pendingNotice = ''; }
    });
    loadSummary();
  }

  function loadFileVideo(file, expectKey){
    openFileDescriptor({
      name: file.name, size: file.size,
      url: URL.createObjectURL(file), revoke: true
    }, expectKey);
  }

  /* The desktop route: a remembered path, streamed. The key is still name + size,
     so a video reopened this way lands on the notes it already had. */
  function loadFilePath(info, expectKey){
    openFileDescriptor({
      name: info.name, size: info.size, url: info.url, revoke: false, path: info.path
    }, expectKey);
  }

  function openFileDescriptor(d, expectKey){
    var key = keyFor({ name: d.name, size: d.size });
    pendingNotice = (expectKey && expectKey !== key)
      ? 'That is a different file — starting a fresh set of notes.'
      : '';
    openSource(function(){ return createFileSource(d); }, {
      kind: 'file', key: key, label: d.name,
      fileName: d.name, fileSize: d.size, filePath: d.path || null
    });
  }

  function loadYouTubeVideo(videoId, startAt, label){
    openSource(function(){ return createYouTubeSource(videoId, startAt); }, {
      kind: 'youtube',
      key: 'vnotes:yt:' + videoId,
      label: label || ('YouTube · ' + videoId),
      videoId: videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId
    });
  }

  function openUrl(str){
    var p = parseYouTube(str);
    if (!p){
      setNotice('That does not look like a YouTube link.');
      return false;
    }
    /* YouTube refuses to embed into a file:// page (null origin -> error 153).
       Say so plainly rather than handing the user YouTube's own error screen. */
    if (IS_FILE){
      setNotice('YouTube needs this page served over http:// — see the note on the start screen.', 20000);
      showStart();
      return false;
    }
    var known = null;
    for (var i = 0; i < library.length; i++){
      if (library[i].key === 'vnotes:yt:' + p.videoId){ known = library[i]; break; }
    }
    loadYouTubeVideo(p.videoId, p.startAt, known && known.label);
    return true;
  }

  /* ---------- picking a file ---------- */
  function chooseVideo(expectKey){
    if (!DESKTOP){ pendingKey = expectKey || null; fileInput.click(); return; }
    DESKTOP.openVideo().then(function(info){
      if (info) loadFilePath(info, expectKey || null);
    });
  }
  $('load-btn').addEventListener('click', function(){ chooseVideo(null); });
  $('empty-load-btn').addEventListener('click', function(){ chooseVideo(null); });

  fileInput.addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    var expect = pendingKey;
    pendingKey = null;
    if (f) loadFileVideo(f, expect);
    fileInput.value = '';
  });

  videoWrap.addEventListener('dragover', function(e){ e.preventDefault(); });
  videoWrap.addEventListener('drop', function(e){
    e.preventDefault();
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.indexOf('video/') === 0) loadFileVideo(f, null);
  });

  $('top-url-form').addEventListener('submit', function(e){
    e.preventDefault();
    if (openUrl(topUrlInput.value)) topUrlInput.value = '';
  });
  $('start-url-form').addEventListener('submit', function(e){
    e.preventDefault();
    if (openUrl(urlInput.value)) urlInput.value = '';
  });

  /* ---------- start screen + library ---------- */
  /* Home and the player are alternate views of the whole page, not an overlay. */
  function showStart(){
    homeView.classList.remove('hidden');
    workspace.classList.add('hidden');
    startClose.classList.toggle('hidden', !player);
    renderRecent();
  }
  function hideStart(){
    homeView.classList.add('hidden');
    workspace.classList.remove('hidden');
  }

  $('recent-btn').addEventListener('click', showStart);
  $('session-filter').addEventListener('input', renderRecent);
  startClose.addEventListener('click', function(){ if (player) hideStart(); });

  function loadLibrary(){
    return store.get(LIB_KEY).then(function(v){
      library = Array.isArray(v) ? v : [];
      renderRecent();
    });
  }
  function saveLibrary(){ store.set(LIB_KEY, library); }

  function touchLibrary(){
    if (!source) return;
    var entry = null;
    for (var i = 0; i < library.length; i++){
      if (library[i].key === source.key){ entry = library.splice(i, 1)[0]; break; }
    }
    if (!entry) entry = { key: source.key, kind: source.kind };
    entry.label = source.label;
    entry.videoId = source.videoId || null;
    entry.url = source.url || null;
    entry.fileName = source.fileName || null;
    entry.fileSize = source.fileSize || null;
    if (source.filePath) entry.filePath = source.filePath;
    entry.noteCount = notes.length;
    entry.lastOpened = Date.now();
    library.unshift(entry);
    if (library.length > LIB_MAX) library.length = LIB_MAX;
    saveLibrary();
    renderRecent();
  }

  function forgetEntry(key){
    library = library.filter(function(e){ return e.key !== key; });
    saveLibrary();
    renderRecent();
  }

  function openEntry(entry){
    if (entry.kind === 'youtube' && entry.videoId){
      loadYouTubeVideo(entry.videoId, 0, entry.label);   /* customName applied by refreshName */
      return;
    }
    if (DESKTOP && entry.filePath){
      DESKTOP.statVideo(entry.filePath).then(function(info){
        if (info){ loadFilePath(info, entry.key); return; }
        markUnavailable(entry);
      });
      return;
    }
    if (DESKTOP){ chooseVideo(entry.key); return; }
    pendingKey = entry.key;
    setNotice('Choose "' + (entry.fileName || autoName(entry)) + '" again to reopen its notes.');
    fileInput.click();
  }

  /* The video has moved or its drive is not connected. Say which file, and offer to
     point at it again — the key is name + size, so the notes reattach untouched. */
  function markUnavailable(entry){
    entry.missing = true;
    saveLibrary();
    renderRecent();
    setNotice('“' + entryName(entry) + '” — video not found at ' + entry.filePath, 20000);
  }

  function relocate(entry){
    if (!DESKTOP) return;
    DESKTOP.openVideo().then(function(info){
      if (!info) return;
      delete entry.missing;
      entry.filePath = info.path;
      saveLibrary();
      loadFilePath(info, entry.key);
    });
  }

  function renderRecent(){
    recentList.innerHTML = '';
    var q = ($('session-filter').value || '').trim().toLowerCase();
    var shown = q
      ? library.filter(function(e){ return entryName(e).toLowerCase().indexOf(q) >= 0; })
      : library;
    if (q && !shown.length){
      var none = document.createElement('div');
      none.className = 'recent-empty';
      none.textContent = 'No session matches "' + q + '".';
      recentList.appendChild(none);
      return;
    }
    if (!library.length){
      var empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = 'Nothing yet. Videos and links you open show up here.';
      recentList.appendChild(empty);
      return;
    }

    shown.forEach(function(entry){
      var row = document.createElement('div');
      row.className = 'recent-row';

      var kind = document.createElement('span');
      kind.className = 'recent-kind ' + (entry.kind === 'youtube' ? 'yt' : 'file');
      kind.textContent = entry.kind === 'youtube' ? 'YT' : 'FILE';

      var main = document.createElement('div');
      main.className = 'recent-main';
      var label = document.createElement('div');
      label.className = 'recent-label';
      label.textContent = entryName(entry);
      var meta = document.createElement('div');
      meta.className = 'recent-meta';
      var bits = [(entry.noteCount || 0) + ' note' + (entry.noteCount === 1 ? '' : 's')];
      if (entry.lastOpened) bits.push(relTime(entry.lastOpened));
      /* once renamed, still say which video it is */
      if (entry.customName && entry.customName.trim()) bits.push(autoName(entry));
      if (entry.kind === 'file' && !(DESKTOP && entry.filePath)) bits.push('pick the file again');
      meta.textContent = bits.join(' · ');
      if (entry.missing && entry.filePath){
        row.classList.add('missing');
        var warn = document.createElement('div');
        warn.className = 'recent-missing';
        warn.textContent = 'Video not found at ' + entry.filePath;
        main.appendChild(warn);
      }
      main.appendChild(label);
      main.appendChild(meta);

      function beginRename(){
        if (main.querySelector('.recent-rename')) return;
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'recent-rename';
        input.value = entryName(entry);
        input.setAttribute('aria-label', 'Session name');
        main.replaceChild(input, label);
        input.focus();
        input.select();

        var settled = false;
        function commit(save){
          if (settled) return;
          settled = true;
          if (save){
            var v = input.value.trim();
            /* clearing the box hands the name back to the file or video title */
            if (v && v !== autoName(entry)) entry.customName = v;
            else delete entry.customName;
            saveLibrary();
            if (videoKey === entry.key) refreshName();
          }
          renderRecent();
        }
        input.addEventListener('click', function(e){ e.stopPropagation(); });
        input.addEventListener('keydown', function(e){
          e.stopPropagation();
          if (e.key === 'Enter'){ e.preventDefault(); commit(true); }
          if (e.key === 'Escape'){ e.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', function(){ commit(true); });
      }

      if (entry.missing && DESKTOP){
        var loc = document.createElement('button');
        loc.type = 'button';
        loc.className = 'recent-locate';
        loc.textContent = 'Locate video';
        loc.addEventListener('click', function(e){ e.stopPropagation(); relocate(entry); });
        row.appendChild(loc);
      }

      var rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'recent-edit';
      rename.textContent = '✎';
      rename.title = 'Rename this session';
      rename.addEventListener('click', function(e){ e.stopPropagation(); beginRename(); });

      var forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'recent-forget';
      forget.textContent = '✕';
      forget.title = 'Forget this entry';
      forget.addEventListener('click', function(e){ e.stopPropagation(); forgetEntry(entry.key); });

      row.appendChild(kind);
      row.appendChild(main);
      row.appendChild(rename);
      row.appendChild(forget);
      row.addEventListener('click', function(){
        if (main.querySelector('.recent-rename')) return;   /* mid-edit */
        openEntry(entry);
      });
      recentList.appendChild(row);
    });
  }

  /* ---------- playback ---------- */
  playBtn.addEventListener('click', function(){
    if (!player) return;
    if (player.isPaused()) player.play(); else player.pause();
  });
  backBtn.addEventListener('click', function(){
    if (player) player.setTime(Math.max(0, player.getTime() - 5));
  });
  fwdBtn.addEventListener('click', function(){
    if (!player) return;
    var d = player.getDuration() || 0;
    player.setTime(d ? Math.min(d, player.getTime() + 5) : player.getTime() + 5);
  });

  seek.addEventListener('input', function(){
    if (!player) return;
    var t = parseFloat(seek.value);
    player.setTime(t);
    syncOverlay(t, true);   /* scrubbing while paused emits no ticks */
  });

  function updateTime(){
    if (!player){ timeDisplay.textContent = '0:00 / 0:00'; return; }
    timeDisplay.textContent = fmt(player.getTime()) + ' / ' + fmt(player.getDuration());
  }

  document.addEventListener('keydown', function(e){
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape'){ closeSummaryModal(); closeLightbox(); muteOverlay(); return; }
    if (!player) return;
    if (e.code === 'Space'){ e.preventDefault(); playBtn.click(); }
    if (e.key === 'ArrowLeft') backBtn.click();
    if (e.key === 'ArrowRight') fwdBtn.click();
    if (e.key === 'n' || e.key === 'N') playToNextNote();
    if (e.key === 'm' || e.key === 'M') muteBtn.click();
  });

  /* ---------- draw mode ---------- */
  markBtn.addEventListener('click', enterDraw);

  function enterDraw(){
    if (!player) return;
    clearHideTimer();
    overlayRemaining = 0;
    hideOverlay();
    player.pause();
    capturedTime = player.getTime();

    var a = player.getAspect();
    var vw = (a && a.w) || 960, vh = (a && a.h) || 540;
    var scale = Math.min(1, 960 / vw);
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    canvas.width = w; canvas.height = h;
    frameBuf.width = w; frameBuf.height = h;

    hasFrame = false;
    if (player.canCaptureFrame()){
      try{ player.captureFrame(fctx, w, h); hasFrame = true; }
      catch(err){ setNotice('Could not capture this frame.'); }
    }
    drawHint.textContent = hasFrame
      ? ''
      : 'Drawing over the live player — saved as a replayable overlay.';

    playerHud.classList.add('hidden');
    noteView.classList.add('hidden');
    shapes = [];
    redraw();
    canvas.classList.remove('review');
    canvas.style.display = 'block';
    drawToolbar.classList.add('active');
    drawing = true;
    noteTextInput.value = '';
  }

  function exitDraw(){
    drawToolbar.classList.remove('active');
    playerHud.classList.remove('hidden');
    showHud();
    drawing = false;
    panelNoteId = null;
    syncNotePanel(player ? player.getTime() : 0);
    shapes = [];
    activeShape = null;
    if (!reviewNote){
      canvas.style.display = 'none';
      canvas.classList.remove('review');
    }
  }
  $('cancel-btn').addEventListener('click', exitDraw);

  function drawShape(c, s){
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (s.tool === 'pen'){
      c.beginPath();
      for (var i = 0; i < s.points.length; i++){
        var p = s.points[i];
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      if (s.points.length === 1){ c.lineTo(s.points[0].x + 0.1, s.points[0].y); }
      c.stroke();
    } else if (s.tool === 'rect'){
      c.strokeRect(s.a.x, s.a.y, s.b.x - s.a.x, s.b.y - s.a.y);
    } else if (s.tool === 'arrow'){
      var dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      var ang = Math.atan2(dy, dx);
      var head = Math.max(12, s.size * 4);
      c.beginPath(); c.moveTo(s.a.x, s.a.y); c.lineTo(s.b.x, s.b.y); c.stroke();
      c.beginPath();
      c.moveTo(s.b.x, s.b.y);
      c.lineTo(s.b.x - head * Math.cos(ang - Math.PI/7), s.b.y - head * Math.sin(ang - Math.PI/7));
      c.lineTo(s.b.x - head * Math.cos(ang + Math.PI/7), s.b.y - head * Math.sin(ang + Math.PI/7));
      c.closePath(); c.fill();
    }
  }

  function redraw(){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (hasFrame) ctx.drawImage(frameBuf, 0, 0);
    shapes.forEach(function(s){ drawShape(ctx, s); });
    if (activeShape) drawShape(ctx, activeShape);
  }

  /* Strokes on a flat card, for the notes list when there is no frame to capture. */
  function shapesThumb(list, w, h){
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = '#150f28';
    g.fillRect(0, 0, w, h);
    list.forEach(function(s){ drawShape(g, s); });
    return c.toDataURL('image/jpeg', 0.72);
  }

  function pointAt(e){
    var r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  }

  canvas.addEventListener('pointerdown', function(e){
    if (!drawing) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    startPt = pointAt(e);
    activeShape = (tool === 'pen')
      ? { tool:'pen', color:color, size:size, points:[startPt] }
      : { tool:tool, color:color, size:size, a:startPt, b:startPt };
    redraw();
  });

  canvas.addEventListener('pointermove', function(e){
    if (!activeShape) return;
    var p = pointAt(e);
    if (activeShape.tool === 'pen') activeShape.points.push(p);
    else activeShape.b = p;
    redraw();
  });

  ['pointerup','pointercancel'].forEach(function(evt){
    canvas.addEventListener(evt, function(){
      if (activeShape){ shapes.push(activeShape); activeShape = null; redraw(); }
    });
  });

  function pickGroup(sel, attr, cb){
    document.querySelectorAll(sel).forEach(function(btn){
      btn.addEventListener('click', function(){
        document.querySelectorAll(sel).forEach(function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        cb(btn.dataset[attr]);
      });
    });
  }
  /* ---------- how long a drawing stays on screen ---------- */
  function savePrefs(){
    store.set(PREFS_KEY, {
      overlayHold: overlayHold,
      autoPause: autoPause,
      notePanelOpen: notePanelOpen,
      volume: volume,
      muted: muted
    });
  }

  function applyHold(v, save){
    overlayHold = Math.min(HOLD_MAX, Math.max(HOLD_MIN, parseFloat(v) || HOLD_MIN));
    holdRange.value = overlayHold;
    holdValue.textContent = overlayHold.toFixed(2) + 's';
    if (save) savePrefs();
  }
  holdRange.addEventListener('input', function(){ applyHold(this.value, false); });
  holdRange.addEventListener('change', function(){ applyHold(this.value, true); });

  autoPauseBox.addEventListener('change', function(){
    autoPause = this.checked;
    if (!autoPause) playTarget = null;
    savePrefs();
  });

  function loadPrefs(){
    return store.get(PREFS_KEY).then(function(p){
      p = p || {};
      applyHold(typeof p.overlayHold === 'number' ? p.overlayHold : overlayHold, false);
      autoPause = !!p.autoPause;
      autoPauseBox.checked = autoPause;
      applyNotePanelOpen(p.notePanelOpen !== false, false);
      volume = (typeof p.volume === 'number') ? Math.min(1, Math.max(0, p.volume)) : 1;
      muted = !!p.muted;
      applySound();
    });
  }

  pickGroup('.tool-btn', 'tool', function(v){ tool = v; });
  pickGroup('.swatch', 'color', function(v){
    color = v;
    document.querySelector('.swatch-custom').classList.remove('selected');
  });
  pickGroup('.size-btn', 'size', function(v){ size = parseInt(v, 10); });

  /* Anything outside the presets. */
  $('custom-color').addEventListener('input', function(){
    color = this.value;
    document.querySelectorAll('.swatch').forEach(function(b){ b.classList.remove('selected'); });
    document.querySelector('.swatch-custom').classList.add('selected');
  });

  $('undo-btn').addEventListener('click', function(){ shapes.pop(); redraw(); });
  $('clear-btn').addEventListener('click', function(){ shapes = []; redraw(); });

  $('save-btn').addEventListener('click', function(){
    var note = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
      time: capturedTime,
      text: noteTextInput.value.trim()
    };
    /* Shapes are recorded for every source, so any note can be replayed over live
       video. `image` keeps its old meaning: the thumbnail and lightbox still read it. */
    note.shapes = shapes;
    note.canvasW = canvas.width;
    note.canvasH = canvas.height;
    note.image = hasFrame ? canvas.toDataURL('image/jpeg', 0.72)
                          : shapesThumb(shapes, canvas.width, canvas.height);
    notes.push(note);
    notes.sort(function(a,b){ return a.time - b.time; });
    persist();
    renderNotes();
    renderMarks();
    exitDraw();
  });

  function persist(){
    if (!videoKey) return;
    store.set(videoKey, notes);
    touchLibrary();
    refreshStatus();
  }

  /* ---------- review overlay (youtube notes) ---------- */
  /* Notes are anchored to the timeline: a drawing shows itself while the playhead
     is reached, for an adjustable hold, over live video. */

  var imgCache = {};
  function imgFor(note, src){
    var key = note.id + (src === note.overlayImage ? ':o' : ':i');
    var hit = imgCache[key];
    if (hit) return hit;
    var img = new Image();
    img.onload = function(){ overlayKey = null; syncOverlay(player ? player.getTime() : 0, true); };
    img.src = src;
    imgCache[key] = img;
    return img;
  }
  function hasShapes(n){ return !!(n.shapes && n.shapes.length); }

  /* Which notes this sync should put on screen. Playback is sampled only every
     150-250ms, so a short hold can never be found by testing "is the playhead
     inside the window" — instead we look for the moment the playhead CROSSED the
     note, and a timer decides how long it then stays. */
  function triggeredNotes(time, prev, isSeek){
    if (isSeek){
      /* Jumping or scrubbing to a note is a deliberate "show me this one". */
      var reach = Math.max(overlayHold, 0.5);
      return notes.filter(function(n){
        return time >= n.time - 0.05 && time <= n.time + reach;
      });
    }
    return notes.filter(function(n){ return prev < n.time && n.time <= time; });
  }

  function paintNote(n){
    if (hasShapes(n)){
      ctx.save();
      ctx.scale(canvas.width / (n.canvasW || 960), canvas.height / (n.canvasH || 540));
      n.shapes.forEach(function(s){ drawShape(ctx, s); });
      ctx.restore();
      return;
    }
    /* Some older notes carry a transparent PNG of just the drawing, recovered back
       when that tool existed. Those sit in place exactly like a vector note. */
    if (n.overlayImage){
      var rec = imgFor(n, n.overlayImage);
      if (rec.complete && rec.naturalWidth){
        ctx.drawImage(rec, 0, 0, canvas.width, canvas.height);
      }
      return;
    }
    /* Only a flattened still: show it as a corner inset so the live video
       underneath stays completely unobscured. */
    var img = imgFor(n, n.image);
    if (!img.complete || !img.naturalWidth) return;
    var iw = Math.round(canvas.width * 0.28);
    var ih = Math.round(iw * (img.naturalHeight / img.naturalWidth));
    var x = canvas.width - iw - Math.round(canvas.width * 0.02);
    var y = canvas.height - ih - Math.round(canvas.height * 0.03);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#150f28';
    ctx.fillRect(x - 3, y - 3, iw + 6, ih + 6);
    ctx.restore();
    ctx.drawImage(img, x, y, iw, ih);
    ctx.strokeStyle = '#ff4d9d';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, iw + 4, ih + 4);
  }

  function hideOverlay(){
    reviewNote = null;
    overlayKey = '';
    if (!drawing){
      canvas.style.display = 'none';
      canvas.classList.remove('review');
    }
  }

  /* The hold counts down in wall-clock time, which tracks playback at 1x, and is
     frozen while paused — so clicking a note lets you study it for as long as you
     like, and it only expires once the match is actually running. */
  function clearHideTimer(){
    if (overlayTimer){ clearTimeout(overlayTimer); overlayTimer = null; }
  }
  function startHide(ms){
    clearHideTimer();
    overlayRemaining = ms;
    if (!player || player.isPaused()) return;   /* frozen until playback resumes */
    overlayEndsAt = Date.now() + ms;
    overlayTimer = setTimeout(function(){
      overlayTimer = null;
      overlayRemaining = 0;
      hideOverlay();
    }, ms);
  }
  function freezeHide(){
    if (!overlayTimer) return;
    overlayRemaining = Math.max(0, overlayEndsAt - Date.now());
    clearHideTimer();
  }
  function thawHide(){
    if (overlayRemaining > 0 && reviewNote) startHide(overlayRemaining);
  }

  function syncOverlay(time, isSeek){
    var prev = lastSyncTime;
    lastSyncTime = time;
    syncNotePanel(time);
    if (drawing) return;            /* draw mode owns the canvas */

    var live = triggeredNotes(time, prev, isSeek);
    if (!live.length) return;       /* nothing newly reached — the timer does the hiding */

    var key = live.map(function(n){ return n.id; }).join(',');
    if (key === overlayKey && overlayTimer) return;   /* already showing exactly these */
    overlayKey = key;

    var a = player && player.getAspect();
    var vw = (a && a.w) || 960, vh = (a && a.h) || 540;
    var scale = Math.min(1, 960 / vw);
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    live.forEach(paintNote);
    canvas.classList.add('review');
    canvas.style.display = 'block';
    reviewNote = live[live.length - 1];
    startHide(overlayHold * 1000);
  }

  /* Escape clears what is on screen; the next note you reach shows normally. */
  function muteOverlay(){
    if (!reviewNote) return;
    clearHideTimer();
    overlayRemaining = 0;
    hideOverlay();
  }

  /* ---------- notes list ---------- */
  function renderNotes(){
    notesList.innerHTML = '';
    notesHeading.textContent = notes.length ? 'Notes (' + notes.length + ')' : 'Notes';
    if (activePane === 'summary') renderSummaryNotes();
    if (!notes.length){
      var empty = document.createElement('div');
      empty.className = 'note-empty';
      empty.textContent = 'No notes yet. Pause where you want, then click "Mark this moment" to draw on the frame and save it.';
      notesList.appendChild(empty);
      refreshStatus();
      return;
    }
    refreshStatus();

    notes.forEach(function(note){
      var item = document.createElement('div');
      item.className = 'note-item' + (note.id === panelNoteId ? ' current' : '');
      item.dataset.noteId = note.id;

      var thumb = document.createElement('img');
      thumb.className = 'note-thumb';
      thumb.src = note.image;
      thumb.alt = 'Drawing at ' + fmt(note.time);
      thumb.addEventListener('click', function(e){ e.stopPropagation(); openLightbox(note); });

      var body = document.createElement('div');
      body.className = 'note-body';
      var t = document.createElement('div');
      t.className = 'note-time mono';
      t.textContent = fmt(note.time);
      body.appendChild(t);
      if (note.text){
        var tx = document.createElement('div');
        tx.className = 'note-text';
        tx.textContent = note.text;
        body.appendChild(tx);
      }

      var del = document.createElement('button');
      del.className = 'note-del';
      del.textContent = '✕';
      del.title = 'Delete note';
      del.addEventListener('click', function(e){ e.stopPropagation(); removeNote(note.id); });

      item.appendChild(thumb); item.appendChild(body); item.appendChild(del);
      item.addEventListener('click', function(){ jumpTo(note.time, note); });
      notesList.appendChild(item);
    });
  }

  function renderMarks(){
    markStrip.innerHTML = '';
    var d = player ? player.getDuration() : 0;
    if (!d || !isFinite(d)) return;
    notes.forEach(function(note){
      var m = document.createElement('div');
      m.className = 'mark';
      m.style.left = ((note.time / d) * 100) + '%';
      m.title = fmt(note.time) + (note.text ? ' — ' + note.text : '');
      m.addEventListener('click', function(){ jumpTo(note.time, note); });
      markStrip.appendChild(m);
    });
  }

  function jumpTo(time, note){
    if (!player) return;
    player.pause();
    player.setTime(time);
    seek.value = time;
    updateTime();
    overlayKey = null;
    syncOverlay(time, true);   /* an explicit jump always shows its note */
  }

  function removeNote(id){
    if (!confirm('Delete this note?')) return;
    var gone = null;
    notes = notes.filter(function(n){
      if (n.id === id){ gone = n; return false; }
      return true;
    });
    if (gone) trash(gone);
    overlayKey = null;
    panelNoteId = null;
    syncNotePanel(player ? player.getTime() : 0);
    persist(); renderNotes(); renderMarks();
    if (lightboxNote && lightboxNote.id === id) closeLightbox();
  }

  /* A deleted note is kept aside rather than destroyed, so a mis-click is never final. */
  var TRASH_MAX = 50;
  function trash(note){
    if (!videoKey) return;
    var key = 'vnotes:trash:' + videoKey;
    store.get(key).then(function(old){
      var list = Array.isArray(old) ? old : [];
      list.unshift({ deleted: Date.now(), note: note });
      if (list.length > TRASH_MAX) list.length = TRASH_MAX;
      store.set(key, list);
    });
  }

  /* ---------- export / import ---------- */
  function downloadBlob(blob, name){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  $('export-btn').addEventListener('click', function(){
    if (!notes.length){ setNotice('Nothing to export yet.'); return; }
    var payload = {
      video: displayName(),
      summary: summaryText.value || '',
      source: source ? {
        kind: source.kind,
        videoId: source.videoId || null,
        url: source.url || null,
        fileName: source.fileName || null
      } : null,
      exported: new Date().toISOString(),
      notes: notes
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' }),
      safeName(displayName()) + '-notes.json');
  });

  $('import-btn').addEventListener('click', function(){ $('import-input').click(); });
  $('import-input').addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      try{
        var data = JSON.parse(reader.result);
        var incoming = Array.isArray(data) ? data : data.notes;
        if (!Array.isArray(incoming)) throw new Error('bad format');
        notes = notes.concat(incoming).sort(function(a,b){ return a.time - b.time; });
        persist(); renderNotes(); renderMarks();
        /* only fill an empty summary — never clobber thoughts already written */
        if (typeof data.summary === 'string' && data.summary.trim() && !summaryText.value.trim()){
          summaryText.value = data.summary;
          var k = summaryKey();
          if (k) store.set(k, { text: data.summary, updated: Date.now() });
        }
      }catch(err){
        setNotice('That file is not a notes export.');
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  /* ---------- stopping on notes ---------- */
  /* Auto-pause and "play to next note" share one stop path. Detection lands up to a
     tick late, so we snap back to the note's exact timestamp — that is the frame the
     drawing was made on, and the only place it lines up with what is underneath. */

  function firstCrossed(prev, t){
    var hit = null;
    notes.forEach(function(n){
      if (prev < n.time && n.time <= t && (hit === null || n.time < hit)) hit = n.time;
    });
    return hit;
  }

  function considerStop(prev, t){
    if (!player || drawing) return;
    var target = null;
    if (autoPause) target = firstCrossed(prev, t);
    if (playTarget !== null && t >= playTarget){
      target = (target === null) ? playTarget : Math.min(target, playTarget);
    }
    if (target === null) return;

    playTarget = null;
    player.pause();
    player.setTime(target);
    /* Load-bearing: without this the next tick sees the same note as freshly
       crossed and pauses again, forever. */
    lastSyncTime = target;
    seek.value = target;
    updateTime();
    syncOverlay(target, true);
  }

  nextNoteBtn.addEventListener('click', playToNextNote);
  function playToNextNote(){
    if (!player || nextNoteBtn.disabled) return;
    var now = player.getTime(), next = null;
    notes.forEach(function(n){
      if (n.time > now + 0.05 && (next === null || n.time < next)) next = n.time;
    });
    if (next === null){ setNotice('No notes after this point.'); return; }
    playTarget = next;
    player.play();
  }

  /* ---------- the note shown over the video ---------- */
  function noteAt(time){
    var hit = null;
    notes.forEach(function(n){
      if (n.time <= time + 0.05 && (hit === null || n.time > hit.time)) hit = n;
    });
    return hit;
  }

  function syncNotePanel(time){
    if (drawing){ noteView.classList.add('hidden'); return; }
    var n = noteAt(time);
    if (!n){
      noteView.classList.add('hidden');
      if (panelNoteId !== null){ panelNoteId = null; highlightCurrentNote(); }
      return;
    }
    noteView.classList.remove('hidden');
    if (n.id === panelNoteId) return;   /* same note — leave it alone */
    panelNoteId = n.id;
    highlightCurrentNote();
    /* Reaching a note reveals it, even if the panel was collapsed. Collapsing
       therefore dismisses the current note rather than muting the panel for good.
       Not saved to prefs — only an explicit chevron click records a preference. */
    if (!notePanelOpen) applyNotePanelOpen(true, false);
    noteViewTime.textContent = fmt(n.time);
    noteViewText.textContent = n.text || 'Drawing only';
    noteViewText.classList.toggle('muted', !n.text);
  }

  function applyNotePanelOpen(open, save){
    notePanelOpen = !!open;
    noteView.classList.toggle('collapsed', !notePanelOpen);
    var btn = $('note-view-toggle');
    btn.setAttribute('aria-expanded', notePanelOpen ? 'true' : 'false');
    btn.title = notePanelOpen ? 'Hide the note' : 'Show the note';
    if (save) savePrefs();
  }
  $('note-view-toggle').addEventListener('click', function(){
    applyNotePanelOpen(!notePanelOpen, true);
  });

  /* ---------- HUD idle fade ---------- */
  function showHud(){
    playerHud.classList.remove('idle');
    if (hudIdleTimer){ clearTimeout(hudIdleTimer); hudIdleTimer = null; }
  }
  function hudIdleSoon(){
    showHud();
    hudIdleTimer = setTimeout(function(){
      hudIdleTimer = null;
      if (player && !player.isPaused() && !drawing) playerHud.classList.add('idle');
    }, 2000);
  }
  videoWrap.addEventListener('pointermove', function(){
    if (player && !player.isPaused()) hudIdleSoon(); else showHud();
  });

  /* ---------- sound ---------- */
  /* Both sources speak 0..1 through the facade; YouTube's 0..100 is its own problem. */
  function applySound(){
    if (player && player.setVolume){
      player.setVolume(volume);
      player.setMuted(muted);
    }
    volumeRange.value = volume;
    muteBtn.classList.toggle('muted', muted || volume === 0);
    muteBtn.title = muted ? 'Unmute (M)' : 'Mute (M)';
  }

  volumeRange.addEventListener('input', function(){
    volume = parseFloat(this.value);
    /* dragging up from silence is an unmute */
    if (volume > 0 && muted) muted = false;
    applySound();
  });
  volumeRange.addEventListener('change', savePrefs);

  muteBtn.addEventListener('click', function(){
    muted = !muted;
    /* unmuting from a zeroed slider needs an audible level to return to */
    if (!muted && volume === 0){ volume = 0.5; }
    applySound();
    savePrefs();
  });

  /* ---------- highlighting the note playback has reached ---------- */
  function highlightCurrentNote(){
    var rows = notesList.querySelectorAll('.note-item');
    for (var i = 0; i < rows.length; i++){
      var on = rows[i].dataset.noteId === panelNoteId;
      rows[i].classList.toggle('current', on);
      if (on) scrollIntoList(rows[i]);
    }
    var mrows = $('summary-modal-list').querySelectorAll('.summary-modal-row');
    for (var j = 0; j < mrows.length; j++){
      mrows[j].classList.toggle('current', mrows[j].dataset.noteId === panelNoteId);
    }
  }

  /* Scroll the panel, not the page — scrollIntoView would drag the whole layout.
     Measured with rects rather than offsetTop, which is relative to the nearest
     positioned ancestor and so not comparable with the list's own scrollTop. */
  function scrollIntoList(el){
    var lr = notesList.getBoundingClientRect(), er = el.getBoundingClientRect();
    if (er.top < lr.top){
      notesList.scrollTop -= (lr.top - er.top) + 8;
    } else if (er.bottom > lr.bottom){
      notesList.scrollTop += (er.bottom - lr.bottom) + 8;
    }
  }

  /* A resize changes the list's height, which can leave the highlighted row out of
     view. Only re-anchor on resize — doing it every tick would fight manual scrolling. */
  window.addEventListener('resize', function(){
    var el = notesList.querySelector('.note-item.current');
    if (el) scrollIntoList(el);
  });

  /* ---------- summary modal ---------- */
  function openSummaryModal(){
    $('summary-modal-sub').textContent = displayName();
    summaryModalText.value = summaryText.value;
    $('summary-modal-status').textContent = $('summary-status').textContent;
    renderSummaryModalList();
    highlightCurrentNote();
    summaryModal.classList.add('open');
    summaryModalText.focus();
  }
  function closeSummaryModal(){
    summaryModal.classList.remove('open');
  }

  $('view-summary-btn').addEventListener('click', openSummaryModal);
  $('summary-modal-close').addEventListener('click', closeSummaryModal);
  summaryModal.addEventListener('click', function(e){
    if (e.target === summaryModal) closeSummaryModal();
  });

  /* One summary, two boxes — mirror the text so neither can go stale. */
  summaryModalText.addEventListener('input', function(){
    summaryText.value = this.value;
    queueSummarySave();
    $('summary-modal-status').textContent = 'Saving…';
  });

  function renderSummaryModalList(){
    var host = $('summary-modal-list');
    host.innerHTML = '';
    if (!notes.length){
      var empty = document.createElement('div');
      empty.className = 'summary-empty';
      empty.textContent = 'No notes on this video yet.';
      host.appendChild(empty);
      return;
    }
    notes.forEach(function(note){
      var row = document.createElement('div');
      row.className = 'summary-modal-row';
      row.dataset.noteId = note.id;

      if (note.image){
        var img = document.createElement('img');
        img.src = note.image;
        img.alt = 'Drawing at ' + fmt(note.time);
        row.appendChild(img);
      }

      var m = document.createElement('div');
      m.className = 'm';
      var mt = document.createElement('div');
      mt.className = 'mt';
      mt.textContent = fmt(note.time);
      var mx = document.createElement('div');
      mx.className = 'mx' + (note.text ? '' : ' muted');
      mx.textContent = note.text || 'Drawing only';
      m.appendChild(mt); m.appendChild(mx);
      row.appendChild(m);

      row.addEventListener('click', function(){
        closeSummaryModal();
        jumpTo(note.time, note);
      });
      host.appendChild(row);
    });
  }

  /* ---------- notes / summary tabs ---------- */
  function showPane(name){
    activePane = name;
    document.querySelectorAll('.panel-tab').forEach(function(b){
      var on = b.dataset.pane === name;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('pane-notes').classList.toggle('hidden', name !== 'notes');
    $('pane-summary').classList.toggle('hidden', name !== 'summary');
    if (name === 'summary') renderSummaryNotes();
  }
  document.querySelectorAll('.panel-tab').forEach(function(b){
    b.addEventListener('click', function(){ showPane(b.dataset.pane); });
  });

  /* ---------- per-video summary ---------- */
  /* Kept under its own key so the notes array is never touched by summary edits. */
  function summaryKey(){ return videoKey ? 'vnotes:summary:' + videoKey : null; }

  function loadSummary(){
    summaryText.value = '';
    summaryModalText.value = '';
    setSummaryStatus('');
    var k = summaryKey();
    if (!k) return Promise.resolve();
    return store.get(k).then(function(rec){
      /* videoKey may have moved on while this was in flight */
      if (summaryKey() !== k) return;
      summaryText.value = (rec && typeof rec.text === 'string') ? rec.text : '';
      summaryModalText.value = summaryText.value;
      setSummaryStatus(rec && rec.updated ? 'Last edited ' + relTime(rec.updated) : '');
    });
  }

  var summarySaveTimer = null;
  function setSummaryStatus(msg){
    $('summary-status').textContent = msg;
    $('summary-modal-status').textContent = msg;
  }
  function queueSummarySave(){
    if (summarySaveTimer) clearTimeout(summarySaveTimer);
    setSummaryStatus('Saving…');
    summarySaveTimer = setTimeout(function(){
      summarySaveTimer = null;
      var k = summaryKey();
      if (!k) return;
      var rec = { text: summaryText.value, updated: Date.now() };
      Promise.resolve(store.set(k, rec)).then(function(){
        setSummaryStatus('Saved · ' + store.label);
      });
    }, 600);
  }
  summaryText.addEventListener('input', function(){
    summaryModalText.value = summaryText.value;
    queueSummarySave();
  });
  summaryText.addEventListener('blur', function(){
    if (summarySaveTimer){ clearTimeout(summarySaveTimer); summarySaveTimer = null;
      var k = summaryKey();
      if (k) store.set(k, { text: summaryText.value, updated: Date.now() });
    }
  });

  /* The rundown of every note on this video, newest logic same as the list: click to jump. */
  function renderSummaryNotes(){
    var host = $('summary-notes');
    host.innerHTML = '';
    if (!notes.length){
      var empty = document.createElement('div');
      empty.className = 'summary-empty';
      empty.textContent = 'No notes on this video yet. Marked moments will be listed here.';
      host.appendChild(empty);
      return;
    }
    notes.forEach(function(note){
      var row = document.createElement('div');
      row.className = 'summary-line';

      var t = document.createElement('span');
      t.className = 't';
      t.textContent = fmt(note.time);

      var s = document.createElement('span');
      s.className = 's' + (note.text ? '' : ' muted');
      s.textContent = note.text || 'Drawing only';

      row.appendChild(t); row.appendChild(s);
      row.addEventListener('click', function(){ jumpTo(note.time, note); });
      host.appendChild(row);
    });
  }

  /* ---------- whole-library backup / restore ---------- */
  /* Restore only ever adds. It never overwrites a stored note and never removes
     anything absent from the file, so a restore can't cost you work. */

  function isNoteList(v){
    return Array.isArray(v) && v.every(function(n){
      return n && typeof n === 'object' && typeof n.id !== 'undefined' && typeof n.time === 'number';
    });
  }

  var SUMMARY_PREFIX = 'vnotes:summary:';

  $('backup-btn').addEventListener('click', function(){
    store.keys().then(function(keys){
      var wanted = keys.filter(function(k){
        return k.indexOf('vnotes:') === 0 && k !== LIB_KEY && k.indexOf('vnotes:trash:') !== 0;
      });
      return Promise.all(wanted.map(function(k){
        return store.get(k).then(function(v){ return { key: k, value: v }; });
      })).then(function(rows){
        var videos = {}, summaries = {}, total = 0, notesWith = 0;
        rows.forEach(function(r){
          if (r.key.indexOf(SUMMARY_PREFIX) === 0){
            if (r.value && typeof r.value.text === 'string' && r.value.text.trim()){
              summaries[r.key] = r.value;
            }
            return;
          }
          if (isNoteList(r.value) && r.value.length){
            videos[r.key] = r.value; total += r.value.length; notesWith++;
          }
        });
        var sCount = Object.keys(summaries).length;
        if (!total && !sCount){ setNotice('There is nothing to back up yet.'); return; }
        var payload = {
          format: 'video-notes-backup', version: 1,
          saved: new Date().toISOString(),
          library: library, videos: videos, summaries: summaries
        };
        var stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
        downloadBlob(new Blob([JSON.stringify(payload)], { type:'application/json' }),
          'video-notes-backup-' + stamp + '.json');
        var bits = [];
        if (total) bits.push(total + ' note' + (total === 1 ? '' : 's') +
                             ' across ' + notesWith + ' video' + (notesWith === 1 ? '' : 's'));
        if (sCount) bits.push(sCount + ' summar' + (sCount === 1 ? 'y' : 'ies'));
        setNotice('Backed up ' + bits.join(' and ') + '.');
      });
    });
  });

  $('restore-btn').addEventListener('click', function(){ $('restore-input').click(); });
  $('restore-input').addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try{ data = JSON.parse(reader.result); }
      catch(err){ setNotice('That file could not be read as a backup.'); return; }
      if (!data || data.format !== 'video-notes-backup' || !data.videos){
        setNotice('That is not a Video Notes backup file.');
        return;
      }
      restoreBackup(data);
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  /* Summaries are free text, so a clash cannot be merged the way note ids can.
     An empty local summary takes the backup's copy; a non-empty one is left exactly
     as it is and reported, so restoring can never overwrite something you wrote. */
  function restoreSummaries(map){
    if (!map) return Promise.resolve({ added: 0, kept: 0 });
    var added = 0, kept = 0;
    var jobs = Object.keys(map).map(function(k){
      var incoming = map[k];
      if (!incoming || typeof incoming.text !== 'string' || !incoming.text.trim()){
        return Promise.resolve();
      }
      return store.get(k).then(function(existing){
        var have = existing && typeof existing.text === 'string' ? existing.text.trim() : '';
        if (!have){ added++; return store.set(k, incoming); }
        if (have !== incoming.text.trim()) kept++;
      });
    });
    return Promise.all(jobs).then(function(){ return { added: added, kept: kept }; });
  }

  function restoreBackup(data){
    var keys = Object.keys(data.videos || {});
    var added = 0, touched = 0, summaryAdded = 0, summaryKept = 0;

    var work = keys.map(function(k){
      var incoming = data.videos[k];
      if (!isNoteList(incoming)) return Promise.resolve();
      return store.get(k).then(function(existing){
        var merged = Array.isArray(existing) ? existing.slice() : [];
        var seen = {};
        merged.forEach(function(n){ seen[n.id] = true; });
        var before = merged.length;
        incoming.forEach(function(n){
          if (!seen[n.id]){ merged.push(n); seen[n.id] = true; }
        });
        if (merged.length === before) return;
        merged.sort(function(a,b){ return a.time - b.time; });
        added += merged.length - before;
        touched++;
        return store.set(k, merged);
      });
    });

    Promise.all(work).then(function(){
      return restoreSummaries(data.summaries);
    }).then(function(res){
      summaryAdded = res.added; summaryKept = res.kept;
      return mergeLibrary(data.library);
    }).then(function(){
      /* Reload whatever is open so restored notes show up immediately. */
      if (videoKey){
        loadSummary();
        return store.get(videoKey).then(function(saved){
          notes = Array.isArray(saved) ? saved : notes;
          overlayKey = null;
          renderNotes(); renderMarks();
        });
      }
    }).then(function(){
      renderRecent();
      var bits = [];
      if (added) bits.push('Restored ' + added + ' note' + (added === 1 ? '' : 's') +
                           ' across ' + touched + ' video' + (touched === 1 ? '' : 's'));
      if (summaryAdded) bits.push((bits.length ? 'and ' : 'Restored ') + summaryAdded +
                                  ' summar' + (summaryAdded === 1 ? 'y' : 'ies'));
      var msg = bits.length ? bits.join(' ') + '. Nothing was removed.'
                            : 'Everything in that backup was already here — nothing to add.';
      if (summaryKept) msg += ' ' + summaryKept + ' summar' + (summaryKept === 1 ? 'y was' : 'ies were') +
                              ' left alone because you already had text there.';
      setNotice(msg, 14000);
    });
  }

  function mergeLibrary(incoming){
    if (!Array.isArray(incoming) || !incoming.length) return Promise.resolve();
    var known = {};
    library.forEach(function(e){ known[e.key] = true; });
    incoming.forEach(function(e){
      if (e && e.key && !known[e.key]){ library.push(e); known[e.key] = true; }
    });
    library.sort(function(a,b){ return (b.lastOpened || 0) - (a.lastOpened || 0); });
    if (library.length > LIB_MAX) library.length = LIB_MAX;
    return store.set(LIB_KEY, library);
  }

  /* ---------- lightbox ---------- */
  function openLightbox(note){
    lightboxNote = note;
    lightboxImg.src = note.image;
    lightboxTime.textContent = fmt(note.time);
    lightboxText.textContent = note.text || '';
    lightbox.classList.add('open');
  }
  function closeLightbox(){ lightbox.classList.remove('open'); lightboxNote = null; }

  $('lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function(e){ if (e.target === lightbox) closeLightbox(); });
  $('lightbox-jump').addEventListener('click', function(){
    if (lightboxNote){ var n = lightboxNote; closeLightbox(); jumpTo(n.time, n); }
  });
  $('lightbox-delete').addEventListener('click', function(){
    if (lightboxNote) removeNote(lightboxNote.id);
  });
  $('lightbox-download').addEventListener('click', function(){
    if (!lightboxNote) return;
    var a = document.createElement('a');
    a.href = lightboxNote.image;
    a.download = 'note-' + fmt(lightboxNote.time).replace(/:/g,'-') + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
  });

  if (IS_FILE) $('file-note').classList.remove('hidden');

  showStart();   /* home and the player are exclusive views; start on home */
  renderNotes();
  loadPrefs();
  loadLibrary();
})();
