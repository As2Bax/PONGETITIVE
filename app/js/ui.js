'use strict';

/* ============================================================
   Main loop
   ============================================================ */
function loop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 1 / 30);
  lastTime = ts;
  update(dt);
  if (!transitioning) syncSpectatorPanel();
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame((ts) => { lastTime = ts; requestAnimationFrame(loop); });

/* ============================================================
   UI / input
   ============================================================ */
const overlays = { menu: byId('menu'), pause: byId('pause'), gameover: byId('gameover') };
function byId(id) { return document.getElementById(id); }
function show(name) {
  Object.values(overlays).forEach(o => o.classList.remove('visible'));
  if (name) overlays[name].classList.add('visible');
  if (name === 'gameover') syncRematchButton();
}

/* Only the host can requeue a PvP match, for the same reason only the host can
   start one: it owns the settings, and both clients must restart together.

   A guest's rematch button therefore has nothing to do, so it is disabled and
   relabeled rather than left on screen as a control that silently does
   nothing. The lobby's START MATCH button behaves the same way for a guest. */
function syncRematchButton() {
  const btn = byId('rematch-btn');
  if (!btn) return;
  const guest = state.opponent === 'pvp' && roomClient.role === 'guest';
  // A host whose opponent has left cannot requeue either: there is nobody to
  // play, and the room is gone.
  const strandedHost = state.opponent === 'pvp' && roomClient.role === 'host' && !roomClient.ready;
  btn.disabled = guest || strandedHost;
  btn.textContent = guest ? 'WAITING FOR HOST'
    : strandedHost ? 'OPPONENT LEFT'
    : 'REMATCH';
}

// Manual spectator spawns intentionally override CUSTOM spawn-pool toggles,
// but keep hard population limits to avoid an unbounded sandbox.
const spawnChoice = byId('spawn-choice');
for (const [label, entries] of [
  ['Balls', Object.keys(BALL_TYPES).map(type => [`ball:${type}`, `${type.toUpperCase()} BALL`])],
  ['Power-ups', Object.entries(POWERUP_TYPES).map(([type, info]) => [`power:${type}`, info.name])],
  ['Field events', [['event:well', 'GRAVITY WELL'], ['event:wind', 'WIND'], ['event:portals', 'PORTALS']]],
]) {
  const group = document.createElement('optgroup');
  group.label = label;
  for (const [value, text] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    group.appendChild(option);
  }
  spawnChoice.appendChild(group);
}
function syncSpectatorPanel() {
  const visible = isAivai() && ['play', 'countdown', 'pause'].includes(state.mode);
  byId('spectator-panel').hidden = !visible;
  document.body.classList.toggle('spectating', visible);
  byId('spawn-btn').disabled = state.mode !== 'play';
}
byId('spawn-btn').addEventListener('click', () => {
  if (!isAivai() || state.mode !== 'play') return;
  const [kind, type] = spawnChoice.value.split(':');
  const status = byId('spawn-status');
  const x = W * (0.35 + Math.random() * 0.3);
  const y = topWall() + 50 + Math.random() * Math.max(0, botWall() - topWall() - 100);
  if (kind === 'ball') {
    if (balls.length >= HARD_BALL_CAP) { status.textContent = 'Ball limit reached.'; return; }
    const b = makeBall(x, y, Math.random() < 0.5 ? -1 : 1);
    const angle = Math.atan2(b.vy, b.vx);
    b.type = type;
    b.speed = baseBallSpeed() * (type === 'heavy' ? 0.72 : type === 'comet' ? 1.25 : 1);
    b.r = type === 'heavy' ? BALL_R * 1.6 : type === 'comet' ? BALL_R * 0.65 : type === 'gold' ? BALL_R * 1.2 : BALL_R;
    b.vx = Math.cos(angle) * b.speed;
    b.vy = Math.sin(angle) * b.speed;
    balls.push(b);
  } else if (kind === 'power') {
    if (powerups.length >= 10) { status.textContent = 'Pickup limit reached.'; return; }
    powerups.push({ type, x, y, life: 10, born: performance.now() });
  } else if (type === 'well') {
    if (state.well) { status.textContent = 'A gravity well is already active.'; return; }
    state.well = { x, y, life: WELL_LIFE };
  } else if (type === 'wind') {
    if (state.windLife > 0) { status.textContent = 'Wind is already active.'; return; }
    state.wind = (Math.random() < 0.5 ? -1 : 1) * WIND_FORCE;
    state.windLife = WIND_LIFE;
    state.windSpawnT = state.fieldTime;
  } else if (type === 'portals') {
    if (state.portals) { status.textContent = 'Portals are already active.'; return; }
    state.portals = {
      a: { x: W * 0.28, y }, b: { x: W * 0.72, y: topWall() + botWall() - y },
      life: PORTAL_LIFE, spawnT: state.fieldTime,
    };
  }
  status.textContent = `Added ${spawnChoice.selectedOptions[0].textContent.toLowerCase()}.`;
  spawnParticles(x, y, '#d9a441', 12, 180);
  sfx.click();   // spectator UI action, not an in-play pickup
  // Remove focus so keyboard navigation cannot accidentally re-trigger a spawn.
  byId('spawn-btn').blur();
});

