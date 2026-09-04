/**
 * Custom HLS video player (hls.js 1.5+)
 * API: createPlayer({ elementId, src, playlist, initialSelection, storageKey })
 */
function createPlayer({
  elementId,
  src = '',
  playlist = null,
  initialSelection = null,
  apiBase = 'https://filmapi.proside.pp.ua',
  tmdb = null,
  storageKey = ''
}) {
  const playerContainer = document.getElementById(elementId);
  if (!playerContainer) {
    throw Error('Element with id "' + elementId + '" not found.');
  }

  const videoContainers = playerContainer.getElementsByClassName('js-video-container');
  if (!videoContainers.length) {
    throw Error('Element with class "js-video-container" not found.');
  }
  const videoContainer = videoContainers[0];

  // --- Create video element ---
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'metadata';
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
  // Do NOT set controls — we use custom UI
  videoContainer.innerHTML = '';
  videoContainer.appendChild(video);

  const $player = $(playerContainer);
  let hls = null;
  let lastVolume = 1;
  let isSeeking = false;
  let currentQuality = -1; // -1 = Auto
  let qualityLevels = [];  // [{index, height, width, bitrate, label}]
  let currentSpeed = 1;
  const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const PROGRESS_VERSION = 'vp-progress-v1';
  const progressIdentity = storageKey ||
    (tmdb && tmdb.id ? 'tmdb|' + (tmdb.type || 'movie') + '|' + tmdb.id :
      (src ? 'src|' + src : 'player|' + elementId));
  let currentProgressKey = '';
  let pendingResume = null;
  let resumeApplied = false;
  let lastProgressSaveAt = 0;

  function progressKey(mediaId) {
    return PROGRESS_VERSION + '|' + progressIdentity + '|' + String(mediaId || 'default');
  }

  function selectionKey() {
    return PROGRESS_VERSION + '|selection|' + progressIdentity;
  }

  function readStoredJson(key) {
    try {
      var value = window.localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (err) {
      return null;
    }
  }

  function writeStoredJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      // localStorage can be unavailable in private browsing or sandboxed iframes.
    }
  }

  function setMediaContext(mediaId) {
    currentProgressKey = progressKey(mediaId || 'default');
    pendingResume = readStoredJson(currentProgressKey);
    resumeApplied = false;
    lastProgressSaveAt = 0;
  }

  function saveProgress(force) {
    var time = video.currentTime;
    var duration = video.duration;
    if (!currentProgressKey || !isFinite(time) || time < 0) return;
    if (!force && Date.now() - lastProgressSaveAt < 2000) return;
    if (!isFinite(duration) || duration <= 0) return;

    writeStoredJson(currentProgressKey, {
      time: time,
      duration: duration,
      updatedAt: Date.now()
    });
    lastProgressSaveAt = Date.now();
  }

  function clearProgress() {
    try {
      if (currentProgressKey) window.localStorage.removeItem(currentProgressKey);
    } catch (err) {
      // Ignore storage errors.
    }
  }

  function applyPendingResume() {
    if (resumeApplied || !pendingResume) return;
    var duration = video.duration;
    var savedTime = Number(pendingResume.time);
    if (!isFinite(duration) || duration <= 0 || !isFinite(savedTime) || savedTime < 1) return;

    // A completed episode should start from the beginning next time.
    if (savedTime >= duration - 8) {
      pendingResume = null;
      resumeApplied = true;
      return;
    }

    video.currentTime = Math.min(savedTime, Math.max(0, duration - 0.5));
    pendingResume = null;
    resumeApplied = true;
  }

  setMediaContext('default');

  video.addEventListener('loadedmetadata', applyPendingResume);
  video.addEventListener('durationchange', applyPendingResume);
  video.addEventListener('timeupdate', function () { saveProgress(false); });
  video.addEventListener('pause', function () { saveProgress(true); });
  video.addEventListener('ended', function () { clearProgress(); });
  window.addEventListener('pagehide', function () { saveProgress(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveProgress(true);
  });

  // ---------- Helpers ----------
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return m + ':' + pad(s);
  }

  function isControlClick(target) {
    return (
      $(target).closest('.vp-control-panel').length > 0 ||
      $(target).closest('.vp-top-panel').length > 0 ||
      $(target).closest('.vp-big-play').length > 0 ||
      $(target).closest('.vp-btn').length > 0 ||
      $(target).closest('.vp-volume').length > 0 ||
      $(target).closest('.vp-settings-wrap').length > 0
    );
  }

  function setPlaying(isPlaying) {
    $player.toggleClass('is-playing', isPlaying);
    $player.toggleClass('is-paused', !isPlaying);
    const $btn = $player.find('.js-play-pause');
    $btn.attr('aria-label', isPlaying ? 'Pause' : 'Play');
    $btn.find('.js-icon-play').toggle(!isPlaying);
    $btn.find('.js-icon-pause').toggle(isPlaying);
  }

  function updateMuteUI() {
    const muted = video.muted || video.volume === 0;
    $player.toggleClass('is-muted', muted);
    $player.find('.js-mute-toggle').attr('aria-label', muted ? 'Unmute' : 'Mute');
    $player.find('.js-icon-volume').toggle(!muted);
    $player.find('.js-icon-muted').toggle(muted);
  }

  function setProgress(percentage) {
    percentage = Math.max(0, Math.min(100, percentage));
    $player.find('.js-progress-slider').css('width', percentage + '%');
    $player.find('.vp-progress-bar__handle').css('left', percentage + '%');
  }

  // ---------- Load source (HLS or progressive) ----------
  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  function loadSrc(url, autoplay, mediaId) {
    // Do not write a completed episode back immediately before auto-advance.
    if (!video.ended) saveProgress(true);
    setMediaContext(mediaId || ('direct|' + url));
    destroyHls();
    video.removeAttribute('src');
    video.load();

    $player.find('.js-current-time').text('0:00');
    $player.find('.js-duration').text('0:00');
    setProgress(0);
    setPlaying(false);
    hideQualityUI();
    currentQuality = -1;
    qualityLevels = [];

    if (!url) return;

    const isHls = /\.m3u8(\?|$)/i.test(url) || url.indexOf('m3u8') !== -1;

    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 120
      });
      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
        buildQualityLevels(data && data.levels ? data.levels : (hls.levels || []));
        if (autoplay) {
          video.play().catch(function () {});
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, function (event, data) {
        // ABR switched — nothing to update in gear UI until menu is reopened
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          console.error('[HLS fatal]', data.type, data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            destroyHls();
          }
        }
      });
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = url;
      if (autoplay) {
        video.addEventListener('loadedmetadata', function onMeta() {
          video.removeEventListener('loadedmetadata', onMeta);
          video.play().catch(function () {});
        });
      }
    } else {
      // Progressive (mp4, webm, ...)
      video.src = url;
      if (autoplay) {
        video.addEventListener('loadedmetadata', function onMeta() {
          video.removeEventListener('loadedmetadata', onMeta);
          video.play().catch(function () {});
        });
      }
    }
  }


  // ---------- Settings (YouTube-style: Speed + Quality) ----------
  function qualityLabel(lvl) {
    var w = lvl.width || 0;
    var h = lvl.height || 0;
    if (w >= 3840 || h >= 2160) return '2160p';
    if (w >= 2560 || h >= 1440) return '1440p';
    if (w >= 1920 || h >= 1080) return '1080p';
    if (w >= 1280 || h >= 720) return '720p';
    if (w >= 854 || h >= 480) return '480p';
    if (w >= 640 || h >= 360) return '360p';
    if (w >= 426 || h >= 240) return '240p';
    if (h > 0) return h + 'p';
    if (w > 0) return w + 'p';
    var br = lvl.bitrate || 0;
    if (br > 0) return Math.round(br / 1000) + ' kbps';
    return 'Auto';
  }

  function speedLabel(rate) {
    if (rate === 1) return 'Normal';
    return String(rate);
  }

  function getQualityText() {
    if (currentQuality === -1) return 'Auto';
    var q = qualityLevels.find(function (x) { return x.index === currentQuality; });
    return q ? q.label : 'Auto';
  }

  function closeSettings() {
    $player.find('.js-settings-wrap').removeClass('is-open');
    $player.find('.js-settings-menu').attr('hidden', true);
    showSettingsPanel('main');
  }

  function openSettings() {
    rebuildSettingsMenu();
    $player.find('.js-settings-wrap').addClass('is-open');
    $player.find('.js-settings-menu').removeAttr('hidden');
    showSettingsPanel('main');
  }

  function showSettingsPanel(name) {
    var $menu = $player.find('.js-settings-menu');
    $menu.find('.vp-settings-panel').hide();
    $menu.find('.vp-settings-panel[data-panel="' + name + '"]').show();
  }

  function rebuildSettingsMenu() {
    var $menu = $player.find('.js-settings-menu');
    $menu.empty();

    // ---- Main panel ----
    var $main = $('<div class="vp-settings-panel" data-panel="main"></div>');

    // Playback speed row
    var $speedRow = $('<button type="button" class="vp-settings-row" data-goto="speed"></button>');
    $speedRow.append($('<span class="vp-settings-row__label"></span>').text('Playback speed'));
    $speedRow.append($('<span class="vp-settings-row__value"></span>').text(speedLabel(currentSpeed)));
    $speedRow.append($('<span class="vp-settings-row__chevron">›</span>'));
    $main.append($speedRow);

    // Quality row (only if multiple levels)
    if (qualityLevels.length >= 2) {
      var $qRow = $('<button type="button" class="vp-settings-row" data-goto="quality"></button>');
      $qRow.append($('<span class="vp-settings-row__label"></span>').text('Quality'));
      $qRow.append($('<span class="vp-settings-row__value"></span>').text(getQualityText()));
      $qRow.append($('<span class="vp-settings-row__chevron">›</span>'));
      $main.append($qRow);
    }

    $menu.append($main);

    // ---- Speed panel ----
    var $speed = $('<div class="vp-settings-panel" data-panel="speed" style="display:none"></div>');
    var $speedHead = $('<button type="button" class="vp-settings-back"></button>');
    $speedHead.append($('<span class="vp-settings-back__arrow">‹</span>'));
    $speedHead.append($('<span></span>').text('Playback speed'));
    $speed.append($speedHead);

    SPEED_OPTIONS.forEach(function (rate) {
      var $btn = $('<button type="button" class="vp-settings-option"></button>')
        .attr('data-speed', rate)
        .toggleClass('is-active', currentSpeed === rate);
      $btn.append($('<span class="vp-settings-option__check"></span>'));
      $btn.append($('<span></span>').text(speedLabel(rate)));
      $speed.append($btn);
    });
    $menu.append($speed);

    // ---- Quality panel ----
    if (qualityLevels.length >= 2) {
      var $qual = $('<div class="vp-settings-panel" data-panel="quality" style="display:none"></div>');
      var $qHead = $('<button type="button" class="vp-settings-back"></button>');
      $qHead.append($('<span class="vp-settings-back__arrow">‹</span>'));
      $qHead.append($('<span></span>').text('Quality'));
      $qual.append($qHead);

      // Auto
      var $auto = $('<button type="button" class="vp-settings-option"></button>')
        .attr('data-level', -1)
        .toggleClass('is-active', currentQuality === -1);
      $auto.append($('<span class="vp-settings-option__check"></span>'));
      $auto.append($('<span></span>').text('Auto'));
      $qual.append($auto);

      qualityLevels.forEach(function (q) {
        var $btn = $('<button type="button" class="vp-settings-option"></button>')
          .attr('data-level', q.index)
          .toggleClass('is-active', currentQuality === q.index);
        $btn.append($('<span class="vp-settings-option__check"></span>'));
        $btn.append($('<span></span>').text(q.label));
        $qual.append($btn);
      });
      $menu.append($qual);
    }
  }

  function setSpeed(rate) {
    currentSpeed = rate;
    video.playbackRate = rate;
    // refresh labels if menu open
    if ($player.find('.js-settings-wrap').hasClass('is-open')) {
      rebuildSettingsMenu();
      showSettingsPanel('speed');
    }
  }

  function setQuality(levelIndex) {
    if (!hls) return;
    currentQuality = levelIndex;
    hls.currentLevel = levelIndex; // -1 = ABR
    if ($player.find('.js-settings-wrap').hasClass('is-open')) {
      rebuildSettingsMenu();
      showSettingsPanel('quality');
    }
  }

  function buildQualityLevels(levels) {
    qualityLevels = [];
    if (!levels || !levels.length) return;

    var byKey = {};
    levels.forEach(function (lvl, idx) {
      var h = lvl.height || 0;
      var w = lvl.width || 0;
      var br = lvl.bitrate || 0;
      var key = h || w || idx;
      if (!byKey[key] || br > byKey[key].bitrate) {
        byKey[key] = {
          index: idx,
          height: h,
          width: w,
          bitrate: br,
          label: qualityLabel(lvl)
        };
      }
    });

    qualityLevels = Object.keys(byKey)
      .map(function (k) { return byKey[k]; })
      .sort(function (a, b) {
        var sa = (a.width || 0) * (a.height || 1) || a.bitrate || 0;
        var sb = (b.width || 0) * (b.height || 1) || b.bitrate || 0;
        return sb - sa;
      });
  }

  // legacy no-op (loadSrc may still call it)
  function hideQualityUI() {
    // settings gear is always visible; quality submenu appears only when levels >= 2
  }

  (function activateSettings() {
    var $wrap = $player.find('.js-settings-wrap');
    var $btn = $player.find('.js-settings-btn');
    var $menu = $player.find('.js-settings-menu');

    $btn.on('click', function (e) {
      e.stopPropagation();
      if ($wrap.hasClass('is-open')) {
        closeSettings();
      } else {
        openSettings();
      }
    });

    $menu.on('click', '.vp-settings-row[data-goto]', function (e) {
      e.stopPropagation();
      showSettingsPanel($(this).attr('data-goto'));
    });

    $menu.on('click', '.vp-settings-back', function (e) {
      e.stopPropagation();
      showSettingsPanel('main');
    });

    $menu.on('click', '.vp-settings-option[data-speed]', function (e) {
      e.stopPropagation();
      setSpeed(Number($(this).attr('data-speed')));
    });

    $menu.on('click', '.vp-settings-option[data-level]', function (e) {
      e.stopPropagation();
      setQuality(Number($(this).attr('data-level')));
    });

    // Close on outside click
    $(document).on('click.settings', function (e) {
      if (!$(e.target).closest('.js-settings-wrap').length) {
        closeSettings();
      }
    });

    // Don't let clicks inside bubble to video toggle
    $wrap.on('click mousedown', function (e) {
      e.stopPropagation();
    });
  })();

  // ---------- Play / Pause ----------
  (function activatePlayPause() {
    const $btn = $player.find('.js-play-pause');
    const $bigPlay = $player.find('.js-big-play');

    function toggle() {
      if (video.paused || video.ended) {
        video.play().catch(function (e) {
          console.warn('play() failed', e);
        });
      } else {
        video.pause();
      }
    }

    $btn.on('click', function (e) {
      e.stopPropagation();
      toggle();
    });

    $bigPlay.on('click', function (e) {
      e.stopPropagation();
      video.play().catch(function () {});
    });

    playerContainer.addEventListener('click', function (e) {
      if (isControlClick(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }, true);

    video.addEventListener('play', function () { setPlaying(true); });
    video.addEventListener('playing', function () { setPlaying(true); });
    video.addEventListener('pause', function () { setPlaying(false); });
    video.addEventListener('ended', function () { setPlaying(false); });

    // Spacebar → play/pause (ignore when typing in inputs/selects)
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      toggle();
    });

    setPlaying(false);
  })();

  // ---------- Volume / Mute ----------
  (function activateVolume() {
    const $btn = $player.find('.js-mute-toggle');
    const $slider = $player.find('.js-volume-slider');
    const $filled = $player.find('.js-volume-filled');
    const $handle = $player.find('.js-volume-handle');

    // Cubic perceptual curve (YouTube-like):
    // UI 0..1  →  gain = ui^3
    // gain 0..1 → UI = gain^(1/3)
    function gainToUi(gain) {
      gain = Math.max(0, Math.min(1, gain));
      return Math.pow(gain, 1 / 3);
    }
    function uiToGain(ui) {
      ui = Math.max(0, Math.min(1, ui));
      return Math.pow(ui, 3);
    }

    function currentGain() {
      if (video.muted) return 0;
      return typeof video.volume === 'number' ? video.volume : 1;
    }

    function setVolumeUI(gain) {
      var ui = gainToUi(gain);
      var pct = (ui * 100) + '%';
      $filled.css('width', pct);
      $handle.css('left', pct);
    }

    function applyUiVolume(ui) {
      var gain = uiToGain(ui);
      video.muted = gain === 0;
      video.volume = gain;
      if (gain > 0) lastVolume = gain;
      setVolumeUI(gain);
      updateMuteUI();
    }

    $btn.on('click', function (e) {
      e.stopPropagation();
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = lastVolume > 0 ? lastVolume : 1;
      } else {
        lastVolume = video.volume || 1;
        video.muted = true;
      }
      updateMuteUI();
      setVolumeUI(currentGain());
    });

    function seekVolume(clientX) {
      var rect = $slider[0].getBoundingClientRect();
      var width = rect.width || 1;
      var ui = (clientX - rect.left) / width;
      applyUiVolume(ui);
    }

    $slider.on('mousedown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      seekVolume(e.clientX);
      $(document).on('mousemove.vol', function (e) {
        seekVolume(e.clientX);
      });
      $(document).on('mouseup.vol', function () {
        $(document).off('.vol');
      });
    });

    $slider.on('touchstart', function (e) {
      e.stopPropagation();
      var t = e.originalEvent.touches[0];
      seekVolume(t.clientX);
    });
    $slider.on('touchmove', function (e) {
      var t = e.originalEvent.touches[0];
      seekVolume(t.clientX);
    });

    // Scroll wheel over volume area
    $player.find('.vp-volume').on('wheel', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var delta = e.originalEvent.deltaY > 0 ? -0.05 : 0.05;
      var ui = gainToUi(currentGain()) + delta;
      applyUiVolume(ui);
    });

    video.addEventListener('volumechange', function () {
      updateMuteUI();
      setVolumeUI(currentGain());
    });

    // Default full volume
    if (typeof video.volume !== 'number' || isNaN(video.volume)) {
      video.volume = 1;
    }
    lastVolume = video.volume || 1;
    updateMuteUI();
    setVolumeUI(currentGain());
  })();

  // ---------- Fullscreen ----------
  (function activateFullscreen() {
    const $btn = $player.find('.js-fullscreen-button');

    function isFullscreen() {
      return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
    }

    function enterFullscreen() {
      const el = playerContainer;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (el.mozRequestFullScreen) el.mozRequestFullScreen();
      else if (el.msRequestFullscreen) el.msRequestFullscreen();
    }

    function exitFullscreen() {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
    }

    function toggleFullscreen() {
      if (isFullscreen()) exitFullscreen();
      else enterFullscreen();
    }

    $btn.on('click', function (e) {
      e.stopPropagation();
      toggleFullscreen();
    });

    // F toggles fullscreen, matching common desktop video-player controls.
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
          (e.target && e.target.isContentEditable)) return;
      // Use the physical key code so fullscreen also works on non-English layouts
      // (for example, the same key produces "а" on a Russian keyboard).
      if ((e.code === 'KeyF' || e.keyCode === 70) &&
          !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleFullscreen();
      }
    });

    function updateFullscreenUI() {
      $player.toggleClass('is-fullscreen', isFullscreen());
    }

    document.addEventListener('fullscreenchange', updateFullscreenUI);
    document.addEventListener('webkitfullscreenchange', updateFullscreenUI);
    document.addEventListener('mozfullscreenchange', updateFullscreenUI);
    document.addEventListener('MSFullscreenChange', updateFullscreenUI);
    updateFullscreenUI();
  })();

  // ---------- Keyboard seeking ----------
  (function activateKeyboardSeeking() {
    function isTypingTarget(target) {
      var tag = (target && target.tagName) ? target.tagName.toLowerCase() : '';
      return tag === 'input' || tag === 'textarea' || tag === 'select' ||
        (target && target.isContentEditable);
    }

    function seekBy(seconds) {
      var duration = video.duration;
      if (!isFinite(duration) || duration <= 0 || !isFinite(video.currentTime)) return;
      video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
      saveProgress(true);
    }

    document.addEventListener('keydown', function (e) {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekBy(-5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekBy(5);
      }
    });
  })();

  // ---------- Time labels ----------
  (function activateTimeLabels() {
    const $current = $player.find('.js-current-time');
    const $duration = $player.find('.js-duration');

    function updateCurrent() {
      $current.text(formatTime(video.currentTime));
    }
    function updateDuration() {
      $duration.text(formatTime(video.duration));
    }

    video.addEventListener('timeupdate', updateCurrent);
    video.addEventListener('durationchange', updateDuration);
    video.addEventListener('loadedmetadata', updateDuration);
    updateCurrent();
    updateDuration();
  })();

  // ---------- Progress bar ----------
  (function activateProgressbar() {
    const $progress = $player.find('.js-progress');

    function updateFromVideo() {
      if (isSeeking) return;
      const duration = video.duration;
      if (!duration || !isFinite(duration)) {
        setProgress(0);
        return;
      }
      setProgress((video.currentTime / duration) * 100);
    }

    video.addEventListener('timeupdate', updateFromVideo);
    video.addEventListener('durationchange', updateFromVideo);
    video.addEventListener('seeked', function () {
      isSeeking = false;
      updateFromVideo();
    });

    function seekToX(pageX) {
      const duration = video.duration;
      if (!duration || !isFinite(duration)) return;
      const offset = $progress.offset().left;
      const width = $progress.width();
      let percentage = ((pageX - offset) / width) * 100;
      percentage = Math.max(0, Math.min(100, percentage));
      setProgress(percentage);
      video.currentTime = (duration * percentage) / 100;
    }

    $progress.on('mousedown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      isSeeking = true;
      seekToX(e.pageX);
      $(document).on('mousemove.progress', function (e) {
        seekToX(e.pageX);
      });
      $(document).on('mouseup.progress', function () {
        isSeeking = false;
        $(document).off('.progress');
      });
    });

    // Touch support
    $progress.on('touchstart', function (e) {
      e.stopPropagation();
      isSeeking = true;
      const touch = e.originalEvent.touches[0];
      seekToX(touch.pageX);
    });
    $progress.on('touchmove', function (e) {
      if (!isSeeking) return;
      const touch = e.originalEvent.touches[0];
      seekToX(touch.pageX);
    });
    $progress.on('touchend touchcancel', function () {
      isSeeking = false;
    });
  })();

  // ---------- Auto-hide controls ----------
  (function autoHideControls() {
    const HIDE_DELAY = 2500;
    let hideTimer = null;

    function clearHideTimer() {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    function scheduleHide() {
      clearHideTimer();
      if ($player.hasClass('is-playing')) {
        hideTimer = setTimeout(function () {
          $player.removeClass('controls-visible');
        }, HIDE_DELAY);
      }
    }

    function showControls() {
      $player.addClass('controls-visible');
      scheduleHide();
    }

    $player.on('mousemove', showControls);
    $player.on('mouseenter', showControls);
    $player.on('mouseleave', function () {
      clearHideTimer();
      if ($player.hasClass('is-playing') && !$player.hasClass('is-fullscreen')) {
        $player.removeClass('controls-visible');
      }
    });

    const $panels = $player.find('.vp-control-panel, .vp-top-panel');
    $panels.on('mouseenter', clearHideTimer);
    $panels.on('mouseleave', scheduleHide);

    video.addEventListener('pause', function () {
      clearHideTimer();
      $player.addClass('controls-visible');
    });
    video.addEventListener('play', showControls);
    video.addEventListener('ended', function () {
      clearHideTimer();
      $player.addClass('controls-visible');
    });

    document.addEventListener('fullscreenchange', showControls);
    document.addEventListener('webkitfullscreenchange', showControls);

    showControls();
  })();

  // ---------- Series: Season / Episode / Voice ----------
  function activateSeries(playlistData, initial) {
    if (!playlistData || !Array.isArray(playlistData.translations) || !playlistData.translations.length) {
      return;
    }

    const $panel = $player.find('.js-top-panel');
    const $title = $panel.find('.js-series-title');
    const $voiceSelect = $panel.find('.js-select-voice');
    const $seasonSelect = $panel.find('.js-select-season');
    const $episodeSelect = $panel.find('.js-select-episode');

    let voiceIndex = 0;
    let seasonIndex = 0;
    let episodeIndex = 0;
    var savedSelection = readStoredJson(selectionKey());
    var shouldRestoreSelection = !(initial && (
      initial.voice || initial.season || initial.episode || initial.provider
    ));
    var selection = shouldRestoreSelection && savedSelection
      ? Object.assign({}, initial || {}, savedSelection)
      : (initial || {});

    function clampIndex(i, len) {
      if (!len) return 0;
      return Math.min(Math.max(i, 0), len - 1);
    }

    function fillSelect($select, items, getLabel) {
      $select.empty();
      items.forEach(function (item, i) {
        $select.append($('<option></option>').val(i).text(getLabel(item, i)));
      });
    }

    function currentVoice() { return playlistData.translations[voiceIndex]; }
    function currentSeason() { return currentVoice().seasons[seasonIndex]; }
    function currentEpisode() { return currentSeason().episodes[episodeIndex]; }

    function getEpisodeMediaId() {
      var voice = currentVoice();
      var season = currentSeason();
      var episode = currentEpisode();
      var voiceId = voice.provider || voice.name || voiceIndex;
      var seasonId = season.number != null ? season.number : seasonIndex + 1;
      var episodeId = episode.number != null ? episode.number : episodeIndex + 1;
      return 'voice=' + voiceId + '|season=' + seasonId + '|episode=' + episodeId;
    }

    function saveCurrentSelection() {
      var voice = currentVoice();
      var season = currentSeason();
      var episode = currentEpisode();
      writeStoredJson(selectionKey(), {
        voice: voice.name || voice.provider || String(voiceIndex + 1),
        provider: voice.provider || '',
        season: season.number != null ? season.number : seasonIndex + 1,
        episode: episode.number != null ? episode.number : episodeIndex + 1
      });
    }

    function renderVoices() {
      fillSelect($voiceSelect, playlistData.translations, function (t, i) {
        return t.name || ('Voice ' + (i + 1));
      });
      $voiceSelect.val(voiceIndex);
    }

    function renderSeasons() {
      const voice = currentVoice();
      seasonIndex = clampIndex(seasonIndex, voice.seasons.length);
      fillSelect($seasonSelect, voice.seasons, function (s, i) {
        return s.name || ('Season ' + (i + 1));
      });
      $seasonSelect.val(seasonIndex);
    }

    function renderEpisodes() {
      const season = currentSeason();
      episodeIndex = clampIndex(episodeIndex, season.episodes.length);
      fillSelect($episodeSelect, season.episodes, function (e, i) {
        return e.name || ('Episode ' + (i + 1));
      });
      $episodeSelect.val(episodeIndex);
    }

    function updateTitle() {
      const parts = [playlistData.title, currentSeason().name, currentEpisode().name].filter(Boolean);
      $title.text(parts.join(' — '));
      $title.attr('title', parts.join(' — '));
    }

    function loadCurrentEpisode(autoplay) {
      const episode = currentEpisode();
      if (!episode || !episode.src) return;
      updateTitle();
      saveCurrentSelection();
      loadSrc(episode.src, !!autoplay, getEpisodeMediaId());
    }

    $voiceSelect.on('change', function (e) {
      e.stopPropagation();
      voiceIndex = Number($voiceSelect.val()) || 0;
      renderSeasons();
      renderEpisodes();
      loadCurrentEpisode(true);
    });

    $seasonSelect.on('change', function (e) {
      e.stopPropagation();
      seasonIndex = Number($seasonSelect.val()) || 0;
      episodeIndex = 0;
      renderEpisodes();
      loadCurrentEpisode(true);
    });

    $episodeSelect.on('change', function (e) {
      e.stopPropagation();
      episodeIndex = Number($episodeSelect.val()) || 0;
      loadCurrentEpisode(true);
    });

    $panel.on('click mousedown', function (e) {
      e.stopPropagation();
    });

    // Auto-advance
    video.addEventListener('ended', function () {
      const season = currentSeason();
      if (episodeIndex < season.episodes.length - 1) {
        episodeIndex += 1;
        renderEpisodes();
        loadCurrentEpisode(true);
      } else if (seasonIndex < currentVoice().seasons.length - 1) {
        seasonIndex += 1;
        episodeIndex = 0;
        renderSeasons();
        renderEpisodes();
        loadCurrentEpisode(true);
      }
    });

    // Initial selection — match by number when possible
    voiceIndex = 0;
    if (selection && selection.voice) {
      var vRaw = String(selection.voice);
      var vNum = parseInt(vRaw, 10);
      if (!isNaN(vNum) && String(vNum) === vRaw) {
        voiceIndex = clampIndex(vNum - 1, playlistData.translations.length);
      } else {
        var vLow = vRaw.toLowerCase();
        var providerLow = selection.provider ? String(selection.provider).toLowerCase() : '';
        var foundV = playlistData.translations.findIndex(function (t) {
          var name = (t.name || '').toLowerCase();
          var provider = (t.provider || '').toLowerCase();
          if (providerLow && provider === providerLow) {
            return !vLow || name.indexOf(vLow) >= 0;
          }
          return name.indexOf(vLow) >= 0 || provider === vLow;
        });
        if (foundV >= 0) voiceIndex = foundV;
      }
    }
    renderVoices();

    seasonIndex = 0;
    if (selection && selection.season) {
      var wantS = parseInt(selection.season, 10) || 1;
      var foundS = currentVoice().seasons.findIndex(function (s, i) {
        return (s.number != null ? Number(s.number) : i + 1) === wantS;
      });
      seasonIndex = foundS >= 0 ? foundS : clampIndex(wantS - 1, currentVoice().seasons.length);
    }
    renderSeasons();

    episodeIndex = 0;
    if (selection && selection.episode) {
      var wantE = parseInt(selection.episode, 10) || 1;
      var foundE = currentSeason().episodes.findIndex(function (ep, i) {
        return (ep.number != null ? Number(ep.number) : i + 1) === wantE;
      });
      episodeIndex = foundE >= 0 ? foundE : clampIndex(wantE - 1, currentSeason().episodes.length);
    }
    renderEpisodes();

    function updateSelectorsVisibility() {
      var voice = currentVoice();
      var multiVoice = playlistData.translations.length > 1;
      var multiSeason = voice.seasons.length > 1;
      var multiEpisode = currentSeason().episodes.length > 1;
      $voiceSelect.closest('.vp-select-wrap').toggle(multiVoice);
      $seasonSelect.closest('.vp-select-wrap').toggle(multiSeason);
      $episodeSelect.closest('.vp-select-wrap').toggle(multiEpisode);
    }
    updateSelectorsVisibility();
    // re-run after voice/season changes
    $voiceSelect.on('change.vis', updateSelectorsVisibility);
    $seasonSelect.on('change.vis', updateSelectorsVisibility);

    $panel.addClass('is-active');
    // Ensure controls stay visible so the series bar is not faded out
    $player.addClass('controls-visible is-paused');
    loadCurrentEpisode(false);
  }


  // ---------- UAFilms / filmapi backend (TMDB → streams) ----------
  function showStatus(msg) {
    var $st = $player.find('.js-status');
    if (!$st.length) {
      $st = $('<div class="js-status vp-status"></div>');
      $player.append($st);
    }
    if (msg) {
      $st.text(msg).addClass('is-visible');
    } else {
      $st.removeClass('is-visible').text('');
    }
  }

  /**
   * Normalize providers from filmapi.proside.pp.ua
   * Movie: { provider: [ stream, ... ] }
   * TV:    { provider: { season: { episode: [ stream, ... ] } } }
   */
  function flattenMovieProviders(providers, preferredProvider, preferredVoice) {
    var list = [];
    if (!providers || typeof providers !== 'object') return list;
    Object.keys(providers).forEach(function (prov) {
      var streams = providers[prov];
      if (!Array.isArray(streams)) return;
      streams.forEach(function (s, i) {
        list.push({
          provider: prov,
          name: (s.title || prov) + (streams.length > 1 ? ' #' + (i + 1) : ''),
          src: s.url,
          mime: s.mime,
          poster: s.poster,
          subtitles: s.subtitles || [],
          headers: s.headers
        });
      });
    });
    // prefer provider / voice
    if (preferredProvider) {
      list.sort(function (a, b) {
        var ap = a.provider === preferredProvider ? 0 : 1;
        var bp = b.provider === preferredProvider ? 0 : 1;
        return ap - bp;
      });
    }
    if (preferredVoice) {
      var v = String(preferredVoice).toLowerCase();
      list.sort(function (a, b) {
        var an = (a.name || '').toLowerCase().indexOf(v) >= 0 ? 0 : 1;
        var bn = (b.name || '').toLowerCase().indexOf(v) >= 0 ? 0 : 1;
        return an - bn;
      });
    }
    return list;
  }

  function pickTvStream(providers, seasonNum, episodeNum, preferredProvider, preferredVoice) {
    seasonNum = String(seasonNum || 1);
    episodeNum = String(episodeNum || 1);
    var candidates = [];
    if (!providers || typeof providers !== 'object') return candidates;

    Object.keys(providers).forEach(function (prov) {
      var seasons = providers[prov];
      if (!seasons || typeof seasons !== 'object') return;
      var eps = seasons[seasonNum];
      if (!eps || typeof eps !== 'object') return;
      var streams = eps[episodeNum];
      if (!Array.isArray(streams)) return;
      streams.forEach(function (s, i) {
        candidates.push({
          provider: prov,
          name: s.title || prov,
          src: s.url,
          mime: s.mime,
          poster: s.poster,
          subtitles: s.subtitles || [],
          headers: s.headers,
          season: Number(seasonNum),
          episode: Number(episodeNum)
        });
      });
    });

    if (preferredProvider) {
      candidates.sort(function (a, b) {
        return (a.provider === preferredProvider ? 0 : 1) - (b.provider === preferredProvider ? 0 : 1);
      });
    }
    if (preferredVoice) {
      var v = String(preferredVoice).toLowerCase();
      candidates.sort(function (a, b) {
        var an = (a.name || '').toLowerCase().indexOf(v) >= 0 ? 0 : 1;
        var bn = (b.name || '').toLowerCase().indexOf(v) >= 0 ? 0 : 1;
        return an - bn;
      });
    }
    return candidates;
  }

  /**
   * Build series playlist for UI:
   * translations = unique озвучки (stream.title), each with full season/episode tree.
   * Fallback translation key = provider name if title empty.
   */
  function tvProvidersToPlaylist(providers, title) {
    // voiceKey -> seasonNum -> episodeNum -> stream
    var byVoice = {};

    Object.keys(providers || {}).forEach(function (prov) {
      var seasons = providers[prov];
      if (!seasons || typeof seasons !== 'object') return;

      Object.keys(seasons).forEach(function (sNum) {
        var eps = seasons[sNum];
        if (!eps || typeof eps !== 'object') return;

        Object.keys(eps).forEach(function (eNum) {
          var streams = eps[eNum];
          if (!Array.isArray(streams)) return;

          streams.forEach(function (s) {
            var voiceName = (s.title && String(s.title).trim()) || prov;
            // Disambiguate same title from different providers
            var voiceKey = voiceName + ' · ' + prov;
            if (!byVoice[voiceKey]) {
              byVoice[voiceKey] = { name: voiceName, provider: prov, seasons: {} };
            }
            if (!byVoice[voiceKey].seasons[sNum]) byVoice[voiceKey].seasons[sNum] = {};
            // Keep first stream for this voice/season/episode
            if (!byVoice[voiceKey].seasons[sNum][eNum]) {
              byVoice[voiceKey].seasons[sNum][eNum] = {
                name: 'Episode ' + eNum,
                src: s.url || '',
                poster: s.poster,
                subtitles: s.subtitles || [],
                provider: prov
              };
            }
          });
        });
      });
    });

    var voiceKeys = Object.keys(byVoice);
    if (!voiceKeys.length) {
      return { title: title || 'Series', translations: [] };
    }

    // Collect global season/episode union so each voice has consistent structure
    var allSeasons = {};
    voiceKeys.forEach(function (vk) {
      Object.keys(byVoice[vk].seasons).forEach(function (sNum) {
        if (!allSeasons[sNum]) allSeasons[sNum] = {};
        Object.keys(byVoice[vk].seasons[sNum]).forEach(function (eNum) {
          allSeasons[sNum][eNum] = true;
        });
      });
    });

    var seasonNums = Object.keys(allSeasons).map(Number).sort(function (a, b) { return a - b; });

    var translations = voiceKeys.map(function (vk) {
      var voice = byVoice[vk];
      return {
        name: voice.name,
        provider: voice.provider,
        seasons: seasonNums.map(function (sNum) {
          var epsMap = voice.seasons[String(sNum)] || {};
          var epNums = Object.keys(allSeasons[String(sNum)] || {}).map(Number).sort(function (a, b) { return a - b; });
          return {
            name: 'Сезон ' + sNum,
            number: sNum,
            episodes: epNums.map(function (eNum) {
              var ep = epsMap[String(eNum)];
              if (ep) {
                return {
                  name: 'Серія ' + eNum,
                  number: eNum,
                  src: ep.src,
                  poster: ep.poster,
                  subtitles: ep.subtitles
                };
              }
              // Missing episode for this voice — empty src (UI still shows slot)
              return {
                name: 'Серія ' + eNum,
                number: eNum,
                src: ''
              };
            }).filter(function (ep) { return !!ep.src; }) // only available episodes for this voice
          };
        }).filter(function (season) { return season.episodes.length > 0; })
      };
    }).filter(function (t) { return t.seasons.length > 0; });

    // Prefer voices with more coverage first
    translations.sort(function (a, b) {
      var ac = a.seasons.reduce(function (n, s) { return n + s.episodes.length; }, 0);
      var bc = b.seasons.reduce(function (n, s) { return n + s.episodes.length; }, 0);
      return bc - ac;
    });

    return {
      title: title || 'Series',
      translations: translations
    };
  }

  function fetchTmdbStreams(opts) {
    var id = opts.id;
    var type = opts.type || 'movie';
    var base = apiBase.replace(/\/$/, '');
    var getUrl = base + '/api/get?id=' + encodeURIComponent(id) + '&type=' + encodeURIComponent(type);
    var detailsUrl = base + '/api/details?id=' + encodeURIComponent(id) + '&type=' + encodeURIComponent(type);
    showStatus('Завантаження…');

    var detailsPromise = fetch(detailsUrl, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });

    return Promise.all([
      fetch(getUrl, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('API HTTP ' + r.status);
        return r.json();
      }),
      detailsPromise
    ]).then(function (pair) {
      var data = pair[0] || {};
      var details = pair[1];
      if (details) {
        data.title = data.title || details.title || details.originalTitle || details.original_title;
        data.poster = data.poster || details.posterUrl || details.poster_path;
        data.mediaType = details.type || details.media_type || null;
      }
      // Heuristic: TV providers are nested objects (season->episode), movie is arrays
      if (!data.mediaType && data.providers) {
        var first = data.providers[Object.keys(data.providers)[0]];
        if (first && !Array.isArray(first) && typeof first === 'object') {
          data.mediaType = 'tv';
        } else {
          data.mediaType = 'movie';
        }
      }
      showStatus('');
      return data;
    }).catch(function (err) {
      showStatus('Помилка API: ' + (err && err.message ? err.message : err));
      throw err;
    });
  }

  function applyMovieStreams(data, opts) {
    var streams = flattenMovieProviders(
      data.providers || data.sources,
      opts.provider,
      opts.voice
    );
    if (!streams.length) {
      showStatus('Стріми не знайдено');
      return;
    }
    playerContainer._vpStreams = streams;

    // Multiple voices/sources → show top panel selector (as 1 season / 1 episode series)
    if (streams.length > 1) {
      var pl = {
        title: data.title || ('TMDB ' + (opts.id || '')),
        translations: streams.map(function (s) {
          return {
            name: s.name || s.provider,
            provider: s.provider,
            seasons: [{
              name: '',
              number: 1,
              episodes: [{ name: data.title || 'Film', number: 1, src: s.src, poster: s.poster }]
            }]
          };
        })
      };
      var initial = { season: '1', episode: '1' };
      if (opts.voice || opts.provider) {
        var pref = String(opts.voice || opts.provider).toLowerCase();
        var idx = pl.translations.findIndex(function (t) {
          return (t.name || '').toLowerCase().indexOf(pref) >= 0 ||
                 (t.provider || '').toLowerCase() === pref;
        });
        if (idx >= 0) initial.voice = String(idx + 1);
      }
      activateSeries(pl, initial);
      return;
    }

    loadSrc(streams[0].src, false, 'movie');
    if (streams[0].poster) {
      video.setAttribute('poster', streams[0].poster);
    }
  }

  function applyTvStreams(data, opts) {
    var s = opts.season || 1;
    var e = opts.episode || 1;
    var pl = tvProvidersToPlaylist(data.providers || {}, data.title || ('TMDB ' + opts.id));

    console.log('[series] voices:', pl.translations.map(function (t) { return t.name; }));
    console.log('[series] seasons in first voice:', pl.translations[0] && pl.translations[0].seasons.map(function (x) { return x.name + ':' + x.episodes.length; }));

    if (!pl.translations.length) {
      showStatus('Серіал: стріми не знайдено');
      return;
    }

    // Map preferred provider/voice to translation index (1-based for activateSeries)
    var initial = {
      season: opts.season != null ? String(s) : null,
      episode: opts.episode != null ? String(e) : null,
      voice: undefined
    };

    if (opts.provider || opts.voice) {
      var prefProv = (opts.provider || '').toLowerCase();
      var prefVoice = (opts.voice || '').toLowerCase();
      var idx = pl.translations.findIndex(function (t) {
        var name = (t.name || '').toLowerCase();
        var prov = (t.provider || '').toLowerCase();
        if (prefProv && prov === prefProv) return true;
        if (prefVoice && name.indexOf(prefVoice) >= 0) return true;
        return false;
      });
      if (idx >= 0) initial.voice = String(idx + 1);
    }

    playerContainer._vpStreams = pickTvStream(data.providers, s, e, opts.provider, opts.voice);
    activateSeries(pl, initial);
  }


  // ---------- Init ----------
  function start() {
    // 1) TMDB resolution via backend
    if (tmdb && tmdb.id) {
      fetchTmdbStreams(tmdb).then(function (data) {
        var kind = (tmdb.type || data.mediaType || 'movie');
        if (kind === 'tv' || kind === 'series') {
          applyTvStreams(data, tmdb);
        } else {
          applyMovieStreams(data, tmdb);
        }
      }).catch(function () {
        // status already shown
      });
      return;
    }

    // 2) Playlist (series mode)
    if (playlist && typeof playlist.then === 'function') {
      playlist.then(function (data) {
        activateSeries(data, initialSelection);
      }).catch(function (err) {
        console.error('Failed to load playlist', err);
        loadSrc(src, false);
      });
    } else if (playlist) {
      activateSeries(playlist, initialSelection);
    } else if (src) {
      loadSrc(src, false, 'direct|' + src);
    } else {
      showStatus('Вкажіть ?src= або ?tmdb=');
    }
  }

  start();

  // Public-ish API on the container (optional)
  playerContainer._vp = {
    load: function (url, autoplay) { loadSrc(url, !!autoplay); },
    play: function () { return video.play(); },
    pause: function () { video.pause(); },
    getVideo: function () { return video; }
  };
}
