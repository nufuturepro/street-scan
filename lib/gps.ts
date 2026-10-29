import { exiftoolPath } from 'exiftool-vendored';
import { existsSync } from 'node:fs';
import { run, TMP } from './ffmpeg';
import type { GpsSample, GpsTrack } from './types';

/**
 * GPS extraction from the ORIGINAL recording.
 *
 * Why the original: the flattened export contains no GPS at all (measured 0 tags
 * against 701 in the source) and ships its track as a separate file. The location
 * lives in the source, recorded while GPS capture was enabled.
 *
 * We do not use exiftool-vendored's read() here: timed metadata needs -ee
 * (extract embedded) and -a (all instances), and parsing exiftool's own JSON
 * is far more predictable than its tag-object mapping.
 */

const GPS_ARGS = [
  '-j',
  '-ee',          // extract embedded / timed metadata, not just the header
  '-a',           // allow all instances - one per GPS sample
  '-n',           // numeric coordinates, no "12 deg 34' 56.0\" N" formatting
  '-G3',          // group prefixes, so we can find the tags reliably
  '-q',
  '-GPSLatitude',
  '-GPSLongitude',
  '-GPSDateTime',
  '-GPSAltitude',
  '-GPSSpeed',
];

type RawTag = number | string | RawTag[] | { value?: RawTag } | null | undefined;

function unwrap(v: RawTag): number | string | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return unwrap(v[0]);
  if (typeof v === 'object' && 'value' in v) return unwrap((v as { value?: RawTag }).value);
  return null;
}

function flatten(v: RawTag): RawTag[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(flatten);
  return [v];
}

/** Match a tag regardless of which group exiftool prefixed it with. */
function pick(obj: Record<string, RawTag>, name: string): RawTag[] {
  const hits = Object.keys(obj).filter((k) => k.endsWith(':' + name) || k === name);
  return hits.flatMap((k) => flatten(obj[k]));
}

function toMillis(v: number | string | null): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    // Seconds-since-epoch is the common numeric form for GPSDateTime with -n.
    return v > 1e11 ? v : v * 1000;
  }
  const s = v.trim();
  if (!s) return null;
  // "2026:10:27 15:30:00.123+00:00" or ISO-ish variants.
  const normalized = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

async function exiftoolJson(file: string, extraArgs: string[] = []): Promise<Record<string, RawTag>[]> {
  if (!existsSync(file)) throw new Error(`file not found: ${file}`);
  const bin = await exiftoolPath();
  const res = await run(bin, [...GPS_ARGS, ...extraArgs, file]);
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(`exiftool failed for ${file}: ${res.stderr.slice(-400)}`);
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(
      `exiftool returned unparseable JSON (exit ${res.code}): ${res.stdout.slice(0, 200)} :: ${res.stderr.slice(-300)}`
    );
  }
}

/**
 * When the recording started, so GPS samples can be expressed as ms-since-t0.
 * Falls back to the first GPS sample when the container carries no date.
 */
async function videoStartMs(file: string): Promise<number | null> {
  try {
    const bin = await exiftoolPath();
    const res = await run(bin, [
      '-j', '-a', '-n', '-q',
      '-CreateDate', '-MediaCreateDate', '-TrackCreateDate', '-DateTimeOriginal',
      file,
    ]);
    const rows = JSON.parse(res.stdout) as Record<string, RawTag>[];
    for (const row of rows ?? []) {
      for (const key of ['CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'DateTimeOriginal']) {
        const hit = Object.keys(row).find((k) => k.endsWith(':' + key) || k === key);
        if (hit) {
          const ms = toMillis(unwrap(row[hit]));
          if (ms) return ms;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Read the GPS track out of a recording.
 *
 * Returns { source: 'none' } rather than throwing when no GPS is present —
 * downstream that becomes a manual map-pin, never a blocked pipeline.
 */
export async function extractGps(file: string): Promise<GpsTrack> {
  let rows: Record<string, RawTag>[];
  try {
    rows = await exiftoolJson(file);
  } catch (err) {
    // Never swallow this: a silent catch turns every failure into
    // "no GPS in file", which reads like the camera was off.
    console.error('[gps] exiftool failed:', file, err instanceof Error ? err.message : err);
    return { source: 'none', samples: [] };
  }

  const lats = rows.flatMap((r) => pick(r, 'GPSLatitude')).map((v) => Number(unwrap(v)));
  const lons = rows.flatMap((r) => pick(r, 'GPSLongitude')).map((v) => Number(unwrap(v)));
  const times = rows.flatMap((r) => pick(r, 'GPSDateTime')).map((v) => toMillis(unwrap(v)));

  const count = Math.min(lats.length, lons.length);
  if (count === 0 || lats.every((l) => !Number.isFinite(l))) {
    return { source: 'none', samples: [] };
  }

  const start = (times.find((t) => t != null) ?? null) ?? (await videoStartMs(file));

  const samples: GpsSample[] = [];
  for (let i = 0; i < count; i++) {
    const lat = lats[i];
    const lon = lons[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Signed WGS84 degrees: exiftool applies the hemisphere Ref under -n, so a
    // western longitude stays negative. Taking abs() here would teleport every
    // hazard in the western hemisphere to the opposite side of the planet.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const t = times[i] != null && start != null ? Math.max(0, times[i]! - start) : i * 1000;
    samples.push({ t, lat, lon });
  }

  samples.sort((a, b) => a.t - b.t);
  return { source: samples.length ? 'exiftool' : 'none', samples };
}

/** Write a GPX sidecar from extracted samples — handy as a cross-check. */
export function toGpx(track: GpsTrack): string {
  const pts = track.samples
    .map(
      (s) =>
        `    <trkpt lat="${s.lat}" lon="${s.lon}"><time>${new Date(s.t).toISOString()}</time></trkpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="StreetScan">
  <trk><name>StreetScan</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

export const WORKDIR = TMP;
