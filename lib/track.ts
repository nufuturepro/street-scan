import type { GpsSample, GpsTrack } from './types';

/**
 * Time -> location. The GPS track and the video are two independent clocks;
 * extractGps() already expresses every sample as ms-since-t0, so this is a
 * plain monotone interpolation over that axis.
 */

export function isValid(track: GpsTrack | null | undefined): boolean {
  return !!track && track.samples.length > 0;
}

/** Linear interpolation between the two samples bracketing `tMs`. */
export function interpolate(track: GpsTrack, tMs: number): { lat: number; lon: number } | null {
  const s = track.samples;
  if (s.length === 0) return null;
  if (s.length === 1) return { lat: s[0].lat, lon: s[0].lon };

  if (tMs <= s[0].t) return { lat: s[0].lat, lon: s[0].lon };
  const last = s[s.length - 1];
  if (tMs >= last.t) return { lat: last.lat, lon: last.lon };

  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= tMs) lo = mid;
    else hi = mid;
  }

  const a = s[lo];
  const b = s[hi];
  const span = b.t - a.t;
  if (span <= 0) return { lat: a.lat, lon: a.lon };

  const f = (tMs - a.t) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
  };
}

/**
 * A fix further than `maxGapMs` from any sample is a guess, not a reading —
 * report null so the UI asks for a manual pin instead of inventing a street.
 */
export function nearestSample(track: GpsTrack, tMs: number): GpsSample | null {
  if (!track.samples.length) return null;
  let best = track.samples[0];
  let bestDist = Math.abs(best.t - tMs);
  for (const s of track.samples) {
    const d = Math.abs(s.t - tMs);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}
