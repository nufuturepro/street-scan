import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { storageDir } from './db';
import { OVERLAY_CROP_H, OVERLAY_CROP_W, OVERLAY_SAMPLE_FPS, OVERLAY_SPIKE_M } from './config';
import { resolveBinary, run, tmpDir } from './ffmpeg';
import { haversineM } from './rqsi';
import type { GpsSample, GpsTrack } from './types';

/**
 * GPS recovered by READING THE PICTURE.
 *
 * Some dashcam apps have no GPS track to export - they burn the fix into the
 * frame instead, as a fixed block in the top-left corner:
 *
 *   10/29/26, 5:41:13 PM. GPS Speed: 0.0 mph. Degrees: 40.70395, -73.94745. Altitude: - ft
 *   610 Broadway, Brooklyn, NY 11206, USA
 *
 * That is a real coordinate at ~1 m resolution, so the clip is not geo-blind
 * after all: sample the corner at 1Hz, OCR it, and hand the fixes to the same
 * GpsTrack shape extractGps() produces. Everything downstream - interpolation,
 * RQSI segments, pins, the Open311 payload - is unchanged.
 *
 * The second line is a reverse-geocoded address, which is the street and
 * cross street already typed out for us; it is left alone here because only
 * the coordinates are needed to place a hazard, and OCR-ing an address buys
 * nothing the OSM lookup does not already give.
 *
 * Nothing here may fail the job: a clip with no overlay simply has no track,
 * exactly like a recording with GPS switched off.
 */

/** White glyphs on a dark night frame: anything brighter than this is text. */
const LUMA_CUT = 185;

/** Corner crop, as fractions of the frame. Measured on a 1080p clip, not guessed. */
const CORNER = `crop=iw*${OVERLAY_CROP_W}:ih*${OVERLAY_CROP_H}:0:0`;

/** No fix in this many frames means the app burned something else in - stop. */
const GIVE_UP_AFTER = 10;

/**
 * A fix further than this from the route's midpoint is an OCR misread, not a
 * drive: dropping a minus sign turns -73.9 into +73.9 and would stretch one
 * segment across the Atlantic. Roughly 5 km, far more than any clip drives.
 */
const OUTLIER_DEG = 0.05;

export type OverlayFix = { lat: number; lon: number };

/**
 * Pull the coordinate out of one frame of overlay text.
 *
 * Both numbers must carry a decimal point: OCR sometimes fuses "40.70395"
 * into "4070395", and a fused number still passes every range check above.
 */
export function parseOverlay(text: string): OverlayFix | null {
  const m = text.match(/Degrees:?\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Turn the fixes that did parse into a track: stamp each one with the time of
 * the frame it came from, drop the ones that disagree with the rest of the
 * drive, and drop an excursion that leaves and returns. Kept separate from the
 * OCR loop so it can be asserted directly.
 */
export function buildTrack(
  found: Array<{ index: number; fix: OverlayFix }>,
  fps: number
): GpsSample[] {
  if (!found.length) return [];
  const lat0 = median(found.map((f) => f.fix.lat));
  const lon0 = median(found.map((f) => f.fix.lon));
  let rejected = 0;

  const kept: GpsSample[] = [];
  for (const { index, fix } of found) {
    if (
      Math.abs(fix.lat - lat0) > OUTLIER_DEG ||
      Math.abs(fix.lon - lon0) > OUTLIER_DEG
    ) {
      rejected++;
      continue;
    }
    kept.push({ t: Math.round((index * 1000) / fps), lat: fix.lat, lon: fix.lon });
  }

  // An isolated excursion is far from the fix before it AND far from the one
  // after it. Genuine motion is only ever far from one side, so a long OCR
  // blackout still carries the car forward instead of being clipped back.
  const samples = kept.filter((s, i) => {
    if (i === 0 || i === kept.length - 1) return true;
    if (haversineM(kept[i - 1], s) > OVERLAY_SPIKE_M && haversineM(s, kept[i + 1]) > OVERLAY_SPIKE_M) {
      rejected++;
      return false;
    }
    return true;
  });

  if (rejected) console.log(`[overlay] ${rejected} fix(es) rejected as misreads`);
  return samples;
}

/**
 * Read the burned-in overlay of a recording into a track.
 *
 * Sampled at OVERLAY_SAMPLE_FPS, so sample i sits at i / fps seconds - within
 * half a frame of the real time, which is a couple of metres even at 12 mph.
 */
export async function extractOverlayGps(
  videoFile: string,
  onProgress?: (done: number, total: number) => void
): Promise<GpsTrack> {
  const empty: GpsTrack = { source: 'none', samples: [] };
  const dir = path.join(tmpDir(), `overlay-${Date.now()}`);

  try {
    const ffmpeg = resolveBinary('ffmpeg');
    if (!ffmpeg) return empty;

    mkdirSync(dir, { recursive: true });
    const filter = [
      `fps=${OVERLAY_SAMPLE_FPS}`,
      CORNER,
      'scale=2000:-1', // OCR reads the upscaled corner far better than the raw one
      'format=gray',
      `lutyuv=y='if(gt(val,${LUMA_CUT}),255,0)'`,
      'negate',
    ].join(',');

    const res = await run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-i', videoFile,
      '-vf', filter,
      path.join(dir, 'f%04d.png'),
    ]);
    if (res.code !== 0) {
      console.error('[overlay] frame extraction failed:', res.stderr.slice(-300));
      return empty;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    if (!files.length) return empty;

    // Language data downloads once and is cached in the mounted storage
    // volume, so a container restart does not fetch it again.
    const worker = await createWorker('eng', 1, {
      cachePath: path.join(storageDir('tesseract')),
    });

    try {
      const found: Array<{ index: number; fix: OverlayFix }> = [];
      for (let i = 0; i < files.length; i++) {
        const { data } = await worker.recognize(readFileSync(path.join(dir, files[i])));
        const fix = parseOverlay(data.text);
        if (fix) found.push({ index: i, fix });
        else if (found.length === 0 && i + 1 >= GIVE_UP_AFTER) break;
        onProgress?.(i + 1, files.length);
      }

      if (!found.length) {
        console.log(`[overlay] no coordinates in ${files.length} frames of ${videoFile}`);
        return empty;
      }

      const samples = buildTrack(found, OVERLAY_SAMPLE_FPS);
      console.log(`[overlay] ${samples.length}/${files.length} frames gave a fix`);
      if (!samples.length) return empty;
      return { source: 'overlay', samples };
    } finally {
      await worker.terminate();
    }
  } catch (err) {
    // Never blocks a job: OCR is a bonus source of coordinates, not a gate.
    console.error('[overlay] failed:', err instanceof Error ? err.message : err);
    return empty;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
