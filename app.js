(function(){
  "use strict";

  /* The browser build is gone. Without the preload bridge there is no storage, no way
     to open a video by path, and no loopback server for YouTube to embed into - so say
     so plainly instead of failing piecemeal halfway through boot. */
  if (!window.storage || typeof window.storage.get !== 'function' ||
      !window.desktop || typeof window.desktop.openVideo !== 'function'){
    document.body.innerHTML =
      '<div class="needs-desktop">' +
        '<h1>This needs the desktop app</h1>' +
        '<p>Video Notes used to run as a plain web page too. That version is gone: notes ' +
        'live in a folder on disk, videos are remembered by their path, and YouTube will ' +
        'not embed without the app\u2019s own local server.</p>' +
        '<p><a href="https://github.com/Carel-Haasbroek/Match-Analysis-Tool/releases/latest">' +
        'Download the latest release</a></p>' +
      '</div>';
    return;
  }

  var $ = function(id){ return document.getElementById(id); };

  var video = $('video'), ytHolder = $('yt-holder');
  var canvas = $('draw-canvas'), ctx = canvas.getContext('2d');
  var frameBuf = document.createElement('canvas'), fctx = frameBuf.getContext('2d');
  var fileNameEl = $('file-name'), statusEl = $('status');
  var homeView = $('home'), startClose = $('start-close'), videoWrap = $('video-wrap');
  var workspace = document.querySelector('.workspace');
  var recentList = $('recent-list');
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
  var rotor = $('rotor'), rotateBtn = $('rotate-btn'), rateBtn = $('rate-btn');
  var summaryModal = $('summary-modal'), summaryModalText = $('summary-modal-text');
  var lightbox = $('lightbox'), lightboxImg = $('lightbox-img'), lightboxTime = $('lightbox-time'),
      lightboxText = $('lightbox-text');

  var notes = [], videoKey = null, currentLabel = '';
  var player = null, source = null, library = [], pendingNotice = '';
  var drawing = false, shapes = [], activeShape = null, startPt = null;
  var tool = 'pen', color = '#ff2d78', size = 3, capturedTime = 0, lightboxNote = null;
  var hasFrame = false, reviewNote = null, overlayKey = null;
  var overlayTimer = null, overlayEndsAt = 0, overlayRemaining = 0, lastSyncTime = 0;
  var autoPause = false, playTarget = null, panelNoteId = null, notePanelOpen = true;
  var volume = 1, muted = false, theme = '';
  var rotation = 0, rate = 1;
  var RATES = [1, 0.5, 0.25];
  var hudIdleTimer = null;
  var activePane = 'notes';

  /* Who is commenting. Asked for at first startup and put on every note this person
     adds, so several coaches can annotate one video and stay distinguishable. */
  var userName = '';
  /* The name that notes written before authorship existed are read as. Captured once,
     when a name is first entered, and never changed afterwards: renaming yourself later
     must not rewrite who wrote the old ones. */
  var legacyAuthor = '';
  /* The note whose comment box should regain focus after a re-render. */
  var focusNoteId = null;
  /* This install, so two coaches both called "Coach" get their own files in a shared
     vault. Kept with prefs, which are per-machine. */
  var authorId = '';

  var LIB_KEY = 'vnotes:index', LIB_MAX = 40;

  /* name, label, and the three colours the swatch shows */
  var THEMES = [
    { id:'',          name:'Neo retro',  swatch:['#120d1f','#ff4d9d','#3ce8e0'] },
    { id:'dos',       name:'MS-DOS',     swatch:['#000000','#33ff33','#1f7a1f'] },
    { id:'win95',     name:'Windows 95', swatch:['#008080','#c0c0c0','#000080'] },
    { id:'amber',     name:'Amber CRT',  swatch:['#0d0700','#ffb000','#7a4a11'] },
    { id:'gameboy',   name:'Game Boy',   swatch:['#9bbc0f','#306230','#0f380f'] },
    { id:'blueprint', name:'Blueprint',  swatch:['#0d2b58','#ffffff','#9fd3ff'] },
    { id:'paper',     name:'Paper',      swatch:['#f4f1ea','#b5341f','#2f6f5e'] },
    { id:'vapor',     name:'Vaporwave',  swatch:['#2b1055','#ff8ad8','#7ef0e0'] }
  ];
  /* The preload bridge. Guaranteed by the check at the top of this file. */
  var DESKTOP = window.desktop;

  /* How long a note's drawing stays on screen once the playhead reaches it,
     in seconds. User-adjustable; persisted in PREFS_KEY. */
  var overlayHold = 1;
  var HOLD_MIN = 0.01, HOLD_MAX = 2, PREFS_KEY = 'vnotes:prefs';

  /* Tests get their own notes folder by pointing Electron's userData somewhere
     temporary, so there is nothing to keep separate in here. */

  /* ---------- storage ---------- */
  /* One tier: the preload bridge onto the folder store on disk. Values cross it as
     JSON strings. It used to fall back to IndexedDB and then to memory, for the
     browser build that no longer exists. */
  var store = {
    label: 'saved on this device',
    get: function(key){
      return window.storage.get(key)
        .then(function(r){ return r && r.value ? JSON.parse(r.value) : null; })
        .catch(function(){ return null; });
    },
    set: function(key, value){
      return window.storage.set(key, JSON.stringify(value)).catch(function(){});
    },
    /* Every stored key - used only to build a full backup. */
    keys: function(){
      return Promise.resolve(window.storage.keys())
        .then(function(list){
          return (list || []).filter(function(k){ return typeof k === 'string'; });
        })
        .catch(function(){ return []; });
    }
  };

  /* ---------- helpers ---------- */
  function fmt(sec){
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
    var mm = h > 0 ? String(m).padStart(2,'0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2,'0');
  }
  /* ---------- vault-qualified keys ---------- */
  /* Two vaults can hold the same video, so a session key has to say which vault it is
     in. The vault goes outermost, so the store routes on one split:

       vault:v2|vnotes:Jack_1.mp4_65939131

     A key with no prefix belongs to the first vault, which is every note written before
     vaults existed. Derived keys - summary, trash - are built by wrapping the *inner*
     key and re-attaching the vault, so the prefix never ends up buried in the middle. */
  var VAULT_RE = /^vault:([^|]+)\|([\s\S]+)$/;
  function withVault(id, inner){ return id ? 'vault:' + id + '|' + inner : inner; }
  function vaultOf(key){ var m = VAULT_RE.exec(key || ''); return m ? m[1] : ''; }
  function innerOf(key){ var m = VAULT_RE.exec(key || ''); return m ? m[2] : (key || ''); }
  /* a key beside another one, in the same vault */
  function siblingKey(key, prefix){ return withVault(vaultOf(key), prefix + innerOf(key)); }

  /* Which vault a new session goes into. The renderer learns it from the list. */
  var vaults = [], newSessionVault = '';
  function defaultVault(){
    if (newSessionVault) return newSessionVault;
    for (var i = 0; i < vaults.length; i++) if (vaults[i].isDefault) return vaults[i].id;
    return vaults.length ? vaults[0].id : '';
  }
  function vaultName(id){
    for (var i = 0; i < vaults.length; i++) if (vaults[i].id === id) return vaults[i].name;
    return '';
  }

  function keyFor(file){
    return withVault(defaultVault(),
      'vnotes:' + (file.name + '_' + file.size).replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,150));
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

  /* What people actually type for a timestamp: 90, 1:30, 1:02:03, 2:05.5, or
     YouTube's own 1h2m3s. Returns null for anything it cannot read, so the caller
     can tell "nothing entered" from "zero". */
  function parseClock(v){
    v = String(v == null ? '' : v).trim();
    if (!v) return null;
    if (/^\d+(?:\.\d+)?$/.test(v)) return parseFloat(v);
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
    if (m){
      var mins = +m[2], secs = parseFloat(m[3]);
      if (mins > 59 || secs >= 60) return null;
      return (+(m[1] || 0)) * 3600 + mins * 60 + secs;
    }
    if (/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/i.test(v)){
      var t = parseTimeParam(v);
      if (t) return t;
    }
    return null;
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
    api.getRate = function(){ return video.playbackRate; };
    api.setRate = function(r){ video.playbackRate = r; };
    api.getVolume = function(){ return video.volume; };            /* 0..1 */
    api.setVolume = function(v){ video.volume = v; };
    api.isMuted = function(){ return video.muted; };
    api.setMuted = function(m){ video.muted = !!m; };
    api.canCaptureFrame = function(){ return true; };
    api.captureFrame = function(c, w, h, deg){
      if (!deg){ c.drawImage(video, 0, 0, w, h); return; }
      /* draw into a canvas already sized for the rotated result */
      c.save();
      c.translate(w / 2, h / 2);
      c.rotate(deg * Math.PI / 180);
      var dw = (deg === 90 || deg === 270) ? h : w;
      var dh = (deg === 90 || deg === 270) ? w : h;
      c.drawImage(video, -dw / 2, -dh / 2, dw, dh);
      c.restore();
    };
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

  function createYouTubeSource(videoId, startAt, endAt){
    var api = { kind:'youtube', onReady:null, onTick:null, onPlayState:null, onError:null };
    var yt = null, timer = null, dead = false, dur = 0, title = '';
    /* YT.seekTo() starts playback unless the player is already paused, which would
       wipe a note's replay overlay the moment you jump to it. pauseRequested records
       what we asked for; repauseUntil is the short window in which an unwanted
       PLAYING state gets pushed back to paused. */
    var pauseRequested = false, repauseUntil = 0;
    /* Volume can be set before the iframe API is ready; apply it on load. */
    var pendingVolume = 1, pendingMuted = false, pendingRate = 1;

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
    if (endAt) vars.end = Math.ceil(endAt);
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
              yt.setPlaybackRate(pendingRate);
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
    api.getRate = function(){
      return (yt && yt.getPlaybackRate) ? yt.getPlaybackRate() : pendingRate;
    };
    api.setRate = function(r){
      pendingRate = r;
      if (yt && yt.setPlaybackRate) yt.setPlaybackRate(r);
    };
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

    [playBtn, backBtn, fwdBtn, nextNoteBtn, markBtn, seek, muteBtn, volumeRange,
     rotateBtn, rateBtn, $('view-summary-btn')].forEach(function(el){ el.disabled = false; });
    videoWrap.style.setProperty('--ar', 16/9);
    seek.value = 0;
    seek.max = 100;
    playerHud.classList.remove('playing');
    rate = 1;
    rotation = 0;
    clipIn = clipOut = null;
    noticeUntil = 0; /* a new source supersedes any notice about the previous one */
    setStatus(src.kind === 'youtube' ? 'Loading the YouTube player…' : '');

    var p = player = makePlayer();
    applySound();

    p.onReady = function(){
      applyRotation();     /* sets --ar from the real dimensions, turned if needed */
      applyRate();
      updateClipUi();
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
      var e = entryFor(videoKey);
      if (e && pendingClipName && !e.customName){
        e.customName = pendingClipName;
        saveLibrary();
        refreshName();
      }
      pendingClipName = null;
      rotation = (e && typeof e.rotation === 'number') ? e.rotation : 0;
      applyRotation();
      updateClipUi();
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
      key: withVault(defaultVault(), 'vnotes:yt:' + videoId),
      label: label || ('YouTube · ' + videoId),
      videoId: videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId
    });
  }


  /* ---------- clips: a YouTube session bounded to one segment ---------- */
  /* Everything downstream — the overlay, note marks, auto-pause, play-to-next-note,
     the seek bar — talks to the player through the facade. So a clip is just a facade
     that reports clip-relative time: nothing else in the app needs to know.

     Note times are therefore stored clip-relative too, which keeps every comparison
     conversion-free. The source timestamp is not lost: the bounds live on the session,
     so absolute = segment.start + note.time whenever it is wanted. */

  function clipKey(videoId, start, end){
    return withVault(defaultVault(),
      'vnotes:yt:' + videoId + '@' + start.toFixed(2) + '-' + end.toFixed(2));
  }

  function clipSource(inner, start, end){
    var span = Math.max(0.1, end - start);
    var api = { kind: 'youtube', segment: { start: start, end: end } };

    /* pass-through, with time translated at the boundary */
    api.play = function(){ inner.play(); };
    api.pause = function(){ inner.pause(); };
    api.isPaused = function(){ return inner.isPaused(); };
    api.getTime = function(){
      return Math.min(span, Math.max(0, inner.getTime() - start));
    };
    api.setTime = function(t){
      inner.setTime(start + Math.min(span, Math.max(0, t)));
    };
    api.getDuration = function(){ return span; };
    api.getAspect = function(){ return inner.getAspect(); };
    api.getTitle = function(){ return inner.getTitle(); };
    api.getRate = function(){ return inner.getRate(); };
    api.setRate = function(r){ inner.setRate(r); };
    api.getVolume = function(){ return inner.getVolume(); };
    api.setVolume = function(v){ inner.setVolume(v); };
    api.isMuted = function(){ return inner.isMuted(); };
    api.setMuted = function(m){ inner.setMuted(m); };
    api.canCaptureFrame = function(){ return inner.canCaptureFrame(); };
    api.captureFrame = function(c, w, h, deg){ inner.captureFrame(c, w, h, deg); };
    api.destroy = function(){ inner.destroy(); };

    inner.onReady = function(){
      /* land on the segment rather than the video's own beginning */
      inner.setTime(start);
      if (api.onReady) api.onReady();
    };
    /* YouTube's endSeconds is approximate, so stop on our own boundary too. Fire once
       and re-arm only after the playhead comes back inside: an unlatched check keeps
       re-triggering at the boundary and pins the clip at its end, undoing every seek. */
    var stoppedAtEnd = false;
    inner.onTick = function(t){
      if (t < end - 0.15) stoppedAtEnd = false;
      if (!stoppedAtEnd && t >= end - 0.05 && !inner.isPaused()){
        stoppedAtEnd = true;
        inner.pause();          /* pause only — seeking here would fight the user's own seeks */
      }
      if (api.onTick) api.onTick(Math.min(span, Math.max(0, t - start)));
    };
    inner.onPlayState = function(p){ if (api.onPlayState) api.onPlayState(p); };
    inner.onError = function(m){ if (api.onError) api.onError(m); };

    return api;
  }

  function loadYouTubeClip(videoId, start, end, label){
    /* Held as the session's name rather than its auto label: otherwise YouTube's
       title arrives on ready and overwrites it. It stays renameable like any other. */
    pendingClipName = label || null;
    openSource(function(){
      return clipSource(createYouTubeSource(videoId, start, end), start, end);
    }, {
      kind: 'youtube',
      key: clipKey(videoId, start, end),
      label: label || ('Clip · ' + fmt(start) + '–' + fmt(end)),
      videoId: videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId,
      segment: { start: start, end: end }
    });
  }

  function openUrl(str){
    var p = parseYouTube(str);
    if (!p){
      setNotice('That does not look like a YouTube link.');
      return false;
    }
    var known = null;
    for (var i = 0; i < library.length; i++){
      if (innerOf(library[i].key) === 'vnotes:yt:' + p.videoId){ known = library[i]; break; }
    }
    loadYouTubeVideo(p.videoId, p.startAt, known && known.label);
    return true;
  }

  /* ---------- picking a file ---------- */
  function chooseVideo(expectKey){
    DESKTOP.openVideo().then(function(info){
      if (info) loadFilePath(info, expectKey || null);
    });
  }
  videoWrap.addEventListener('dragover', function(e){ e.preventDefault(); });
  videoWrap.addEventListener('drop', function(e){
    e.preventDefault();
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.indexOf('video/') === 0) loadFileVideo(f, null);
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
  $('session-filter').addEventListener('input', renderSessionTree);
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
    if (source.segment) entry.segment = source.segment;
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
      if (entry.segment){
        loadYouTubeClip(entry.videoId, entry.segment.start, entry.segment.end, entry.label);
      } else {
        loadYouTubeVideo(entry.videoId, 0, entry.label);   /* customName applied by refreshName */
      }
      return;
    }
    if (entry.filePath){
      DESKTOP.statVideo(entry.filePath).then(function(info){
        if (info){ loadFilePath(info, entry.key); return; }
        markUnavailable(entry);
      });
      return;
    }
    chooseVideo(entry.key);
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
    DESKTOP.openVideo().then(function(info){
      if (!info) return;
      delete entry.missing;
      entry.filePath = info.path;
      saveLibrary();
      loadFilePath(info, entry.key);
    });
  }

  /* sentinel for the 'New folder...' entry in the folder chooser */
  var NEW_FOLDER_OPTION = '__new_folder__';

  function folderOf(entry){ return (entry && entry.folder) ? String(entry.folder) : ''; }

  function allFolders(){
    var set = {};
    library.forEach(function(e){ if (folderOf(e)) set[folderOf(e)] = true; });
    return Object.keys(set).sort();
  }

  /* The home page shows the few sessions you keep coming back to and nothing else.
     Folders, searching, renaming and moving all live in the All sessions modal, which
     is what took the clutter off the page. */
  var RECENT_ON_HOME = 8;

  function renderRecent(){
    renderHomeRecent();
    if (sessionsModal.classList.contains('open')) renderSessionTree();
  }

  function renderHomeRecent(){
    recentList.innerHTML = '';
    var seeAll = $('see-all-btn');
    if (!library.length){
      var empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = 'Nothing yet. Open a video or a link and it shows up here.';
      recentList.appendChild(empty);
      seeAll.classList.add('hidden');
      return;
    }

    library.slice(0, RECENT_ON_HOME).forEach(function(entry){
      var row = document.createElement('div');
      row.className = 'recent-row plain';

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
      if (vaults.length > 1 && entry.vaultName) bits.push(entry.vaultName);
      if (folderOf(entry)) bits.push(folderOf(entry));
      meta.textContent = bits.join(' · ');
      main.appendChild(label);
      main.appendChild(meta);

      /* a moved video is worth saying here even though fixing it is done in the modal */
      if (entry.missing && entry.filePath){
        row.classList.add('missing');
        var warn = document.createElement('div');
        warn.className = 'recent-missing';
        warn.textContent = 'Video not found at ' + entry.filePath;
        main.appendChild(warn);
      }

      row.appendChild(kind);
      row.appendChild(main);
      row.addEventListener('click', function(){ openEntry(entry); });
      recentList.appendChild(row);
    });

    seeAll.classList.toggle('hidden', library.length <= RECENT_ON_HOME);
    seeAll.textContent = 'All ' + library.length + ' sessions →';
  }

  /* ---------- the sessions tree ---------- */
  /* Folders nest the way they do on disk, so what you fold open here is the same shape
     you see in Explorer. Collapsed state is per-run: it is a view preference, not
     something worth writing to the notes folder. */
  var collapsed = {};

  function renderSessionTree(){
    var host = $('sessions-tree');
    host.innerHTML = '';
    var q = ($('session-filter').value || '').trim().toLowerCase();
    var shown = q
      ? library.filter(function(e){
          return entryName(e).toLowerCase().indexOf(q) >= 0 ||
                 treePathOf(e).toLowerCase().indexOf(q) >= 0;
        })
      : library;

    if (!library.length){
      host.appendChild(emptyLine('Nothing yet. Open a video or a link and it shows up here.'));
      return;
    }
    if (!shown.length){
      host.appendChild(emptyLine('No session matches "' + $('session-filter').value.trim() + '".'));
      return;
    }

    /* build the folder tree from the paths themselves, with the vault as the outermost
       level once there is more than one - the same shape the folders already draw */
    var root = node('');
    shown.forEach(function(e){
      var at = root;
      treePathOf(e).split('/').forEach(function(part){
        part = part.trim();
        if (!part) return;
        var path = at.path ? at.path + '/' + part : part;
        if (!at.kids[part]) at.kids[part] = node(path);
        at = at.kids[part];
      });
      at.entries.push(e);
    });

    Object.keys(root.kids).sort().forEach(function(k){ drawFolder(root.kids[k], host, 0); });
    if (root.entries.length){
      if (Object.keys(root.kids).length){
        var loose = document.createElement('div');
        loose.className = 'tree-folder loose';
        loose.textContent = 'Not in a folder';
        host.appendChild(loose);
      }
      root.entries.forEach(function(e){ host.appendChild(sessionRow(e, 0)); });
    }

    function node(path){ return { path: path, kids: {}, entries: [] }; }
    function emptyLine(text){
      var d = document.createElement('div');
      d.className = 'recent-empty';
      d.textContent = text;
      return d;
    }
    function countIn(n){
      var total = n.entries.length;
      Object.keys(n.kids).forEach(function(k){ total += countIn(n.kids[k]); });
      return total;
    }

    function drawFolder(n, host, depth){
      /* a search result inside a folded folder would otherwise be invisible */
      var open = q ? true : !collapsed[n.path];
      var head = document.createElement('div');
      head.className = 'tree-folder' + (open ? '' : ' shut');
      head.style.paddingLeft = (10 + depth * 16) + 'px';

      var caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = open ? '▾' : '▸';
      var name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = n.path.split('/').pop();
      var count = document.createElement('span');
      count.className = 'recent-group-count';
      count.textContent = countIn(n);

      head.appendChild(caret); head.appendChild(name); head.appendChild(count);
      head.addEventListener('click', function(){
        collapsed[n.path] = !collapsed[n.path];
        renderSessionTree();
      });
      host.appendChild(head);
      if (!open) return;

      Object.keys(n.kids).sort().forEach(function(k){ drawFolder(n.kids[k], host, depth + 1); });
      n.entries.forEach(function(e){ host.appendChild(sessionRow(e, depth + 1)); });
    }
  }

  /* a vault reads as one more level of folder, so the tree needs no special case */
  function treePathOf(e){
    var f = folderOf(e);
    if (vaults.length <= 1) return f;
    var v = vaultName(e.vault) || 'Vault';
    return f ? v + '/' + f : v;
  }

  function sessionRow(entry, depth){
    var row = renderRow(entry);
    row.style.paddingLeft = (10 + (depth || 0) * 16) + 'px';
    return row;
  }

  function renderRow(entry){
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
      if (entry.kind === 'file' && !entry.filePath) bits.push('pick the file again');
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

      if (entry.missing){
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

      /* choosing a folder moves the session's directory on disk, so what you see
         in the app and what you see in Explorer stay the same thing */
      var move = document.createElement('select');
      move.className = 'recent-folder';
      move.title = 'Move this session to a folder';
      function opt(value, label){
        var o = document.createElement('option');
        o.value = value; o.textContent = label;
        if (folderOf(entry) === value) o.selected = true;
        move.appendChild(o);
      }
      opt('', 'No folder');
      allFolders().forEach(function(f){ if (f) opt(f, f); });
      var mk = document.createElement('option');
      mk.value = NEW_FOLDER_OPTION; mk.textContent = 'New folder…';
      move.appendChild(mk);
      move.addEventListener('click', function(e){ e.stopPropagation(); });
      move.addEventListener('change', function(e){
        e.stopPropagation();
        var v = move.value;
        if (v === NEW_FOLDER_OPTION){
          v = (prompt('Folder name (use / to nest)', folderOf(entry)) || '').trim();
          if (!v){ renderRecent(); return; }
        }
        setEntryFolder(entry, v);
      });

      row.appendChild(kind);
      row.appendChild(main);
      row.appendChild(move);
      row.appendChild(rename);
      row.appendChild(forget);
      row.addEventListener('click', function(){
        if (main.querySelector('.recent-rename')) return;   /* mid-edit */
        closeSessionsModal();
        openEntry(entry);
      });
      return row;
  }

  function setEntryFolder(entry, folder){
    entry.folder = folder || '';
    if (!entry.folder) delete entry.folder;
    saveLibrary();
    /* on the desktop the folder is real: move the directory to match */
    if (DESKTOP.moveSession){
      DESKTOP.moveSession(entry.key, entry.folder || '').then(function(){ renderRecent(); });
    } else {
      renderRecent();
    }
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
    if (e.key === 'r' || e.key === 'R') rotateBtn.click();
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
    if (quarterTurned()){ var sw = vw; vw = vh; vh = sw; }   /* drawing space follows the picture */
    var scale = Math.min(1, 960 / vw);
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    canvas.width = w; canvas.height = h;
    frameBuf.width = w; frameBuf.height = h;

    hasFrame = false;
    if (player.canCaptureFrame()){
      try{ player.captureFrame(fctx, w, h, rotation); hasFrame = true; }
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

  /* getBoundingClientRect on a rotated element gives the axis-aligned bounding box,
     not the rotated frame, so at 90/270 the naive mapping puts strokes in the wrong
     place. Work from the rect's centre and undo the rotation. */
  function pointAt(e){
    var r = canvas.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = e.clientX - cx, dy = e.clientY - cy;

    var rad = -rotation * Math.PI / 180;          /* inverse */
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var lx = dx * cos - dy * sin;                 /* local, still centre-origin */
    var ly = dx * sin + dy * cos;

    /* the drawn box's on-screen size, with axes swapped at a quarter turn */
    var boxW = quarterTurned() ? r.height : r.width;
    var boxH = quarterTurned() ? r.width : r.height;

    return {
      x: (lx + boxW / 2) * (canvas.width / boxW),
      y: (ly + boxH / 2) * (canvas.height / boxH)
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
      muted: muted,
      theme: theme,
      userName: userName,
      legacyAuthor: legacyAuthor,
      authorId: authorId
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
      applyTheme(typeof p.theme === 'string' ? p.theme : '', false);
      userName = typeof p.userName === 'string' ? p.userName : '';
      legacyAuthor = typeof p.legacyAuthor === 'string' ? p.legacyAuthor : '';
      authorId = typeof p.authorId === 'string' && p.authorId ? p.authorId
                                                             : Math.random().toString(36).slice(2, 6);
      if (p.authorId !== authorId) savePrefs();
      sendAuthor();
      refreshWho();
      renderNotes();
      if (!userName) askName(true);
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
    var first = noteTextInput.value.trim();
    var note = {
      id: uid(),
      time: capturedTime,
      /* text mirrors the first comment; comments is the thread coaches add to */
      text: first,
      author: first ? userName : '',
      comments: first ? [{ id: uid(), author: userName, text: first, at: Date.now() }] : []
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
    if (quarterTurned()){ var sw = vw; vw = vh; vh = sw; }
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

  /* ---------- comments ---------- */
  /* A moment holds a thread, not one line of text. Notes written before this existed
     have `text` and no `comments`; they are read as a single comment signed with the
     name captured at first startup, and only materialise into a real `comments` array
     when someone adds to them. Nothing is rewritten on load, so opening the app never
     touches an existing note. `text` is kept in step with the first comment, so
     exports, tooltips, the folder store and older builds all keep working. */

  function uid(){ return Date.now() + '-' + Math.random().toString(36).slice(2,7); }

  function commentsOf(note){
    if (Array.isArray(note.comments) && note.comments.length) return note.comments;
    var t = (note.text || '').trim();
    if (!t) return [];
    return [{ id: note.id + ':1', author: note.author || legacyAuthor || '',
              text: t, at: note.at || 0 }];
  }

  function authorOf(c){ return ((c && c.author) || '').trim(); }

  /* one line per comment, for the places with room for only a line */
  function noteLines(note){
    return commentsOf(note).map(function(c){
      var who = authorOf(c);
      return who ? who + ': ' + c.text : c.text;
    });
  }
  function noteSummaryText(note){ return noteLines(note).join('  ·  '); }

  function addComment(note, text){
    text = (text || '').trim();
    if (!text) return false;
    var list = commentsOf(note).slice();
    list.push({ id: uid(), author: userName, text: text, at: Date.now() });
    note.comments = list;
    note.text = list[0].text;
    if (!note.author) note.author = authorOf(list[0]);
    return true;
  }

  function deleteComment(note, commentId){
    var list = commentsOf(note).filter(function(c){ return c.id !== commentId; });
    note.comments = list;
    note.text = list.length ? list[0].text : '';
    note.author = list.length ? authorOf(list[0]) : '';
  }

  /* Two coaches can each hold the same note and add to it, so merging matches on note
     id and then unions the two threads by comment id. Nothing is ever replaced. */
  function mergeNoteLists(existing, incoming){
    var out = Array.isArray(existing) ? existing.slice() : [];
    var byId = {}, addedNotes = 0, addedComments = 0;
    out.forEach(function(n){ byId[n.id] = n; });
    (incoming || []).forEach(function(n){
      if (!n || typeof n.id === 'undefined') return;
      var have = byId[n.id];
      if (!have){ out.push(n); byId[n.id] = n; addedNotes++; return; }
      var mine = commentsOf(have), merged = mine.slice(), seen = {};
      mine.forEach(function(c){ seen[c.id] = true; });
      commentsOf(n).forEach(function(c){
        if (!seen[c.id]){ merged.push(c); seen[c.id] = true; addedComments++; }
      });
      if (merged.length !== mine.length){
        have.comments = merged;
        have.text = merged[0].text;
      }
    });
    out.sort(function(a,b){ return a.time - b.time; });
    return { notes: out, addedNotes: addedNotes, addedComments: addedComments };
  }

  function countLabel(n, one, many){ return n + ' ' + (n === 1 ? one : many); }

  /* one comment in the notes list, with the author it belongs to */
  function commentRow(note, c){
    var row = document.createElement('div');
    row.className = 'cmt';
    var who = authorOf(c);
    if (who){
      var a = document.createElement('span');
      a.className = 'cmt-author';
      a.textContent = who;
      row.appendChild(a);
    }
    var tx = document.createElement('span');
    tx.className = 'cmt-text';
    tx.textContent = c.text;
    row.appendChild(tx);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'cmt-del';
    del.textContent = '✕';
    del.title = 'Delete this comment';
    del.addEventListener('click', function(e){
      e.stopPropagation();
      if (!confirm('Delete this comment?')) return;
      deleteComment(note, c.id);
      afterThreadChange(note);
    });
    row.appendChild(del);
    return row;
  }

  function commentComposer(note){
    var wrap = document.createElement('div');
    wrap.className = 'cmt-add';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cmt-input';
    input.placeholder = userName ? 'Add a comment as ' + userName + '…' : 'Add a comment…';
    input.setAttribute('data-note-id', note.id);
    var post = document.createElement('button');
    post.type = 'button';
    post.className = 'cmt-post';
    post.textContent = 'Post';

    function submit(){
      if (!addComment(note, input.value)) return;
      input.value = '';
      focusNoteId = note.id;
      afterThreadChange(note);
    }
    /* clicking the row jumps the video, which must not happen while typing */
    wrap.addEventListener('click', function(e){ e.stopPropagation(); });
    input.addEventListener('input', function(){
      wrap.classList.toggle('ready', !!input.value.trim());
    });
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); submit(); }
    });
    post.addEventListener('click', submit);
    wrap.appendChild(input);
    wrap.appendChild(post);
    return wrap;
  }

  /* one path for every edit to a thread: save, then redraw wherever it shows */
  function afterThreadChange(note){
    persist();
    renderNotes();
    renderMarks();
    if (panelNoteId === note.id){
      panelNoteId = null;
      syncNotePanel(player ? player.getTime() : 0);
    }
    if (lightboxNote && lightboxNote.id === note.id) openLightbox(note);
    if (summaryModal.classList.contains('open')) renderSummaryModalList();
  }

  /* ---------- making a segment straight from a link ---------- */
  /* Every way into a session is this one modal. A segment is just a link with bounds,
     so the two share a form rather than sitting in separate places; the clip key is the
     same one marking in and out produces, so the same segment twice is one session. */
  var newSessionModal = $('new-session-modal');
  var sessionsModal = $('sessions-modal');
  var settingsModal = $('settings-modal');

  /* every modal here closes on its backdrop and on Escape, which the global key
     handler cannot do for it because it steps aside for form fields */
  function wireModal(el, close){
    el.addEventListener('click', function(e){ if (e.target === el) close(); });
    el.addEventListener('keydown', function(e){
      if (e.key === 'Escape'){ e.stopPropagation(); close(); }
    });
  }

  function segmentOn(){ return $('segment-toggle').checked; }

  function openNewSession(){
    $('segment-error').textContent = '';
    newSessionVault = '';
    renderVaultPicker();
    newSessionModal.classList.add('open');
    setTimeout(function(){ $('segment-url').focus(); }, 30);
  }
  function closeNewSession(){ newSessionModal.classList.remove('open'); }

  function segmentError(msg, focusId){
    $('segment-error').textContent = msg;
    if (focusId) $(focusId).focus();
  }

  function clearNewSession(){
    ['segment-url', 'segment-start', 'segment-end', 'segment-name'].forEach(function(id){
      $(id).value = '';
    });
  }

  $('new-session-btn').addEventListener('click', openNewSession);
  $('segment-cancel').addEventListener('click', closeNewSession);
  wireModal(newSessionModal, closeNewSession);

  /* the times only exist when you say you want part of the video */
  $('segment-toggle').addEventListener('change', function(){
    $('segment-times').classList.toggle('hidden', !segmentOn());
    $('segment-hint').classList.toggle('hidden', !segmentOn());
    if (segmentOn()) $('segment-start').focus();
  });

  $('segment-file-btn').addEventListener('click', function(){
    closeNewSession();
    chooseVideo(null);
  });

  function openSessionsModal(){
    sessionsModal.classList.add('open');
    renderSessionTree();
    setTimeout(function(){ $('session-filter').focus(); }, 30);
  }
  function closeSessionsModal(){ sessionsModal.classList.remove('open'); }
  $('sessions-btn').addEventListener('click', openSessionsModal);
  $('see-all-btn').addEventListener('click', openSessionsModal);
  $('sessions-close').addEventListener('click', closeSessionsModal);
  wireModal(sessionsModal, closeSessionsModal);

  /* Help sits over settings rather than replacing it, so closing it puts you back
     where you were rather than out on the home screen. */
  var helpModal = $('help-modal');
  function closeHelp(){ helpModal.classList.remove('open'); }
  $('help-btn').addEventListener('click', function(){
    helpModal.classList.add('open');
    $('help-modal').querySelector('.help-body').scrollTop = 0;
  });
  $('help-close').addEventListener('click', closeHelp);
  wireModal(helpModal, closeHelp);

  function closeSettings(){ settingsModal.classList.remove('open'); }
  $('settings-btn').addEventListener('click', function(){
    settingsModal.classList.add('open');
    loadVaults();
  });
  $('settings-close').addEventListener('click', closeSettings);
  wireModal(settingsModal, closeSettings);

  $('segment-form').addEventListener('submit', function(e){
    e.preventDefault();
    var link = parseYouTube($('segment-url').value);
    if (!link){
      segmentError('Paste a YouTube link, or choose a video file.', 'segment-url');
      return;
    }

    /* the whole video: nothing more to read */
    if (!segmentOn()){
      closeNewSession();
      var name = $('segment-name').value.trim();
      if (openUrl($('segment-url').value)){
        if (name) nameOpenSession(name);
        clearNewSession();
      }
      return;
    }

    var startRaw = $('segment-start').value.trim();
    /* an empty start means the beginning - or wherever the link itself points */
    var start = startRaw ? parseClock(startRaw) : (link.startAt || 0);
    if (start === null){
      segmentError('Read the start as 1:30, 1:02:03 or a number of seconds.', 'segment-start');
      return;
    }
    var end = parseClock($('segment-end').value);
    if (end === null){
      segmentError('Give the segment an end - 4:00, 1:02:03 or a number of seconds.',
                   'segment-end');
      return;
    }
    if (end <= start){
      segmentError('The end has to come after the start.', 'segment-end');
      return;
    }

    var segName = $('segment-name').value.trim();
    closeNewSession();
    loadYouTubeClip(link.videoId, start, end, segName || null);
    setNotice('Segment ' + fmt(start) + '-' + fmt(end) + '. Marks you make are timed from ' +
              'the start of the segment.', 9000);
    clearNewSession();
  });

  /* A name typed for a whole video cannot be handed to loadYouTubeVideo the way a clip's
     can, so apply it to the entry once the session is registered. */
  function nameOpenSession(name){
    setTimeout(function(){
      var e = entryFor(videoKey);
      if (!e) return;
      e.customName = name;
      saveLibrary();
      refreshName();
      renderRecent();
    }, 400);
  }

  /* The file this app writes into inside a shared session folder. The name is there so
     the folder stays readable; the install id is there so two coaches with the same name
     still get a file each. */
  function sendAuthor(){
    if (!DESKTOP.setAuthor) return;
    var who = (userName || 'me').toLowerCase().replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '').slice(0, 24) || 'me';
    DESKTOP.setAuthor(who + '-' + (authorId || '0000'));
  }

  /* ---------- vaults ---------- */
  function loadVaults(){
    if (!DESKTOP.vaults) return Promise.resolve();
    return DESKTOP.vaults().then(function(list){
      vaults = Array.isArray(list) ? list : [];
      renderVaultList();
      renderVaultPicker();
      showVaultFooter();
    });
  }

  /* adding or forgetting a vault changes which sessions exist, so the library follows */
  function refreshVaults(){
    return loadVaults().then(function(){ return loadLibrary(); });
  }

  /* The sessions modal used to name the one folder notes were in. With several vaults
     a single path is a half-truth, so it points at the list instead. */
  function showVaultFooter(){
    var el = $('notes-folder');
    if (!el || vaults.length < 2) return;
    el.textContent = vaults.length + ' vaults · manage them in Settings';
    el.title = 'Open Settings';
    el.classList.remove('hidden');
    el.onclick = function(){
      closeSessionsModal();
      settingsModal.classList.add('open');
      loadVaults();
    };
  }

  function renderVaultList(){
    var host = $('vault-list');
    if (!host) return;
    host.innerHTML = '';

    vaults.forEach(function(v){
      var row = document.createElement('div');
      row.className = 'vault-row' + (v.isDefault ? ' is-default' : '') +
                      (v.available ? '' : ' gone');

      var main = document.createElement('div');
      main.className = 'vault-main';
      var name = document.createElement('div');
      name.className = 'vault-name';
      name.textContent = v.name;
      var meta = document.createElement('div');
      meta.className = 'vault-meta vault-path';
      meta.title = 'Open this folder';
      meta.textContent = v.available
        ? v.sessions + ' session' + (v.sessions === 1 ? '' : 's') + ' · ' + v.path
        : 'Folder not found · ' + v.path;
      meta.addEventListener('click', function(){ DESKTOP.reveal(v.path); });
      main.appendChild(name);
      main.appendChild(meta);
      row.appendChild(main);

      if (v.isDefault){
        var tag = document.createElement('span');
        tag.className = 'vault-tag';
        tag.textContent = 'new notes';
        row.appendChild(tag);
      } else if (v.available){
        var mk = document.createElement('button');
        mk.type = 'button';
        mk.textContent = 'Make default';
        mk.title = 'New sessions go here';
        mk.addEventListener('click', function(){
          DESKTOP.vaultDefault(v.id).then(function(){ newSessionVault = ''; return refreshVaults(); });
        });
        row.appendChild(mk);
      }

      var ren = document.createElement('button');
      ren.type = 'button';
      ren.textContent = '✎';
      ren.title = 'Rename this vault';
      ren.addEventListener('click', function(){
        var v2 = (prompt('Name for this vault', v.name) || '').trim();
        if (!v2) return;
        DESKTOP.vaultRename(v.id, v2).then(refreshVaults);
      });
      row.appendChild(ren);

      if (vaults.length > 1){
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'vault-del';
        del.textContent = '✕';
        del.title = 'Forget this vault';
        del.addEventListener('click', function(){
          /* the wording matters: a cross beside a folder full of work reads as delete */
          if (!confirm('Forget the vault "' + v.name + '"?\n\nIts folder and every note ' +
                       'in it stay exactly where they are — this only takes it off the ' +
                       'list. You can add it again at any time.')) return;
          DESKTOP.vaultRemove(v.id).then(function(){ newSessionVault = ''; return refreshVaults(); });
        });
        row.appendChild(del);
      }

      host.appendChild(row);
    });
  }

  function renderVaultPicker(){
    var row = $('segment-vault-row'), sel = $('segment-vault');
    if (!row || !sel) return;
    /* with one vault there is nothing to choose, so the row is not there at all */
    row.classList.toggle('hidden', vaults.length <= 1);
    sel.innerHTML = '';
    vaults.forEach(function(v){
      if (!v.available) return;
      var o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name;
      sel.appendChild(o);
    });
    sel.value = defaultVault();
  }

  if (DESKTOP.vaultAdd){
    $('vault-add').addEventListener('click', function(){
      DESKTOP.vaultAdd().then(function(r){
        if (!r) return;
        newSessionVault = '';
        return refreshVaults().then(function(){
          setNotice(r.added
            ? 'Added the vault “' + r.vault.name + '”. Its sessions are in the list now.'
            : 'That folder is already a vault.', 9000);
        });
      });
    });
    $('segment-vault').addEventListener('change', function(){
      newSessionVault = this.value;
    });
  }

  /* ---------- who is commenting ---------- */
  function refreshWho(){
    var el = $('who-name');
    if (el) el.textContent = userName || 'not set yet';
  }

  function askName(first){
    var input = $('name-input');
    $('name-title').textContent = first ? 'Who is commenting?' : 'Change your name';
    $('name-hint').textContent = first
      ? 'Your name goes on every note you add, so several coaches can comment on the same video. Notes already saved on this machine are signed with this name too.'
      : 'New comments are signed with this name. Comments already saved keep the name they were saved under.';
    $('name-cancel').classList.toggle('hidden', !!first);
    input.value = userName;
    $('name-modal').classList.add('open');
    setTimeout(function(){ input.focus(); input.select(); }, 30);
  }

  $('name-form').addEventListener('submit', function(e){
    e.preventDefault();
    var v = $('name-input').value.trim().slice(0, 40);
    if (!v){ $('name-input').focus(); return; }
    var firstTime = !userName;
    userName = v;
    /* Notes that predate authorship become this person's, once. */
    if (!legacyAuthor) legacyAuthor = v;
    savePrefs();
    sendAuthor();
    $('name-modal').classList.remove('open');
    refreshWho();
    renderNotes();
    if (firstTime) setNotice('Notes you add are signed ' + v + '.');
  });
  $('name-cancel').addEventListener('click', function(){
    $('name-modal').classList.remove('open');
  });
  $('who-change').addEventListener('click', function(){ askName(false); });

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

      var thread = commentsOf(note);
      if (!thread.length){
        var none = document.createElement('div');
        none.className = 'note-text muted';
        none.textContent = 'Drawing only';
        body.appendChild(none);
      }
      thread.forEach(function(c){ body.appendChild(commentRow(note, c)); });
      body.appendChild(commentComposer(note));

      var del = document.createElement('button');
      del.className = 'note-del';
      del.textContent = '✕';
      del.title = 'Delete note';
      del.addEventListener('click', function(e){ e.stopPropagation(); removeNote(note.id); });

      item.appendChild(thumb); item.appendChild(body); item.appendChild(del);
      item.addEventListener('click', function(){ jumpTo(note.time, note); });
      notesList.appendChild(item);
    });

    /* posting re-renders the list, so put the cursor back where it was */
    if (focusNoteId){
      var back = notesList.querySelector('.cmt-input[data-note-id="' + focusNoteId + '"]');
      focusNoteId = null;
      if (back) back.focus();
    }
  }

  function renderMarks(){
    markStrip.innerHTML = '';
    var d = player ? player.getDuration() : 0;
    if (!d || !isFinite(d)) return;

    [clipIn, clipOut].forEach(function(t, i){
      if (t === null || t === undefined) return;
      var e = document.createElement('div');
      e.className = 'mark clip-edge';
      e.style.left = ((t / d) * 100) + '%';
      e.title = (i === 0 ? 'Clip starts ' : 'Clip ends ') + fmt(t);
      markStrip.appendChild(e);
    });
    notes.forEach(function(note){
      var m = document.createElement('div');
      m.className = 'mark';
      m.style.left = ((note.time / d) * 100) + '%';
      var line = noteSummaryText(note);
      m.title = fmt(note.time) + (line ? ' — ' + line : '');
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
    var key = siblingKey(videoKey, 'vnotes:trash:');
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
        var res = mergeNoteLists(notes, incoming);
        notes = res.notes;
        persist(); renderNotes(); renderMarks();
        if (res.addedNotes || res.addedComments){
          var bits = [];
          if (res.addedNotes) bits.push(countLabel(res.addedNotes, 'note', 'notes'));
          if (res.addedComments) bits.push(countLabel(res.addedComments, 'comment', 'comments'));
          setNotice('Added ' + bits.join(' and ') + '.');
        } else {
          setNotice('Everything in that file was already here.');
        }
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
    var thread = commentsOf(n);
    noteViewText.innerHTML = '';
    noteViewText.classList.toggle('muted', !thread.length);
    if (!thread.length){
      noteViewText.textContent = 'Drawing only';
    } else {
      /* every comment, scrolled within the strip when there are more than fit */
      thread.forEach(function(c){
        var line = document.createElement('div');
        line.className = 'nv-cmt';
        var who = authorOf(c);
        if (who){
          var a = document.createElement('span');
          a.className = 'nv-who';
          a.textContent = who;
          line.appendChild(a);
        }
        line.appendChild(document.createTextNode(c.text));
        noteViewText.appendChild(line);
      });
      noteViewText.scrollTop = 0;
    }
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


  /* ---------- setting in/out and making a clip ---------- */
  var clipIn = null, clipOut = null, pendingClipName = null;

  function isClip(){ return !!(source && source.segment); }

  function updateClipUi(){
    var box = $('clip-control');
    /* only offered on a full YouTube video: a clip of a clip is confusing, and a
       local file cannot be shared because the recipient has no copy of it */
    var can = !!player && source && source.kind === 'youtube' && !isClip();
    box.classList.toggle('hidden', !can);
    $('share-clip-btn').classList.toggle('hidden', !isClip());
    if (!can) return;

    var label = $('clip-range'), ready = clipIn !== null && clipOut !== null && clipOut > clipIn;
    if (clipIn === null && clipOut === null) label.textContent = '—';
    else label.textContent = (clipIn === null ? '?' : fmt(clipIn)) + ' – ' +
                             (clipOut === null ? '?' : fmt(clipOut));
    label.classList.toggle('partial', !ready);
    $('clip-make-btn').disabled = !ready;
    renderMarks();
  }

  $('clip-in-btn').addEventListener('click', function(){
    if (!player) return;
    clipIn = player.getTime();
    if (clipOut !== null && clipOut <= clipIn) clipOut = null;
    updateClipUi();
  });
  $('clip-out-btn').addEventListener('click', function(){
    if (!player) return;
    clipOut = player.getTime();
    if (clipIn !== null && clipIn >= clipOut) clipIn = null;
    updateClipUi();
  });
  $('clip-reset-btn').addEventListener('click', function(){
    clipIn = clipOut = null;
    updateClipUi();
  });
  $('clip-make-btn').addEventListener('click', function(){
    if (!source || !source.videoId || clipIn === null || clipOut === null) return;
    var start = clipIn, end = clipOut;
    var name = (displayName() || 'Clip') + ' · ' + fmt(start) + '–' + fmt(end);
    clipIn = clipOut = null;
    loadYouTubeClip(source.videoId, start, end, name);
    setNotice('Clip created — ' + fmt(end - start) + ' long. Its notes are kept separately.', 10000);
  });

  /* ---------- sharing a clip ---------- */
  function clipPayload(){
    var seg = source.segment;
    return {
      format: 'video-notes-clip', version: 1,
      saved: new Date().toISOString(),
      name: displayName(),
      videoId: source.videoId,
      url: source.url,
      /* deep link straight to the segment, so the file is useful without the app */
      sourceUrl: 'https://www.youtube.com/watch?v=' + source.videoId +
                 '&t=' + Math.floor(seg.start),
      segment: { start: seg.start, end: seg.end },
      summary: summaryText.value || '',
      notes: notes                       /* times are relative to segment.start */
    };
  }

  $('share-clip-btn').addEventListener('click', function(){
    if (!isClip()){ setNotice('Only a clip can be shared this way.'); return; }
    if (!notes.length && !summaryText.value.trim()){
      setNotice('Add a note or a summary before sharing this clip.');
      return;
    }
    var p = clipPayload();
    downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type:'application/json' }),
      safeName(p.name) + '-clip.json');
    setNotice('Clip saved with ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '.');
  });

  $('open-clip-btn').addEventListener('click', function(){ $('clip-input').click(); });
  $('clip-input').addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try{ data = JSON.parse(reader.result); }
      catch(err){ setNotice('That file could not be read.'); return; }
      openSharedClip(data);
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  function openSharedClip(data){
    if (!data || data.format !== 'video-notes-clip' || !data.videoId || !data.segment){
      setNotice('That is not a shared clip file.');
      return;
    }
    var start = +data.segment.start, end = +data.segment.end;
    if (!isFinite(start) || !isFinite(end) || end <= start){
      setNotice('That clip file has an unusable segment.');
      return;
    }
    var key = clipKey(data.videoId, start, end);
    var incoming = Array.isArray(data.notes) ? data.notes : [];

    /* merge rather than replace, so opening a clip twice - or a newer copy of one
       you have already annotated - cannot cost you your own notes */
    store.get(key).then(function(existing){
      var merged = Array.isArray(existing) ? existing.slice() : [];
      var seen = {};
      merged.forEach(function(n){ seen[n.id] = true; });
      var added = 0;
      incoming.forEach(function(n){
        if (n && !seen[n.id]){ merged.push(n); seen[n.id] = true; added++; }
      });
      merged.sort(function(a, b){ return a.time - b.time; });
      return store.set(key, merged).then(function(){
        /* only fill an empty summary, never overwrite one already written */
        if (typeof data.summary === 'string' && data.summary.trim()){
          return store.get('vnotes:summary:' + key).then(function(cur){
            var have = cur && typeof cur.text === 'string' ? cur.text.trim() : '';
            if (!have) return store.set('vnotes:summary:' + key,
              { text: data.summary, updated: Date.now() });
          }).then(function(){ return added; });
        }
        return added;
      });
    }).then(function(added){
      loadYouTubeClip(data.videoId, start, end, data.name || null);
      setNotice(added
        ? 'Opened shared clip — ' + added + ' note' + (added === 1 ? '' : 's') + ' added.'
        : 'Opened shared clip — you already had every note in it.', 12000);
    }).catch(function(err){
      /* without this a storage failure is completely silent: nothing opens and
         nothing is said, which is indistinguishable from the click not registering */
      setNotice('Could not open that clip: ' + (err && err.message ? err.message : err), 20000);
    });
  }

  /* ---------- themes ---------- */
  /* Every theme is a token set on the root element, so nothing else has to know
     which one is on. The pen palette is not themed: those colours are content. */
  function applyTheme(id, save){
    theme = id || '';
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    var chips = $('theme-row').children;
    for (var i = 0; i < chips.length; i++){
      chips[i].classList.toggle('selected', chips[i].dataset.theme === theme);
    }
    if (save) savePrefs();
  }

  function renderThemes(){
    var row = $('theme-row');
    row.innerHTML = '';
    THEMES.forEach(function(t){
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'theme-chip' + (t.id === theme ? ' selected' : '');
      chip.dataset.theme = t.id;
      chip.title = t.name;

      var sw = document.createElement('span');
      sw.className = 'theme-swatch';
      t.swatch.forEach(function(c){
        var i = document.createElement('i');
        i.style.background = c;
        sw.appendChild(i);
      });
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(t.name));
      chip.addEventListener('click', function(){ applyTheme(t.id, true); });
      row.appendChild(chip);
    });
  }

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


  /* ---------- playback rate ---------- */
  /* Not persisted: opening a match already in slow motion would be a surprise, and
     <video> resets playbackRate on a source change anyway. */
  function applyRate(){
    if (player && player.setRate) player.setRate(rate);
    rateBtn.textContent = (rate === 1 ? '1' : String(rate)) + '×';
    rateBtn.classList.toggle('slow', rate !== 1);
  }
  rateBtn.addEventListener('click', function(){
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    applyRate();
  });

  /* ---------- rotation ---------- */
  /* The rotor holds the video and the canvas, so both turn together and a drawing
     stays on the thing it marks. Two consequences handled below: at 90/270 the box
     ratio inverts, and the rotor has to be sized with width and height swapped —
     a rotated 100%x100% box cannot be made to fill by any uniform scale. */
  function quarterTurned(){ return rotation === 90 || rotation === 270; }

  function baseAspect(){
    var a = player && player.getAspect && player.getAspect();
    return (a && a.w && a.h) ? (a.w / a.h) : (16 / 9);
  }

  function applyRotation(){
    var ar = baseAspect();
    videoWrap.style.setProperty('--ar', quarterTurned() ? (1 / ar) : ar);
    rotor.style.setProperty('--rot', rotation + 'deg');
    sizeRotor();
    rotateBtn.classList.toggle('slow', rotation !== 0);
    rotateBtn.title = 'Rotate the video (R) — now ' + rotation + '°';
  }

  function sizeRotor(){
    var r = videoWrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    /* swapped at a quarter turn, so the rotated picture fills the box exactly */
    var w = quarterTurned() ? r.height : r.width;
    var h = quarterTurned() ? r.width : r.height;
    rotor.style.width = w + 'px';
    rotor.style.height = h + 'px';
  }

  if (typeof ResizeObserver === 'function'){
    new ResizeObserver(function(){ sizeRotor(); }).observe(videoWrap);
  } else {
    window.addEventListener('resize', sizeRotor);
  }

  rotateBtn.addEventListener('click', function(){
    if (!player) return;
    rotation = (rotation + 90) % 360;
    applyRotation();
    var e = videoKey ? entryFor(videoKey) : null;
    if (e){ e.rotation = rotation; saveLibrary(); }
    overlayKey = null;
    syncOverlay(player.getTime(), true);
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
      var lines = noteLines(note);
      var mx = document.createElement('div');
      mx.className = 'mx' + (lines.length ? '' : ' muted');
      if (!lines.length) mx.textContent = 'Drawing only';
      else lines.forEach(function(l){
        var d = document.createElement('div');
        d.textContent = l;
        mx.appendChild(d);
      });
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
  function summaryKey(){ return videoKey ? siblingKey(videoKey, 'vnotes:summary:') : null; }

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

      var lines = noteLines(note);
      var s = document.createElement('span');
      s.className = 's' + (lines.length ? '' : ' muted');
      if (!lines.length) s.textContent = 'Drawing only';
      else lines.forEach(function(l){
        var d = document.createElement('div');
        d.textContent = l;
        s.appendChild(d);
      });

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

  /* A backup keeps each key's vault, and records what the vaults were called, because
     two vaults can hold the same video and flattening them would quietly drop one.
     Restoring matches vaults by name, so a file carries between machines where the same
     vault has a different id - and a backup written before vaults still restores, into
     whichever vault new sessions go to. */
  function backupVaultKey(k){ return k; }

  function restoreVaultKey(payloadKey, data){
    var id = vaultOf(payloadKey), inner = innerOf(payloadKey);
    if (!id) return withVault(defaultVault(), inner);
    var names = (data && data.vaults) || {};
    var wanted = names[id];
    if (wanted){
      for (var i = 0; i < vaults.length; i++){
        if (vaults[i].name === wanted) return withVault(vaults[i].id, inner);
      }
    }
    return withVault(defaultVault(), inner);
  }

  $('backup-btn').addEventListener('click', function(){
    store.keys().then(function(keys){
      var wanted = keys.filter(function(k){
        var inner = innerOf(k);
        return inner.indexOf('vnotes:') === 0 && inner !== LIB_KEY &&
               inner.indexOf('vnotes:trash:') !== 0;
      });
      return Promise.all(wanted.map(function(k){
        return store.get(k).then(function(v){ return { key: k, value: v }; });
      })).then(function(rows){
        var videos = {}, summaries = {}, total = 0, notesWith = 0;
        rows.forEach(function(r){
          if (innerOf(r.key).indexOf(SUMMARY_PREFIX) === 0){
            if (r.value && typeof r.value.text === 'string' && r.value.text.trim()){
              summaries[backupVaultKey(r.key)] = r.value;
            }
            return;
          }
          if (isNoteList(r.value) && r.value.length){
            videos[backupVaultKey(r.key)] = r.value; total += r.value.length; notesWith++;
          }
        });
        var sCount = Object.keys(summaries).length;
        if (!total && !sCount){ setNotice('There is nothing to back up yet.'); return; }
        var vaultNames = {};
        vaults.forEach(function(v){ vaultNames[v.id] = v.name; });
        var payload = {
          format: 'video-notes-backup', version: 1,
          saved: new Date().toISOString(),
          vaults: vaultNames,
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
  function restoreSummaries(map, data){
    if (!map) return Promise.resolve({ added: 0, kept: 0 });
    var added = 0, kept = 0;
    var jobs = Object.keys(map).map(function(payloadKey){
      var incoming = map[payloadKey];
      var k = restoreVaultKey(payloadKey, data);
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
    var added = 0, touched = 0, summaryAdded = 0, summaryKept = 0, commentsAdded = 0;

    var work = keys.map(function(payloadKey){
      var incoming = data.videos[payloadKey];
      var k = restoreVaultKey(payloadKey, data);
      if (!isNoteList(incoming)) return Promise.resolve();
      return store.get(k).then(function(existing){
        var res = mergeNoteLists(existing, incoming);
        if (!res.addedNotes && !res.addedComments) return;
        added += res.addedNotes;
        commentsAdded += res.addedComments;
        touched++;
        return store.set(k, res.notes);
      });
    });

    Promise.all(work).then(function(){
      return restoreSummaries(data.summaries, data);
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
      if (commentsAdded) bits.push((bits.length ? 'and ' : 'Restored ') +
                                   countLabel(commentsAdded, 'comment', 'comments') +
                                   ' on notes you already had');
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
    lightboxText.innerHTML = '';
    noteLines(note).forEach(function(l){
      var d = document.createElement('div');
      d.className = 'lb-cmt';
      d.textContent = l;
      lightboxText.appendChild(d);
    });
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


  /* Show where the notes actually live, and let it be opened. Also surface what the
     first run did with them, since a silent migration of real work is unnerving. */
  if (DESKTOP.version){
    DESKTOP.version().then(function(v){
      if (v) $('app-version').textContent = 'v' + v;
    });
  }

  if (DESKTOP.dataDir){
    DESKTOP.dataDir().then(function(info){
      if (!info) return;
      var el = $('notes-folder');
      el.textContent = info.dir;
      el.title = 'Notes folder (' + info.kind + ') - click to open';
      el.classList.remove('hidden');
      el.addEventListener('click', function(){ DESKTOP.reveal(info.dir); });
      var m = info.migration;
      if (m && m.migrated){
        setNotice(m.intact
          ? 'Moved ' + m.notesBefore + ' notes into ' + info.dir + '. The old copy was left in place.'
          : 'Migration finished but counts differ (' + m.notesBefore + ' -> ' + m.notesAfter +
            '). The old copy and a backup are intact.', 30000);
      }
    });
  }

  renderThemes();
  showStart();   /* home and the player are exclusive views; start on home */
  renderNotes();
  loadPrefs();
  loadVaults().then(loadLibrary);
})();
