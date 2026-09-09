'use strict';

/* ============================================================
   Theme: side colors

   Every side-owned visual (paddle, goal zone, score, sparks,
   ripples, ghost helper) reads its color from here instead of
   hardcoding a hex. One place to change, and the arena and the
   menu can never drift out of sync.

   The palette is deliberately flat and slightly desaturated so it
   sits on the dark arena without vibrating against it. Every entry
   is legible on that background at paddle size.

   Colors are a LOCAL cosmetic preference. They are never sent
   over the network: in PvP each player always sees themselves on
   the right, so a shared palette would fight that and force one
   player to watch someone else's choice.
   ============================================================ */

const PALETTE = [
  { key: 'bone',   name: 'BONE',   hex: '#e6e0d1' },
  { key: 'ember',  name: 'EMBER',  hex: '#e2603f' },
  { key: 'amber',  name: 'AMBER',  hex: '#e0a33e' },
  { key: 'moss',   name: 'MOSS',   hex: '#8aa84f' },
  { key: 'teal',   name: 'TEAL',   hex: '#3fa294' },
  { key: 'slate',  name: 'SLATE',  hex: '#6f8fb0' },
  { key: 'violet', name: 'VIOLET', hex: '#8f76c8' },
  { key: 'rose',   name: 'ROSE',   hex: '#d2647f' },
];

const paletteEntry = (key) => PALETTE.find(c => c.key === key) || PALETTE[0];

/* ---------- color maths ---------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
// Blend a color toward white. Deriving the lighter tints instead of listing
// them means a new palette entry only needs its one base color, and its
// highlight and ghost shades follow automatically.
function mixWhite(hex, t) {
  const [r, g, b] = hexToRgb(hex);
  const m = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/* One side's full color set, derived from a single palette entry. */
function makeSide(key) {
  const entry = paletteEntry(key);
  const [r, g, b] = hexToRgb(entry.hex);
  return {
    key: entry.key,
    name: entry.name,
    base: entry.hex,
    bright: mixWhite(entry.hex, 0.55), // paddle hit flash
    ghost: mixWhite(entry.hex, 0.35),  // ghost helper paddle
    rgba: (a) => `rgba(${r}, ${g}, ${b}, ${a})`,
  };
}

const THEME_STORE_KEY = 'pongetitive.colors';
const DEFAULT_COLORS = { right: 'teal', left: 'ember' };

// `left` is the opponent's side, `right` is always yours, matching the
// convention the rest of the game uses for scores and paddles.
const theme = {
  left: makeSide(DEFAULT_COLORS.left),
  right: makeSide(DEFAULT_COLORS.right),
};

/* Storage can throw outright (private mode, file:// in some browsers), and a
   cosmetic preference must never take the game down with it. */
function loadColors() {
  try {
    const raw = localStorage.getItem(THEME_STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Validate against the live palette: a stale or hand-edited key must fall
    // back to the default rather than produce an undefined color.
    if (saved && typeof saved.right === 'string' && typeof saved.left === 'string') {
      const right = paletteEntry(saved.right).key;
      const left = paletteEntry(saved.left).key;
      // Both keys are applied together, or neither is. Two unknown keys would
      // both resolve to the same fallback entry, and loading that would leave
      // the sides sharing one color with no way to fix it in the picker.
      if (right !== left) {
        theme.right = makeSide(right);
        theme.left = makeSide(left);
      }
    }
  } catch { /* keep defaults */ }
}
function saveColors() {
  try {
    localStorage.setItem(THEME_STORE_KEY, JSON.stringify({
      right: theme.right.key,
      left: theme.left.key,
    }));
  } catch { /* preference simply will not persist */ }
}

/* Set one side's color.

   The two sides must never share a color, or the paddles stop being tellable
   apart mid-rally. The color the other side owns is therefore rejected here
   and disabled in the picker, so the rule is visible before the click rather
   than enforced by a surprise swap afterwards.

   Returns whether the change was applied. */
function setSideColor(side, key, persist = true) {
  const other = side === 'right' ? 'left' : 'right';
  if (theme[other].key === key) return false;
  theme[side] = makeSide(key);
  applyThemeCss();
  if (persist) saveColors();
  return true;
}

/* Push the side colors into CSS so the menu, buttons and overlays follow the
   same palette as the arena without duplicating any values in the stylesheet. */
function applyThemeCss() {
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.right.base);
  root.setProperty('--accent2', theme.left.base);
}

loadColors();
applyThemeCss();
