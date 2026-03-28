/* global lil */

const PET_W = 112;
const VIDEO_DURATION = 10;
const DISPLAY_W = Math.round(200 * (1080 / 1920));

let state = null;
let stageWidth = 800;
let rafId = 0;
let chatOpenForId = null;
let lastMousePassthrough = null;

const bruce = {
  id: 'bruce',
  el: null,
  bodyEl: null,
  videoEl: null,
  timings: { accelStart: 3.0, fullSpeedStart: 3.75, decelStart: 8.0, walkStop: 8.5 },
  walkAmountRange: [0.4, 0.65],
  flipXOffset: 0,
  positionProgress: 0.3,
  goingRight: true,
  walking: false,
  pauseUntilMs: 0,
  walkStartTimeMs: 0,
  walkStartPos: 0,
  walkEndPos: 0,
  walkStartPixel: 0,
  walkEndPixel: 0,
  videoIsPlaying: false,
  thinkingText: '',
  completionText: '',
  completionUntil: 0
};

const jazz = {
  id: 'jazz',
  el: null,
  bodyEl: null,
  videoEl: null,
  timings: { accelStart: 3.9, fullSpeedStart: 4.5, decelStart: 8.0, walkStop: 8.75 },
  walkAmountRange: [0.35, 0.6],
  flipXOffset: Math.round((-9 * PET_W) / 112.5),
  positionProgress: 0.7,
  goingRight: false,
  walking: false,
  pauseUntilMs: 0,
  walkStartTimeMs: 0,
  walkStartPos: 0,
  walkEndPos: 0,
  walkStartPixel: 0,
  walkEndPixel: 0,
  videoIsPlaying: false,
  thinkingText: '',
  completionText: '',
  completionUntil: 0
};

function getPet(id) {
  return id === 'jazz' ? jazz : bruce;
}

function $(id) {
  return document.getElementById(id);
}

function rndRange(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function roundToHalfPixel(value) {
  return Math.round(value * 2) / 2;
}

function movementPositionAt(videoTime, t) {
  const { accelStart, fullSpeedStart, decelStart, walkStop } = t;
  const dIn = fullSpeedStart - accelStart;
  const dLin = decelStart - fullSpeedStart;
  const dOut = walkStop - decelStart;
  const v = 1.0 / (dIn / 2.0 + dLin + dOut / 2.0);

  if (videoTime <= accelStart) return 0;
  if (videoTime <= fullSpeedStart) {
    const tt = videoTime - accelStart;
    return (v * tt * tt) / (2.0 * dIn);
  }
  if (videoTime <= decelStart) {
    const easeInDist = (v * dIn) / 2.0;
    const tt = videoTime - fullSpeedStart;
    return easeInDist + v * tt;
  }
  if (videoTime <= walkStop) {
    const easeInDist = (v * dIn) / 2.0;
    const linearDist = v * dLin;
    const tt = videoTime - decelStart;
    return easeInDist + linearDist + v * (tt - (tt * tt) / (2.0 * dOut));
  }
  return 1;
}

function travelAndPad() {
  const dockPad = Math.max(24, stageWidth * 0.08);
  const travelDistance = Math.max(stageWidth - 2 * dockPad - DISPLAY_W, 0);
  return { dockPad, travelDistance };
}

function startWalk(cfg, other, travelDistance) {
  if (cfg.positionProgress > 0.85) cfg.goingRight = false;
  else if (cfg.positionProgress < 0.15) cfg.goingRight = true;
  else cfg.goingRight = Math.random() > 0.5;

  cfg.walkStartPos = cfg.positionProgress;
  const referenceWidth = 500;
  const walkPixels = rndRange(cfg.walkAmountRange[0], cfg.walkAmountRange[1]) * referenceWidth;
  const walkAmount = travelDistance > 0 ? walkPixels / travelDistance : 0.3;
  if (cfg.goingRight) cfg.walkEndPos = Math.min(cfg.walkStartPos + walkAmount, 1);
  else cfg.walkEndPos = Math.max(cfg.walkStartPos - walkAmount, 0);

  const minSep = 0.12;
  const siblingPos = other.positionProgress;
  if (Math.abs(cfg.walkEndPos - siblingPos) < minSep) {
    if (cfg.goingRight) cfg.walkEndPos = Math.max(cfg.walkStartPos, siblingPos - minSep);
    else cfg.walkEndPos = Math.min(cfg.walkStartPos, siblingPos + minSep);
  }

  cfg.walkStartPixel = cfg.walkStartPos * travelDistance;
  cfg.walkEndPixel = cfg.walkEndPos * travelDistance;
  cfg.walkStartTimeMs = performance.now();
  cfg.walking = true;
}

function enterPause(cfg) {
  cfg.walking = false;
  cfg.pauseUntilMs = performance.now() + rndRange(5000, 12000);
}

function updateWalker(cfg, other, nowMs) {
  const { travelDistance } = travelAndPad();
  if (chatOpenForId === cfg.id) return;

  if (!cfg.walking) {
    if (nowMs >= cfg.pauseUntilMs) startWalk(cfg, other, travelDistance);
    return;
  }

  const elapsed = (nowMs - cfg.walkStartTimeMs) / 1000;
  const videoTime = Math.min(elapsed, VIDEO_DURATION);
  const walkNorm = elapsed >= VIDEO_DURATION ? 1.0 : movementPositionAt(videoTime, cfg.timings);
  const currentPixel = cfg.walkStartPixel + (cfg.walkEndPixel - cfg.walkStartPixel) * walkNorm;

  if (travelDistance > 0) {
    cfg.positionProgress = Math.min(Math.max(currentPixel / travelDistance, 0), 1);
  }

  if (elapsed >= VIDEO_DURATION) {
    cfg.walkEndPos = cfg.positionProgress;
    enterPause(cfg);
  }
}

async function hydrateState() {
  state = await lil.getState();
  applyVisibility();
  applyTheme();
}

async function tryLoadVideoOnce(cfg, assetRelPath) {
  if (!cfg.videoEl || !cfg.bodyEl) return;

  const src = await lil.getAssetPath(assetRelPath);
  if (!src) throw new Error(`invalid asset path: ${assetRelPath}`);
  cfg.videoEl.loop = false;
  cfg.videoEl.muted = true;
  cfg.videoEl.playsInline = true;
  cfg.videoEl.preload = 'auto';
  cfg.videoEl.disablePictureInPicture = true;
  cfg.videoEl.style.display = 'block';
  cfg.videoEl.currentTime = 0;
  cfg.videoEl.src = src;

  return new Promise((resolve, reject) => {
    cfg.videoEl.addEventListener(
      'loadeddata',
      () => {
        cfg.bodyEl.classList.remove('fallback');
        cfg.el.classList.add('has-video');
        resolve(true);
      },
      { once: true }
    );
    cfg.videoEl.addEventListener(
      'error',
      () => {
        cfg.videoEl.style.display = 'none';
        reject(new Error(`video failed: ${assetRelPath}`));
      },
      { once: true }
    );
  });
}

async function loadVideoAssetCandidates(cfg, candidates) {
  for (const rel of candidates) {
    try {
      await tryLoadVideoOnce(cfg, rel);
      return;
    } catch {
      // continue
    }
  }
}

function applyVisibility() {
  if (!state) return;
  $('pet-bruce').style.display = state.showBruce ? '' : 'none';
  $('pet-jazz').style.display = state.showJazz ? '' : 'none';
}

function applyTheme() {
  document.body.dataset.theme = state?.theme || 'Peach';
}

function setPassthrough(ignore) {
  if (lastMousePassthrough === ignore) return;
  lastMousePassthrough = ignore;
  lil.setMousePassthrough(ignore);
}

function updatePassthroughFromPoint(clientX, clientY) {
  const pets = document.querySelectorAll('.pet');
  for (const p of pets) {
    if (p.style.display === 'none') continue;
    const r = p.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      setPassthrough(false);
      return;
    }
  }
  setPassthrough(true);
}