// option buttons
function bindOptions(groupId, apply) {
  const group = byId(groupId);
  group.querySelectorAll('.opt').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      apply(btn.dataset.value);
      // Keep a waiting guest's locked panel showing the host's live choices.
      netBroadcastSettings();
    });
  });
}
const CUSTOM_CONTROL_GROUPS = [
  'c-paddle-options', 'c-speed-options', 'c-curse-options', 'c-ai-options',
  'c-ball-options', 'c-powerup-options', 'c-field-options',
];

// Which AI tier a preset difficulty actually runs, for the read-only summary.
const presetAiSkill = (settings) =>
  settings.aiPerfect ? 'perfect' :
  settings.aiSharp ? 'sharp' :
  settings.aiChill ? 'chill' : 'standard';

// Presets use the same controls as Custom as a read-only summary. Values that
// fall between Custom's named size/speed steps use the nearest visible step.
const PRESET_CONTROL_VALUES = {
  relaxed:    { paddle: 'big',    speed: 'slow' },
  easy:       { paddle: 'big',    speed: 'slow' },
  normal:     { paddle: 'normal', speed: 'normal' },
  hard:       { paddle: 'small',  speed: 'fast' },
  insane:     { paddle: 'tiny',   speed: 'ludicrous' },
  impossible: { paddle: 'tiny',   speed: 'ludicrous' },
};

function setControlSelection(groupId, selectedValues) {
  byId(groupId).querySelectorAll('.opt').forEach(btn =>
    btn.classList.toggle('selected', selectedValues.includes(btn.dataset.value)));
}

function syncCustomControls() {
  const editable = state.difficulty === 'custom';
  byId('difficulty-panel').classList.toggle('preset-locked', !editable);

  /* AI SKILL tunes the bot brain, and in Player vs Player there is no bot on
     either side - both paddles are human. Leaving the control visible offered a
     setting that provably does nothing, and the read-only preset summary below
     would still light up a tier as though one were in play. */
  const hideAi = state.opponent === 'pvp';
  byId('c-ai-group').style.display = hideAi ? 'none' : '';
  /* The card matrix centers its final card, because seven cards leave an orphan
     in a three-column grid. Hiding one makes six, which divide evenly, so that
     centering has to be switched off or the last card drops to its own row. */
  byId('difficulty-settings').classList.toggle('no-ai', hideAi);
  CUSTOM_CONTROL_GROUPS.forEach(groupId =>
    byId(groupId).querySelectorAll('.opt').forEach(btn => { btn.disabled = !editable; }));

  if (editable) {
    setControlSelection('c-paddle-options', [customSettings.paddle]);
    setControlSelection('c-speed-options', [customSettings.speed]);
    setControlSelection('c-curse-options', Object.keys(customSettings).filter(key => customSettings[key] === true));
    setControlSelection('c-ai-options', [customSettings.aiSkill]);
    setControlSelection('c-ball-options', Object.keys(customSettings.balls).filter(key => customSettings.balls[key]));
    setControlSelection('c-powerup-options', Object.keys(customSettings.powerups).filter(key => customSettings.powerups[key]));
    setControlSelection('c-field-options', ['portals', 'well', 'wind'].filter(key => customSettings[key]));
    return;
  }

  const preset = PRESET_CONTROL_VALUES[state.difficulty];
  const settings = cfg();
  setControlSelection('c-paddle-options', [preset.paddle]);
  setControlSelection('c-speed-options', [preset.speed]);
  setControlSelection('c-curse-options', ['wear', 'fog', 'flicker', 'inverted'].filter(key =>
    key === 'wear' ? settings.rallyShrink : Boolean(settings[key])));
  setControlSelection('c-ai-options', [presetAiSkill(settings)]);
  // Presets leave special balls enabled; power-ups and field events scale with
  // difficulty and are shown here as the preset's read-only selection.
  setControlSelection('c-ball-options', Object.keys(BALL_TYPES).filter(key => key !== 'normal'));
  setControlSelection('c-powerup-options', Object.keys(POWERUP_TYPES).filter(key =>
    settings.powerups?.[key] || (key === 'mega' && !isCustom() && mode().mega)));
  setControlSelection('c-field-options', ['portals', 'well', 'wind'].filter(key => settings.events?.[key]));
}

