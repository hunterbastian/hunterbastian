import { OVERLOOK, ZoneId } from './layout';

/** Which route zone a position/surface belongs to (null = in between). */
export function zoneAt(x: number, z: number, surface: string): ZoneId | null {
  if (surface === 'porch') return 'porch';
  if (surface === 'waterfront') return 'waterfront';
  if (surface === 'bridge') return 'bridge';
  if (surface === 'overlook' || Math.hypot(x - OVERLOOK.x, z - OVERLOOK.z) < OVERLOOK.radius + 1) return 'overlook';
  return null;
}
