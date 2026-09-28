// Builds the collision/walkable world from the layout. This is what makes
// the bridge solid, the cabins block you, and the shoreline a boundary.

import { WalkWorld } from '../player/walkworld';
import { cabinFloors, overlookHeight } from './heightfield';
import {
  BOARDWALK,
  BOARDWALK_WIDTH,
  BRIDGE,
  CABINS,
  SPURS,
  SPUR_WIDTH,
  VIEW_DECK,
  bridgePoints,
  porchOf,
} from './layout';
import { BENCH, BOULDERS, LAMPS, RACKS } from './scatter';

export const VIEW_DECK_Y = () => overlookHeight() + 0.12;

export function buildWalkWorld() {
  const w = new WalkWorld();

  // Walkways.
  w.addDeck({ kind: 'path', tag: 'waterfront', points: BOARDWALK, halfWidth: BOARDWALK_WIDTH / 2 });
  for (const s of SPURS) w.addDeck({ kind: 'path', tag: 'waterfront', points: s, halfWidth: SPUR_WIDTH / 2 });
  const bridge = bridgePoints();
  w.addDeck({ kind: 'path', tag: 'bridge', points: bridge, halfWidth: BRIDGE.width / 2 });
  // Landing where the boardwalk meets the bridge (fills the angled joint).
  w.addDeck({ kind: 'pad', tag: 'waterfront', cx: BRIDGE.start.x - 0.6, cz: BRIDGE.start.z, hw: 1.3, hd: 1.3, rot: 0, y: BRIDGE.baseY });

  // Bridge railings: one thin box per arch segment on each side.
  for (let i = 0; i < bridge.length - 1; i++) {
    const a = bridge[i];
    const b = bridge[i + 1];
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const rot = -Math.atan2(b.z - a.z, b.x - a.x);
    const y = Math.min(a.y, b.y);
    for (const side of [-1, 1]) {
      w.addCollider({
        kind: 'box',
        cx,
        cz: cz + side * (BRIDGE.width / 2 + 0.08),
        hw: len / 2 + 0.05,
        hd: 0.08,
        rot,
        yMin: y - 0.3,
        yMax: y + 1.2,
      });
    }
  }

  // Cabins + porches.
  CABINS.forEach((c, i) => {
    w.addCollider({ kind: 'box', cx: c.x, cz: c.z, hw: c.w / 2, hd: c.d / 2, rot: c.rot, yMin: -20, yMax: 60 });
    if (c.porch) {
      const p = porchOf(c);
      w.addDeck({ kind: 'pad', tag: 'porch', ...p, y: cabinFloors[i] - 0.1 });
      // Side railings on the porch (east + west), open to the boardwalk.
      for (const side of [-1, 1]) {
        w.addCollider({
          kind: 'box',
          cx: p.cx + side * (p.hw + 0.06),
          cz: p.cz + 0.35,
          hw: 0.06,
          hd: p.hd - 0.35,
          rot: c.rot,
          yMin: p.y - 0.3,
          yMax: p.y + 1.1,
        });
      }
    }
  });

  // Overlook viewing deck with a railing on its three open sides.
  const vy = VIEW_DECK_Y();
  w.addDeck({ kind: 'pad', tag: 'overlook', ...VIEW_DECK, y: vy });
  const rail = { kind: 'box' as const, rot: 0, yMin: vy - 0.3, yMax: vy + 1.1 };
  w.addCollider({ ...rail, cx: VIEW_DECK.cx, cz: VIEW_DECK.cz - VIEW_DECK.hd - 0.05, hw: VIEW_DECK.hw + 0.1, hd: 0.07 });
  for (const side of [-1, 1]) {
    w.addCollider({ ...rail, cx: VIEW_DECK.cx + side * (VIEW_DECK.hw + 0.05), cz: VIEW_DECK.cz - 0.4, hw: 0.07, hd: VIEW_DECK.hd - 0.4 });
  }

  // Props.
  for (const b of BOULDERS) {
    if (b.r < 0.55) continue;
    w.addCollider({ kind: 'circle', x: b.x, z: b.z, r: b.r * 0.8, yMin: b.y - 5, yMax: b.y + b.r * b.squash * 1.6 });
  }
  for (const l of LAMPS) {
    if (l.kind === 'bridge') continue; // part of the railing already
    w.addCollider({ kind: 'circle', x: l.x, z: l.z, r: l.kind === 'stake' ? 0.12 : 0.18, yMin: l.y - 2, yMax: l.y + l.height });
  }
  for (const r of RACKS) {
    w.addCollider({ kind: 'box', cx: r.x, cz: r.z, hw: r.len / 2 + 0.2, hd: 0.9, rot: r.rot, yMin: r.y - 2, yMax: r.y + 4 });
  }
  w.addCollider({ kind: 'box', cx: BENCH.x, cz: BENCH.z, hw: 1.0, hd: 0.3, rot: BENCH.rot, yMin: BENCH.y - 1, yMax: BENCH.y + 0.9 });

  return w;
}