bindOptions('difficulty-options', v => {
  state.difficulty = v;
  syncCustomControls();
});
bindOptions('c-paddle-options', v => { customSettings.paddle = v; buildCustomCfg(); });
bindOptions('c-ai-options', v => { customSettings.aiSkill = v; buildCustomCfg(); });
bindOptions('c-speed-options', v => { customSettings.speed = v; buildCustomCfg(); });
// curse buttons toggle independently (not radio-style)
byId('c-curse-options').querySelectorAll('.opt').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    customSettings[btn.dataset.value] = btn.classList.contains('selected');
    buildCustomCfg();
    netBroadcastSettings();
  });
});
// special ball & power-up allow-lists (independent toggles, default all on)
byId('c-ball-options').querySelectorAll('.opt').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    customSettings.balls[btn.dataset.value] = btn.classList.contains('selected');
    buildCustomCfg();
    netBroadcastSettings();
  });
});
byId('c-powerup-options').querySelectorAll('.opt').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    customSettings.powerups[btn.dataset.value] = btn.classList.contains('selected');
    buildCustomCfg();
    netBroadcastSettings();
  });
});
byId('c-field-options').querySelectorAll('.opt').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    customSettings[btn.dataset.value] = btn.classList.contains('selected');
    buildCustomCfg();
    netBroadcastSettings();
  });
});
bindOptions('time-options', v => { state.matchTime = parseInt(v, 10); });
// The menu starts on Normal, so immediately turn the always-visible Custom
// controls into that preset's disabled summary.
syncCustomControls();
const roomPanel = byId('room-panel');
const roomStatusEl = byId('room-status');
const roomCodeInput = byId('room-code-input');
const roomActions = byId('room-actions');
const roomJoinForm = byId('room-join-form');
const roomHostCode = byId('room-host-code');
const roomCodeDisplay = byId('room-code-display');
const roomLeave = byId('room-leave');
const leaveRoomBtn = byId('leave-room-btn');
const playTab = byId('tab-play');
const guestLockedGroups = ['opponent-options', 'time-options', 'mode-options', 'difficulty-options', ...CUSTOM_CONTROL_GROUPS];
function syncRoomUi() {
  const pvp = state.opponent === 'pvp';
  const guest = pvp && roomClient.role === 'guest';
  const host = pvp && roomClient.role === 'host';
  roomPanel.hidden = !pvp;
  roomActions.hidden = !pvp || roomClient.role !== null || roomJoinForm.hidden === false;
  roomJoinForm.hidden = !pvp || roomClient.role !== null || roomJoinForm.hidden;
  roomHostCode.hidden = !pvp || roomClient.role !== 'host';
  roomCodeDisplay.textContent = roomClient.code || '------';
  roomLeave.hidden = !pvp || !roomClient.role;
  leaveRoomBtn.textContent = host ? 'CLOSE ROOM' : 'LEAVE ROOM';
  playTab.classList.toggle('pvp-guest-locked', guest);
  guestLockedGroups.forEach(id => byId(id).querySelectorAll('.opt').forEach(btn => { btn.disabled = guest; }));
  const startBtn = byId('start-btn');
  startBtn.disabled = guest || (host && !roomClient.ready);
  startBtn.textContent = guest ? 'WAITING FOR HOST' : 'START MATCH';
}
function showRoomActions() {
  roomJoinForm.hidden = true;
  syncRoomUi();
}
window.addEventListener('pong-room-status', ({ detail }) => {
  roomStatusEl.textContent = detail.message;
  syncRoomUi();
  // The results overlay can be open when the room state changes, so keep its
  // button label honest too.
  syncRematchButton();
});
window.addEventListener('pong-room-ended', () => {
  const notice = roomStatusEl.textContent;
  if (state.mode !== 'menu') transitionTo('menu');
  showRoomActions();
  syncRoomUi();
  roomStatusEl.textContent = notice;
});
byId('create-room-btn').addEventListener('click', () => roomConnect('create'));
byId('show-join-room-btn').addEventListener('click', () => {
  roomActions.hidden = true;
  roomJoinForm.hidden = false;
  roomCodeInput.focus();
});
byId('room-back-btn').addEventListener('click', showRoomActions);
leaveRoomBtn.addEventListener('click', () => {
  // Closing the socket deletes the room server-side and frees the code.
  debugLog('game', `ROOM: ${roomClient.role === 'host' ? 'host closed room' : 'guest left room'}`);
  roomDisconnect();
  showRoomActions();
  roomStatusEl.textContent = 'CREATE OR JOIN A ROOM';
});
function submitJoinCode() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { roomStatusEl.textContent = 'ENTER A ROOM CODE'; return; }
  roomConnect('join', code);
}
byId('join-room-btn').addEventListener('click', submitJoinCode);
/* Enter submits the code. The join form is a plain div rather than a <form>,
   so there is no implicit submit to inherit - without this the key does
   nothing and the only way in is to click JOIN, which is not what anyone
   expects after typing a code. */
roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitJoinCode();
});
function refreshMenu() {
  const v = state.gameMode;
  // match time only matters for timed modes
  byId('time-group').style.display = MODES[v].timed ? '' : 'none';
  // Survival alone is restricted in AI-vs-AI: it needs a human on the right to own lives.
  const desc = {
    classic:  'Timed match - most points when time runs out wins',
    chaos:    'Timed match - 3+ balls, bumpers, ball rain, power-ups everywhere',
    survival: '3 lives, 2 balls from the start, and a new wave every 20s - more balls, bumpers, ever faster. Hearts heal… if the AI doesn\'t claim them first',
    endless:  'No clock, no winner - play a standard match for as long as you want. Quit when you are done.',
    ffa:      'Non-stop war - ball storms, moving bumpers, breathing walls, and the balls never stop coming',
  };
  let suffix = '';
  if (isAivai()) suffix = '  •  Two bots, fresh personalities each match - sit back and watch the fight';
  byId('mode-desc').textContent = desc[v] + suffix;

  // survival is the only opponent-restricted mode: it needs a human with
  // lives on the right, so it's hidden in AI-vs-AI
  const survBtn = document.querySelector('#mode-options .opt[data-value="survival"]');
  const hideSurvival = isAivai() || state.opponent === 'pvp';
  survBtn.style.display = hideSurvival ? 'none' : '';
  if (hideSurvival && v === 'survival') {
    state.gameMode = 'classic';
    document.querySelectorAll('#mode-options .opt').forEach(b =>
      b.classList.toggle('selected', b.dataset.value === 'classic'));
    refreshMenu();
    return;
  }
  // Ball Storm is mode-exclusive, so the read-only difficulty preview must
  // refresh whenever the selected game mode changes.
  syncCustomControls();
  syncColorPicker();
  syncRoomUi();
}

/* ---------- side color picker ---------- */
/* Swatches are built from the palette itself so adding a color to theme.js
   needs no matching markup here. */
