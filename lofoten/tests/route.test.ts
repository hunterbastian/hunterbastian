import { describe, expect, it } from 'vitest';
import { Autopilot } from '../src/player/autopilot';
import { Player, PLAYER } from '../src/player/player';
import { SHORE_MIN } from '../src/player/walkworld';
import { terrainHeight } from '../src/world/heightfield';
import { BRIDGE, CABINS, ROUTE_WAYPOINTS, SPAWN, VIEW_DECK, ZoneId, porchOf } from '../src/world/layout';
import { buildWalkWorld } from '../src/world/walkables';
import { zoneAt } from '../src/world/zones';

const world = buildWalkWorld();
const DT = 1 / 60;

function hold(p: Player, seconds: number, input: { forward?: number; strafe?: number; run?: boolean }) {
  for (let t = 0; t < seconds; t += DT) p.update(DT, { forward: 0, strafe: 0, run: false, ...input });
}

describe('walking route', () => {
  it('walks porch → waterfront → bridge → overlook without getting stuck', () => {
    const p = new Player(world, SPAWN.x, SPAWN.z, SPAWN.yaw);
    expect(p.surface).toBe('porch');
    const pilot = new Autopilot(ROUTE_WAYPOINTS);
    const visited: ZoneId[] = [];
    let time = 0;
    let minClearance = Infinity;
    while (!pilot.done && time < 400) {
      p.update(DT, pilot.step(p, DT));
      time += DT;
      expect(pilot.stuckTime, `stuck near waypoint ${pilot.index} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBeLessThan(3);
      const zone = zoneAt(p.x, p.z, p.surface);
      if (zone && visited[visited.length - 1] !== zone) visited.push(zone);
      if (p.surface === 'terrain') minClearance = Math.min(minClearance, p.feetY - SHORE_MIN);
    }
    expect(pilot.done).toBe(true);
    expect(visited).toEqual(['porch', 'waterfront', 'bridge', 'overlook']);
    expect(minClearance).toBeGreaterThanOrEqual(0);
    // Roughly a two-minute stroll (plus/minus).
    console.log(`route walked in ${time.toFixed(1)}s, ending at y=${p.feetY.toFixed(2)}`);
    expect(time).toBeGreaterThan(70);
    expect(time).toBeLessThan(160);
    expect(p.feetY).toBeGreaterThan(8);
  });
});

describe('boundaries', () => {
  it('the bridge is solid: you cannot step off the side', () => {
    const p = new Player(world, 8, -12, Math.PI / 2);
    const y0 = p.feetY;
    expect(p.surface).toBe('bridge');
    hold(p, 3, { strafe: 1 });
    expect(p.surface).toBe('bridge');
    expect(Math.abs(p.z - BRIDGE.start.z)).toBeLessThan(BRIDGE.width / 2);
    hold(p, 3, { strafe: -1 });
    expect(p.surface).toBe('bridge');
    expect(p.feetY).toBeCloseTo(y0, 0);
  });

  it('the waterfront edge keeps you out of the sea', () => {
    const p = new Player(world, -75, -21, 0); // facing north, water ahead
    hold(p, 4, { forward: 1 });
    expect(p.surface).toBe('waterfront');
    expect(p.z).toBeGreaterThan(-22.4);
  });

  it('the shoreline is a boundary', () => {
    // Walk north-east from the village slope toward open water.
    const p = new Player(world, -20, 5, 0);
    expect(p.surface).toBe('terrain');
    hold(p, 12, { forward: 1 });
    expect(terrainHeight(p.x, p.z)).toBeGreaterThanOrEqual(SHORE_MIN);
    hold(p, 6, { forward: 1, strafe: 1 });
    expect(terrainHeight(p.x, p.z)).toBeGreaterThanOrEqual(SHORE_MIN);
  });

  it('cabins block you', () => {
    const c = CABINS[1];
    const porch = porchOf(c);
    const p = new Player(world, c.x, porch.cz, Math.PI); // facing south, into the cabin
    hold(p, 3, { forward: 1 });
    expect(p.z).toBeLessThan(c.z - c.d / 2 - PLAYER.radius + 0.05);
    expect(p.surface).toBe('porch');
  });

  it('stair spurs connect the boardwalk and the village both ways', () => {
    const p = new Player(world, -91, -21, Math.PI); // on the boardwalk, facing south
    hold(p, 7, { forward: 1 });
    expect(p.surface).toBe('terrain');
    expect(p.z).toBeGreaterThan(-6);
    p.yaw = 0; // back north, up the spur
    hold(p, 7, { forward: 1 });
    expect(p.surface).toBe('waterfront');
    expect(p.z).toBeLessThan(-19);
  });

  it('the overlook railing stops you at the cliff', () => {
    const p = new Player(world, VIEW_DECK.cx, VIEW_DECK.cz + 1, 0);
    expect(p.surface).toBe('overlook');
    hold(p, 4, { forward: 1 });
    expect(p.surface).toBe('overlook');
    expect(p.z).toBeGreaterThan(VIEW_DECK.cz - VIEW_DECK.hd);
  });
});
