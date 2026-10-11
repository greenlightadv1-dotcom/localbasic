export type Coordinates = { latitude: number; longitude: number };

/**
 * One best-effort read of the browser's location. Never rejects — permission
 * denial, a timeout, or a browser with no geolocation API all resolve to
 * `null`, so a caller never needs a try/catch just to place an order.
 */
export function getBrowserLocation(timeoutMs = 8000): Promise<Coordinates | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