function buildSwatches(groupId, side) {
  const group = byId(groupId);
  for (const entry of PALETTE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.value = entry.key;
    btn.style.setProperty('--sw', entry.hex);
    btn.setAttribute('role', 'radio');
    // The name carries the identity, and the button wears the color itself:
    // outlined normally, filled once selected. Naming it means the choice never
    // rests on hue alone.
    const label = document.createElement('span');
    label.className = 'swatch-name';
    label.textContent = entry.name;
    btn.append(label);
    btn.addEventListener('click', () => {
      setSideColor(side, entry.key);
      syncColorPicker();
    });
    group.appendChild(btn);
  }
}
buildSwatches('color-right-options', 'right');
buildSwatches('color-left-options', 'left');

function syncColorPicker() {
  for (const [groupId, side] of [['color-right-options', 'right'], ['color-left-options', 'left']]) {
    const other = side === 'right' ? 'left' : 'right';
    byId(groupId).querySelectorAll('.swatch').forEach(btn => {
      const key = btn.dataset.value;
      const isSelected = theme[side].key === key;
      const isTaken = theme[other].key === key;
      btn.classList.toggle('selected', isSelected);
      btn.classList.toggle('taken', isTaken);
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      // Disabled rather than swapping: the other side already owns this color.
      btn.disabled = isTaken;
      btn.title = isTaken ? `${paletteEntry(key).name} is used by the other side` : '';
    });
  }
  // Both sides are bots in AI vs AI, so "YOU" would be a lie; name the sides
  // by position instead.
  byId('color-you-label').textContent = isAivai() ? 'RIGHT' : 'YOU';
  byId('color-foe-label').textContent = isAivai() ? 'LEFT'
    : state.opponent === 'pvp' ? 'OPPONENT' : 'AI';
}
// menu tabs (PLAY / INFO)
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('selected'));
    tab.classList.add('selected');
    byId('tab-play').style.display = tab.dataset.tab === 'play' ? '' : 'none';
    byId('tab-info').style.display = tab.dataset.tab === 'info' ? '' : 'none';
  });
});

bindOptions('mode-options', v => { state.gameMode = v; refreshMenu(); });
bindOptions('opponent-options', v => {
  if (state.opponent === 'pvp' && v !== 'pvp') roomDisconnect();
  if (v === 'pvp' && state.opponent !== 'pvp') showRoomActions();
  state.opponent = v;
  refreshMenu();
});
refreshMenu();

/* Build id in the menu footer.

   The web image rewrites the data-commit attribute at build time. Running from
   source the attribute is still the literal placeholder, so the markup's "DEV"
   fallback is left in place rather than showing the placeholder to the player. */
(function showBuildId() {
  const el = byId('build-id');
  if (!el) return;
  const commit = el.dataset.commit;
  if (!commit || commit.startsWith('__')) return;
  el.textContent = commit;
  el.title = `build ${commit}`;
})();

function resetToMenu() {
  // In PvP these already hold the host's synced settings, so they must survive
  // the reset rather than being replaced by this client's own defaults.
  const preferences = {
    gameMode: state.gameMode, opponent: state.opponent, difficulty: state.difficulty,
    matchTime: state.matchTime, muted: state.muted,
  };
  Object.assign(state, initialState, preferences, {
    mode: 'menu', scores: { player: 0, ai: 0 }, bumpers: [],
  });
  [player, ai, ghostL, ghostR].forEach((p, i) => {
    for (const key of Object.keys(p)) delete p[key];
    Object.assign(p, initialPaddles[i]);
  });
  balls = [];
  particles.length = powerups.length = popups.length = ripples.length = 0;
  scorePop.player = scorePop.ai = timerPop = countdownTimer = 0;
  /* Keep the aim through a PvP transition. The pointer has not actually moved,
     and clearing it would leave the paddle motionless until the player jiggled
     the mouse. mouseY is used rather than mouseCY because it stays valid even
     when the cursor is outside the arena. */
  const keepAim = state.opponent === 'pvp' && mouseY !== null;
  if (!keepAim) mouseY = null;
  mouseCX = mouseCY = -1;
  hoveredBadge = null;
  for (const key of Object.keys(keys)) delete keys[key];
  byId('spawn-status').textContent = 'Pick something to add to the match.';
  refreshMenu();
  show('menu');
}

