export const SHARED_POSITION_MIN_INTERVAL_MS = 5_000;
export const SHARED_POSITION_MIN_MOVEMENT_M = 15;

export interface SentPosition {
  lat: number;
  lng: number;
  sentAt: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance is sufficient for the short device movements this
 * gate measures, and avoids tying sharing behavior to the map renderer. */
export function positionDistanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A device update must clear both gates: no more than one write per five
 * seconds, and no write until the person moved at least fifteen metres. */
export function shouldSendSharedPosition(
  previous: SentPosition | null,
  next: { lat: number; lng: number },
  now: number,
): boolean {
  if (!previous) return true;
  return (
    now - previous.sentAt >= SHARED_POSITION_MIN_INTERVAL_MS &&
    positionDistanceMetres(previous, next) >= SHARED_POSITION_MIN_MOVEMENT_M
  );
}
