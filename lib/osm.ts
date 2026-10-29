import type { StreetContext } from './types';

/**
 * Reverse geocode through OpenStreetMap's Overpass API.
 *
 * Purpose is NOT to replace the camera's GPS - it exists to independently
 * check what Muse Spark read off the street signs. OCR of a road sign at speed
 * is exactly the kind of task a model confidently gets wrong ("W 5th St"
 * versus "E 5th St"), and a work order filed against the wrong street is a
 * wasted crew. When the two disagree we flag for review rather than trusting
 * either.
 *
 * Free, no API key, no account.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Nominatim answers when Overpass is at capacity, so the cross-check has a second net. */
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Both OSM endpoints reject requests with no User-Agent - Overpass answers 406
 * through nginx - and Node's fetch sends none by default. Every lookup failed
 * silently before this header existed: street names came back null on live
 * runs even though the same query typed into curl worked.
 */
const HEADERS = { 'User-Agent': 'StreetScan/0.1 (open-source civic hazard audit)' };

/**
 * Overpass asks for backoff on 429/502; two capped attempts keeps a busy
 * mirror from stalling a whole classification pass (measured 30-47s per
 * lookup when the timeout was absent).
 */
async function post(url: string, body: string, tries = 2): Promise<Response | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        // A busy Overpass can sit on a request for half a minute; a classification
        // pass would stall for minutes without a hard per-attempt ceiling.
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return res;
    } catch {
      /* retry */
    }
  }
  return null;
}

export type OsmResult = {
  street: string | null;
  /** free-form road classification, useful for a sanity check */
  highway: string | null;
  ok: boolean;
};

function query(lat: number, lon: number, radiusM: number): string {
  return (
    '[out:json][timeout:10];' +
    `way(around:${radiusM},${lat.toFixed(7)},${lon.toFixed(7)})["highway"]["name"];` +
    'out tags 3;'
  );
}

export async function reverseGeocode(lat: number, lon: number): Promise<OsmResult> {
  const fail: OsmResult = { street: null, highway: null, ok: false };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail;

  try {
    // Nominatim first: same OpenStreetMap database, answers in ~100ms, and it
    // takes GET. Overpass mirrors were serving 30s+ responses tonight, so
    // leading with them tripped the 8s ceiling on every lookup and left every
    // street blank. It stays as the fallback because it also reports the road
    // classification (residential, service, ...) when it answers in time.
    const url =
      NOMINATIM +
      '?lat=' + lat.toFixed(7) +
      '&lon=' + lon.toFixed(7) +
      '&format=json&zoom=18';
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const geo = (await res.json()) as { address?: Record<string, string> };
        const road =
          geo.address?.road ?? geo.address?.pedestrian ?? geo.address?.footway ?? null;
        if (road && road.trim()) return { street: road.trim(), highway: null, ok: true };
      }
    } catch {
      /* fall through to Overpass */
    }

    const res2 = await post(OVERPASS, 'data=' + encodeURIComponent(query(lat, lon, 40)));
    if (res2) {
      const json = (await res2.json()) as {
        elements?: Array<{ tags?: Record<string, string> }>;
      };
      const named = (json.elements ?? [])
        .map((e) => e.tags ?? {})
        .filter((t) => typeof t.name === 'string' && t.name.trim());
      if (named.length) {
        return {
          street: named[0].name.trim(),
          highway: named[0].highway ?? null,
          ok: true,
        };
      }
    }
    return fail;
  } catch {
    return fail;
  }
}

/**
 * Compare the OCR reading against the map. Returns null when either side is
 * missing - only a genuine contradiction counts as a disagreement.
 */
export function streetsAgree(
  ocr: string | null,
  osm: string | null
): boolean | null {
  if (!ocr || !osm) return null;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bstreet\b|\s*\bst\b/g, ' st')
      .replace(/\bavenue\b|\s*\bave\b/g, ' ave')
      .replace(/\broad\b|\s*\brd\b/g, ' rd')
      .replace(/\bdrive\b|\s*\bdr\b/g, ' dr')
      .replace(/\blane\b|\s*\bln\b/g, ' ln')
      .replace(/\bboulevard\b|\s*\bblvd\b/g, ' blvd')
      .replace(/[^a-z0-9]/g, '');
  const a = norm(ocr);
  const b = norm(osm);
  if (!a || !b) return null;
  if (a === b) return true;
  // "5thstreet" vs "west5thstreet" - one contains the other.
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/** Streets are jurisdiction-specific, so validate only within a profile. */
export type OsmCrossCheck = {
  osmStreet: string | null;
  /** false = a real contradiction the reviewer must resolve */
  agrees: boolean | null;
  checked: boolean;
};

export type { StreetContext };