let transitioning = false;
function transitionTo(destination) {
  if (transitioning) return;
  transitioning = true;
  state.mode = 'loading';
  // Fade over the current screen before changing anything underneath it.
  const loader = byId('loading');
  loader.style.transition = 'none';
  loader.style.opacity = '0';
  loader.style.display = 'flex';
  void loader.offsetWidth; // commit the transparent starting frame
  loader.style.transition = 'opacity 250ms ease-in-out';
  loader.style.opacity = '1';
  setTimeout(() => {
    resetToMenu();
    if (destination === 'match') show(null);
    // Only prepare a clean field here. Starting a match also serves balls and
    // plays audio, so defer that entirely until the loader has disappeared.
    syncSpectatorPanel();
    state.mode = 'loading';
    setTimeout(() => {
      loader.style.opacity = '0';
      setTimeout(() => {
        loader.style.display = 'none';
        transitioning = false;
        if (destination === 'match') {
          countdownTimer = 0;
          startMatch();
          // Local state is now stable, so authoritative snapshots may be
          // applied again. Until this point they would have been overwritten by
          // the reset above, leaving the paddle fighting the server.
          if (typeof netResume === 'function') netResume();
        } else {
          state.mode = 'menu';
        }
        syncSpectatorPanel();
        lastTime = performance.now();
      }, 250);
    }, 400);
  }, 250);
}
window.addEventListener('pong-room-start', () => {
  if (state.opponent !== 'pvp') return;
  // A host can requeue while the guest is still on the results overlay. Treat
  // `over` like the menu and rebuild the field on both clients; otherwise the
  // guest keeps stale balls/overlays and the next snapshots corrupt the match.
  if (state.mode === 'menu' || state.mode === 'over') transitionTo('match');
});
byId('start-btn').addEventListener('click', () => {
  sfx.click();
  if (state.opponent === 'pvp') { roomStart(); return; }
  transitionTo('match');
});
byId('rematch-btn').addEventListener('click', () => {
  // In PvP only the host may requeue, and both clients restart together. The
  // button is disabled for a guest, so this is a guard rather than the primary
  // mechanism. Without it a stray click would play a confirmation sound for an
  // action that never happens.
  if (state.opponent === 'pvp') {
    if (roomClient.role !== 'host') return;
    sfx.click();
    roomStart();
    return;
  }
  sfx.click();
  transitionTo('match');
});
byId('menu-btn').addEventListener('click', () => { sfx.click(); transitionTo('menu'); });
byId('resume-btn').addEventListener('click', () => { sfx.click(); resume(); });
byId('quit-btn').addEventListener('click', () => {
  sfx.click();
  // Leaving mid-match must free the room so the other player isn't stranded.
  if (state.opponent === 'pvp') roomDisconnect();
  transitionTo('menu');
  if (state.opponent === 'pvp') { showRoomActions(); roomStatusEl.textContent = 'CREATE OR JOIN A ROOM'; }
});

function pause() {
  // In PvP the match must keep running for the other player, so the menu is
  // shown as an overlay only - the simulation is never actually paused.
  if (isPvp()) {
    if (state.mode === 'play' || state.mode === 'countdown') {
      byId('pause-title').textContent = 'MATCH IN PROGRESS';
      show('pause');
      /* A key held down as the menu opens must not carry its momentum into the
         overlay. keyup still clears keys, so this only covers the instant
         before the player lets go - but that is exactly the case where the
         paddle would visibly drift under the menu. */
      for (const k of ['w', 's', 'arrowup', 'arrowdown']) keys[k] = false;
      player.vy = player.smoothVy = 0;
    }
    return;
  }
  if (state.mode === 'play' || state.mode === 'countdown') {
    state.prePause = state.mode;
    state.mode = 'pause';
    byId('pause-title').textContent = 'PAUSED';
    show('pause');
  }
}
function resume() {
  // PvP never entered a paused state; just close the overlay.
  if (isPvp()) { show(null); return; }
  if (state.mode === 'pause') {
    state.mode = state.prePause || 'play';
    show(null);
  }
}