let lastPassthroughTick = 0;
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastPassthroughTick < 33) return;
  lastPassthroughTick = now;
  updatePassthroughFromPoint(e.clientX, e.clientY);
});
document.addEventListener('mouseleave', () => setPassthrough(true));

function showBubble(petEl, text, ms = 2200) {
  const b = petEl.querySelector('.bubble');
  if (!b) return;
  b.textContent = text;
  b.hidden = false;
  clearTimeout(b._t);
  b._t = setTimeout(() => {
    b.hidden = true;
  }, ms);
}

function hideBubble(cfg) {
  const b = cfg.el?.querySelector('.bubble');
  if (!b) return;
  clearTimeout(b._t);
  b.hidden = true;
}

function handleThinkingBubbles(nowMs) {
  const pets = [bruce, jazz];
  for (const cfg of pets) {
    if (cfg.completionText && nowMs < cfg.completionUntil) {
      showBubble(cfg.el, cfg.completionText, 400);
      continue;
    }
    if (cfg.completionText && nowMs >= cfg.completionUntil) {
      cfg.completionText = '';
      cfg.completionUntil = 0;
      hideBubble(cfg);
    }
    if (cfg.thinkingText && chatOpenForId !== cfg.id) {
      showBubble(cfg.el, cfg.thinkingText, 600);
    }
  }
}

function placePet(cfg) {
  const { dockPad, travelDistance } = travelAndPad();
  const flip = cfg.goingRight ? 0 : cfg.flipXOffset;
  const x = dockPad + travelDistance * cfg.positionProgress + flip + PET_W / 2;
  cfg.el.style.left = `${roundToHalfPixel(x)}px`;
  cfg.el.style.setProperty('--dir', cfg.goingRight ? '1' : '-1');
  cfg.el.classList.toggle('walking', cfg.walking && chatOpenForId !== cfg.id);
}

