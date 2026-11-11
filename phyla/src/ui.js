// DOM helpers, the shared line-icon set, and the look-up tables that give
// every ability one name, one colour and one glyph across the whole game.

export const ICONS = {
  trill: 'M9 18V5l10-2v13 M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  sway: 'M3 9c3-4 6-4 9 0s6 4 9 0 M3 16c3-4 6-4 9 0s6 4 9 0',
  flare: 'M12 20V9 M12 20L5.5 9 M12 20l6.5-11 M12 20L3 15 M12 20l9-5 M4 7.5a9.5 9.5 0 0 1 16 0',
  glow: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2',
  bite: 'M4 7c3-2 13-2 16 0l-2 5-2.5-3L13 13l-1-3-1 3-2.5-4L6 12z M5 16.5c3 2 11 2 14 0',
  ram: 'M4 19c0-9 4-14 10-14 4 0 6 3 6 6s-2 5-5 5-4-2-4-4 1-3 3-3',
  swipe: 'M5 20c1-6 3-11 6-16 M10 20c1-6 3-11 6-16 M15 20c1-5 2-9 5-13',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.500-7 10-7 10z',
  speed: 'M3 16h8 M2 12h7 M5 8h5 M14 6l6 6-6 6',
  armor: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  sight: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  sense: 'M12 20v-8 M12 12C12 7 9 5 5 4 M12 12c0-5 3-7 7-8',
  herb: 'M5 19C5 10 10 5 19 5c0 9-5 14-14 14z M5 19l9-9',
  carn: 'M8 16a5.500 5.500 0 1 1 5-9l4 4 M14.500 14.500l3 3a1.500 1.500 0 1 0 2-2 1.500 1.500 0 1 0-2-2l-3-3',
  helix: 'M7 3c0 5 10 4 10 9s-10 4-10 9 M17 3c0 5-10 4-10 9s10 4 10 9 M8.500 6h7 M8.500 18h7 M9.500 12h5',
  nest: 'M3 13h18c-1 4-4 6-9 6s-8-2-9-6z M8 13c0-2.500 1-4 2.500-4S13 10.500 13 13 M12.500 12c0.200-1.700 1-2.700 2.200-2.700S17 11 17 13',
  jump: 'M12 20V7 M6 12l6-6 6 6',
  glide: 'M3 14c4-8 10-9 18-8-2 2-3 3-3 5-3-1-5 0-6 2-2-1-5-1-9 1z',
  eat: 'M6 3v7a3 3 0 0 0 6 0V3 M9 3v18 M17 3c-2 2-3 5-3 8h3v10',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2',
  close: 'M6 6l12 12 M18 6L6 18',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  bone: 'M7 7a2 2 0 1 0-3 2 2 2 0 1 0 2 3l8 8a2 2 0 1 0 3-2 2 2 0 1 0-2-3z',
  moon: 'M19 14a8 8 0 1 1-9-10 6.500 6.500 0 0 0 9 10z',
  sun: 'M12 7.500a4.500 4.500 0 1 0 0 9 4.500 4.500 0 0 0 0-9z M12 2v2.500 M12 19.500V22 M2 12h2.500 M19.500 12H22',
  sound: 'M4 10v4h4l5 4V6L8 10z M16 9a4 4 0 0 1 0 6 M18.500 6.500a8 8 0 0 1 0 11',
  mute: 'M4 10v4h4l5 4V6L8 10z M16 9l5 6 M21 9l-5 6',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h11',
  pause: 'M8 5v14 M16 5v14',
};

export function icon(name, size = 18, extra = '') {
  return `<svg class="ic ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;
}

// The four social "voices" and three ways to fight.
export const SOCIAL = [
  { id: 'trill', name: 'Trill', color: '#e0a23a', key: '1', verb: 'sing' },
  { id: 'sway', name: 'Sway', color: '#6fae5a', key: '2', verb: 'dance' },
  { id: 'flare', name: 'Flare', color: '#d9654a', key: '3', verb: 'display' },
  { id: 'glow', name: 'Glow', color: '#4fb3c8', key: '4', verb: 'shine' },
];
export const FIERCE = [
  { id: 'bite', name: 'Bite', color: '#c2603f', key: '1' },
  { id: 'ram', name: 'Ram', color: '#a8743a', key: '2' },
  { id: 'swipe', name: 'Swipe', color: '#8d5a7a', key: '3' },
];
export const DIET = {
  herb: { name: 'Herbivore', icon: 'herb', note: 'eats berries and fruit' },
  carn: { name: 'Carnivore', icon: 'carn', note: 'eats meat' },
  omni: { name: 'Omnivore', icon: 'eat', note: 'eats anything' },
  none: { name: 'No mouth', icon: 'close', note: 'cannot eat' },
};

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Five-pip meter used for ability levels.
export function pips(n, color, max = 5) {
  let s = '<span class="pips">';
  for (let i = 0; i < max; i++) s += `<i class="${i < n ? 'on' : ''}" style="${i < n ? `background:${color}` : ''}"></i>`;
  return s + '</span>';
}

let toastHost = null;
export function toast(msg, kind = '', ms = 3200) {
  if (!toastHost) {
    toastHost = el('<div class="toasts" aria-live="polite"></div>');
    document.body.appendChild(toastHost);
  }
  const t = el(`<div class="toast ${kind}">${msg}</div>`);
  toastHost.appendChild(t);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 450);
}

// Simple modal card. Returns { root, close }.
export function modal(html, opts = {}) {
  const root = el(`<div class="modal"><div class="modal__card ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`);
  document.body.appendChild(root);
  const close = () => {
    root.remove();
    if (opts.onClose) opts.onClose();
  };
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root && opts.dismiss !== false) close();
  });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { root, close };
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