// Create/unlock the AudioContext on the first interaction anywhere, so samples
// are decoded and ready before the first sound the game actually plays.
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => ensureAudioCtx(), { once: true });
}

/* True while the user is typing into a field, so game shortcuts stay out of
   the way. Without this, entering a room code containing "M" silently toggles
   mute and a "P" opens the pause overlay mid-word - and every keystroke is
   additionally latched into `keys`, which is what the paddle reads. */
function typingInField(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
         target.isContentEditable === true;
}

window.addEventListener('keydown', (e) => {
  if (typingInField(e.target)) return;
  const k = e.key.toLowerCase();
  /* Movement keys are latched into `keys`, which the paddle and the held-ball
     aim both read. The PvP pause menu keeps state.mode at 'play', so without
     this W/S would still steer from behind the overlay. P/ESCAPE stay live -
     they are what closes the menu. */
  if (!netMenuOpen() || k === 'p' || k === 'escape') keys[k] = true;
  if (k === 'arrowup' || k === 'arrowdown') e.preventDefault();
  if (k === 'p' || k === 'escape') {
    // PvP never sets 'pause' mode, so toggle on the overlay's visibility.
    if (state.mode === 'pause' || overlays.pause.classList.contains('visible')) resume();
    else pause();
  }
  if (k === 'm') state.muted = !state.muted;

});

// P1's left-click action: smash or release a held charged ball.
// Returns true if it released a held ball.
function playerAction() {
  const held = balls.find(b => b.heldBy === 'player');
  if (held) { releaseBall(held); return true; }
  if (state.chargeWindow > 0) {
    player.catchT = CATCH_WINDOW;
    player.smashT = 0;
    return false;
  }
  if (player.smashCD <= 0 && player.smashT <= 0) {
    player.smashT = SMASH_WINDOW;
    beep(520, 0.05, 'square', 0.1);
  }
  return false;
}

// Left click smashes/releases a held charged ball.
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || state.mode !== 'play' || isAivai()) return;
  // The PvP pause overlay leaves state.mode as 'play', so it has to be checked
  // explicitly or a click landing on the arena still fires a smash.
  if (netMenuOpen()) return;
  // Neither client simulates, so the click is sent as a discrete action. The
  // server queues it and applies it exactly once, which is what makes smash
  // reliable for both players.
  if (isNetGuest()) {
    // Smash timing is too short to wait for the frame-loop input relay, and
    // netSendInput always flushes a queued action immediately.
    net.action = true;
    netSendInput(0);
    return;
  }
  playerAction();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

/* Paddle aiming is tracked on the WINDOW, not the canvas.

   Canvas mouse events stop at its edge, so a pointer that leaves the arena
   would freeze the paddle at its last inside-the-arena position until the
   pointer came back. Overshooting vertically while chasing a fast ball is easy,
   and a frozen paddle reads as a locked-up game.

   Listening on the window keeps the paddle following the cursor's height even
   while the pointer is outside the arena. The value is clamped, so the paddle
   sits at the top or bottom rather than aiming somewhere unreachable. */
window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  if (!rect.height || !rect.width) return;
  mouseY = clamp(((e.clientY - rect.top) / rect.height) * H, 0, H);

  /* The in-canvas cursor position is a separate concern: it drives badge hover
     and held-ball aiming, both of which are meaningless once the pointer is off
     the arena. Those stay canvas-only and reset to -1 outside it. */
  const insideX = e.clientX >= rect.left && e.clientX <= rect.right;
  const insideY = e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (insideX && insideY) {
    const screenX = ((e.clientX - rect.left) / rect.width) * W;
    mouseCX = state.flipped && state.mode !== 'menu' ? W - screenX : screenX;
    mouseCY = ((e.clientY - rect.top) / rect.height) * H;
  } else {
    mouseCX = mouseCY = -1;
  }

  // Nudge the sender so aim goes out as soon as its rate-limit slot opens.
  // Sending on every mouse event instead would flood the replay buffer with
  // more inputs than the server has ticks to consume.
  if (isNetGuest() && state.mode === 'play') netSendInput(0);
});