function syncVideoPlayback(cfg) {
  if (!cfg.videoEl) return;
  const shouldPlay = !!cfg.walking && chatOpenForId !== cfg.id;
  if (cfg.videoIsPlaying === shouldPlay) return;
  cfg.videoIsPlaying = shouldPlay;

  if (shouldPlay) {
    try {
      cfg.videoEl.currentTime = 0;
    } catch {}
    cfg.videoEl.play().catch(() => {});
  } else {
    try {
      cfg.videoEl.pause();
      cfg.videoEl.currentTime = 0;
    } catch {}
  }
}

function playBeep(freq, dur) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = freq;
    g.gain.value = 0.08;
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, dur * 1000);
  } catch {}
}

async function playCompletionSound(fileName) {
  if (!fileName) return;
  try {
    const src = await lil.getAssetPath(`Sounds/${fileName}`);
    const audio = new Audio(src);
    audio.volume = 0.9;
    audio.play().catch(() => {});
  } catch {
    playBeep(880, 0.06);
  }
}

function handlePetClick(id) {
  const cfg = getPet(id);
  chatOpenForId = id;
  cfg.walking = false;
  hideBubble(cfg);
  cfg.thinkingText = '';

  const rect = cfg.el.getBoundingClientRect();
  lil.openChat({
    id,
    anchor: {
      screenX: Math.round(window.screenX + rect.left + rect.width / 2),
      screenY: Math.round(window.screenY + rect.top)
    }
  });
}

function bindPetClicks() {
  $('pet-bruce').addEventListener('click', () => handlePetClick('bruce'));
  $('pet-jazz').addEventListener('click', () => handlePetClick('jazz'));
}

function loop() {
  const nowMs = performance.now();
  updateWalker(bruce, jazz, nowMs);
  updateWalker(jazz, bruce, nowMs);
  syncVideoPlayback(bruce);
  syncVideoPlayback(jazz);
  placePet(bruce);
  placePet(jazz);
  handleThinkingBubbles(nowMs);
  rafId = requestAnimationFrame(loop);
}

function onResize() {
  stageWidth = document.body.clientWidth || window.innerWidth;
}

window.addEventListener('resize', onResize);

if (window.lil) {
  lil.onPetCommand((cmd, payload) => {
    if (cmd === 'visibility' && payload) {
      state = state || {};
      if (typeof payload.bruce === 'boolean') state.showBruce = payload.bruce;
      if (typeof payload.jazz === 'boolean') state.showJazz = payload.jazz;
      applyVisibility();
    }
    if (cmd === 'theme' && payload?.theme) {
      state = state || {};
      state.theme = payload.theme;
      applyTheme();
    }
    if (cmd === 'thinking' && payload?.id) {
      const cfg = getPet(payload.id);
      cfg.completionText = '';
      cfg.thinkingText = payload.text || 'thinking...';
      if (chatOpenForId === cfg.id) cfg.thinkingText = '';
    }
    if (cmd === 'hide-thinking' && payload?.id) {
      const cfg = getPet(payload.id);
      cfg.thinkingText = '';
      hideBubble(cfg);
    }
    if (cmd === 'completion' && payload?.id) {
      const cfg = getPet(payload.id);
      cfg.thinkingText = '';
      cfg.completionText = payload.text || 'done!';
      cfg.completionUntil = performance.now() + 3000;
    }
    if (cmd === 'hide-completion') {
      if (payload?.id) {
        const cfg = getPet(payload.id);
        cfg.completionText = '';
        cfg.completionUntil = 0;
        hideBubble(cfg);
      } else {
        for (const cfg of [bruce, jazz]) {
          cfg.completionText = '';
          cfg.completionUntil = 0;
          hideBubble(cfg);
        }
      }
    }
    if (cmd === 'chat-opened' && payload?.id) {
      chatOpenForId = payload.id;
    }
    if (cmd === 'chat-closed') {
      chatOpenForId = null;
    }
    if (cmd === 'ding') {
      if (state?.sounds) {
        if (payload?.file) playCompletionSound(payload.file);
        else playBeep(880, 0.06);
      }
    }
  });
}

(async function init() {
  bruce.el = $('pet-bruce');
  bruce.bodyEl = $('bruce-body');
  bruce.videoEl = $('bruce-video');
  jazz.el = $('pet-jazz');
  jazz.bodyEl = $('jazz-body');
  jazz.videoEl = $('jazz-video');

  onResize();
  await hydrateState();

  await loadVideoAssetCandidates(bruce, [
    'LilAgentsWin/renderer/assets/walk-bruce-01.webm',
    'Sounds/LilAgents_walk-bruce-01.mov',
    'Sounds/walk-bruce-01.mov',
    'LilAgents/walk-bruce-01.mov'
  ]);
  await loadVideoAssetCandidates(jazz, [
    'LilAgentsWin/renderer/assets/walk-jazz-01.webm',
    'Sounds/walk-jazz-01.mov',
    'LilAgents/walk-jazz-01.mov'
  ]);

  bindPetClicks();
  const t0 = performance.now();
  bruce.pauseUntilMs = t0 + rndRange(500, 2000);
  jazz.pauseUntilMs = t0 + rndRange(8000, 14000);
  setPassthrough(true);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
})();