// touch support
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  mouseY = ((e.touches[0].clientY - rect.top) / rect.height) * H;
  if (isNetGuest() && state.mode === 'play') netSendInput(0);
}, { passive: false });

window.addEventListener('blur', () => {
  if (!isAivai()) pause();
});

/* ============================================================
   Loading screen - waits for the pixel font (the slow asset),
   with a progress feel and a hard timeout so it can never hang
   ============================================================ */
{
  const loadingEl = byId('loading');
  const shownAt = performance.now();
  const MIN_SHOW = 2000; // style demands a proper moment on screen
  let done = false;


  // -- tiny self-playing pong rally as the loading animation --
  const lc = byId('loading-anim');
  const lctx = lc.getContext('2d');
  const LW = lc.width, LH = lc.height;
  const lball = { x: LW / 2, y: LH / 2, vx: 190, vy: 70 };
  const lpad = { l: LH / 2, r: LH / 2 };
  const PADW = 5, PADH = 26, PR = 4;
  let lLast = performance.now();

  function loadingTick(now) {
    if (loadingEl.style.display === 'none') {
      lLast = now;
      requestAnimationFrame(loadingTick);
      return;
    }
    const dt = Math.min((now - lLast) / 1000, 1 / 30);
    lLast = now;

    lball.x += lball.vx * dt;
    lball.y += lball.vy * dt;
    if (lball.y < PR) { lball.y = PR; lball.vy = Math.abs(lball.vy); }
    if (lball.y > LH - PR) { lball.y = LH - PR; lball.vy = -Math.abs(lball.vy); }
    // perfect little paddles - they always make it (it's a loading screen,
    // nobody loses here)
    if (lball.x < PADW + PR && lball.vx < 0) {
      lball.x = PADW + PR;
      lball.vx = Math.abs(lball.vx) * 1.02;
      lball.vy += (Math.random() - 0.5) * 60;
    }
    if (lball.x > LW - PADW - PR && lball.vx > 0) {
      lball.x = LW - PADW - PR;
      lball.vx = -Math.abs(lball.vx) * 1.02;
      lball.vy += (Math.random() - 0.5) * 60;
    }
    lball.vx = Math.max(-420, Math.min(420, lball.vx));
    lball.vy = Math.max(-200, Math.min(200, lball.vy));
    // only the paddle the ball is heading toward chases it;
    // the other relaxes back to center - no synchronized mirroring
    if (lball.vx < 0) {
      lpad.l += (lball.y - lpad.l) * Math.min(1, 10 * dt);
      lpad.r += (LH / 2 - lpad.r) * Math.min(1, 3 * dt);
    } else {
      lpad.r += (lball.y - lpad.r) * Math.min(1, 10 * dt);
      lpad.l += (LH / 2 - lpad.l) * Math.min(1, 3 * dt);
    }

    lctx.clearRect(0, 0, LW, LH);
    // single flat color, hard pixel edges - no glow, no curves
    lctx.fillStyle = theme.right.base;
    lctx.fillRect(0, lpad.l - PADH / 2, PADW, PADH);
    lctx.fillRect(LW - PADW, lpad.r - PADH / 2, PADW, PADH);
    lctx.beginPath();
    lctx.arc(lball.x, lball.y, PR, 0, Math.PI * 2);
    lctx.fill();

    requestAnimationFrame(loadingTick);
  }
  requestAnimationFrame(loadingTick);

  function finish() {
    if (done) return;
    done = true;
    // hold so the screen always shows for at least MIN_SHOW total
    const wait = Math.max(0, MIN_SHOW - (performance.now() - shownAt));
    setTimeout(() => {
      loadingEl.style.transition = 'opacity .35s';
      loadingEl.style.opacity = '0';
      setTimeout(() => { loadingEl.style.display = 'none'; }, 380);
    }, wait);
  }

  // the pixel font is the only real remote asset - wait for it (max 4s)
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('12px "Press Start 2P"'),
      new Promise(res => window.addEventListener('load', res, { once: true })),
    ]).then(finish);
  } else {
    window.addEventListener('load', finish, { once: true });
  }
  setTimeout(finish, 4000); // never hang on a bad connection
}
