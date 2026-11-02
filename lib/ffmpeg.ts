import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ANALYSIS_FPS, ANALYSIS_SIZE, PLAYBACK_FPS, PLAYBACK_SIZE } from './config';

/**
 * ffmpeg wrappers. All transcoding happens once per job; everything downstream
 * reads the two derived files.
 */

function wingetBin(name: string): string | null {
  const links = path.join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft', 'WinGet', 'Links', `${name}.exe`
  );
  if (existsSync(links)) return links;

  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (!existsSync(packages)) return null;
  for (const entry of readdirSync(packages)) {
    if (!entry.toLowerCase().includes('ffmpeg')) continue;
    const hit = findBinary(path.join(packages, entry), `${name}.exe`);
    if (hit) return hit;
  }
  return null;
}

function findBinary(dir: string, file: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e);
      if (e.toLowerCase() === file.toLowerCase()) return full;
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

const cache = new Map<string, string | null>();

export function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  if (cache.has(name)) return cache.get(name)!;
  let found: string | null = process.env[`${name.toUpperCase()}_PATH`] ?? null;
  if (!found) {
    // Windows shim directories may not be on this process's PATH yet.
    found = process.platform === 'win32' ? wingetBin(name) : null;
  }
  if (!found) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  cache.set(name, found);
  return found;
}

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function assertTools(): Promise<void> {
  if (!resolveBinary('ffmpeg')) {
    throw new Error(
      'ffmpeg not found. Install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH.'
    );
  }
  if (!resolveBinary('ffprobe')) {
    throw new Error(
      'ffprobe not found. Install it (winget install Gyan.FFmpeg) or set FFPROBE_PATH.'
    );
  }
}

export type Probe = {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
};

export async function probe(file: string): Promise<Probe> {
  const ffprobe = resolveBinary('ffprobe')!;
  const res = await run(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ]);
  if (res.code !== 0) throw new Error(`ffprobe failed: ${res.stderr}`);
  const meta = JSON.parse(res.stdout);
  const video = (meta.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found');

  const durationSec = Number(meta.format?.duration ?? video.duration ?? 0);
  const [num, den] = String(video.avg_frame_rate ?? video.r_frame_rate ?? '30/1').split('/');
  const fps = Number(den) ? Number(num) / Number(den) : 30;

  return {
    durationSec,
    fps: fps || 30,
    width: Number(video.width),
    height: Number(video.height),
    codec: String(video.codec_name ?? 'unknown'),
  };
}

export type TranscodeResult = {
  playbackPath: string;
  analysisPath: string;
  analysisFrames: number;
  analysisFps: number;
  durationSec: number;
};

/**
 * Produce the two derived files.
 *
 *  playback - what the human watches
 *  analysis - what SAM sees: smaller and slower, because SAM bills per frame.
 *             10fps vs 30fps is a 3x cost cut and still 10-20 frames of every
 *             pothole, which is plenty for the persistence filter.
 *
 * Both start at t=0, so hazardTime = frameIndex / ANALYSIS_FPS maps directly
 * onto playback.currentTime. No clock sync problem anywhere downstream.
 *
 * ASSUMPTION A: SAM consumes the analysis file at its native 10fps. Unverified
 * until billing is restored. config.ANALYSIS_FPS is the single switch if not.
 */
export async function transcode(
  input: string,
  outDir: string,
  onProgress?: (pct: number) => void
): Promise<TranscodeResult> {
  await assertTools();
  const ffmpeg = resolveBinary('ffmpeg')!;
  const info = await probe(input);

  const playbackPath = path.join(outDir, 'playback.mp4');
  const analysisPath = path.join(outDir, 'analysis.mp4');

  const encode = (out: string, size: string, fps: number) =>
    run(ffmpeg, [
      '-y',
      '-i', input,
      '-vf', `scale=${size}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', out === playbackPath ? '23' : '28',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      out,
    ]);

  const first = await encode(playbackPath, PLAYBACK_SIZE, PLAYBACK_FPS);
  if (first.code !== 0) throw new Error(`ffmpeg playback encode failed: ${first.stderr.slice(-800)}`);
  onProgress?.(50);

  const second = await encode(analysisPath, ANALYSIS_SIZE, ANALYSIS_FPS);
  if (second.code !== 0) throw new Error(`ffmpeg analysis encode failed: ${second.stderr.slice(-800)}`);
  onProgress?.(100);

  const analysisFrames = Math.max(1, Math.round(info.durationSec * ANALYSIS_FPS));

  return {
    playbackPath,
    analysisPath,
    analysisFrames,
    analysisFps: ANALYSIS_FPS,
    durationSec: info.durationSec,
  };
}

/**
 * Cut one chunk window out of the analysis video for upload.
 * Only called in live mode - fixtures never touch ffmpeg.
 */
export async function sliceSegment(
  input: string,
  out: string,
  startSec: number,
  durationSec: number
): Promise<string> {
  const ffmpeg = resolveBinary('ffmpeg')!;
  const res = await run(ffmpeg, [
    '-y',
    '-ss', String(Math.max(0, startSec)),
    '-i', input,
    '-t', String(Math.max(0.1, durationSec)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-an',
    out,
  ]);
  if (res.code !== 0 || !existsSync(out)) {
    throw new Error(`slice failed: ${res.stderr.slice(-400)}`);
  }
  return out;
}

/** Count frames exactly by decoding, used to verify ASSUMPTION A later. */
export async function countFrames(file: string): Promise<number> {
  const ffprobe = resolveBinary('ffprobe')!;
  const res = await run(ffprobe, ['-v', 'error', '-count_frames',
    '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Extract one frame as PNG — the input to mask compositing and classification. */
export async function extractFrame(file: string, timeSec: number, outPng: string): Promise<string> {
  const ffmpeg = resolveBinary('ffmpeg')!;
  const res = await run(ffmpeg, [
    '-y', '-ss', String(Math.max(0, timeSec)), '-i', file,
    '-frames:v', '1', '-q:v', '2', outPng,
  ]);
  if (res.code !== 0 || !existsSync(outPng)) {
    throw new Error(`frame extract failed: ${res.stderr.slice(-400)}`);
  }
  return outPng;
}

/**
 * Composite a normalized polygon onto a frame so the classifier sees the
 * hazard isolated from its surroundings (plus the raw frame for context).
 */
export async function cropToMask(
  sourceFile: string,
  timeSec: number,
  polygon: Array<[number, number]>,
  outPng: string
): Promise<string> {
  if (!polygon.length) throw new Error('empty polygon');
  const ffmpeg = resolveBinary('ffmpeg')!;
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const info = await probe(sourceFile);
  // 10% context margin so the classifier can see the surrounding road.
  // The padded bounds are clamped to the frame BEFORE the size is derived:
  // clamping the size against padded space let a mask sitting on the frame
  // edge (SAM boxes do overshoot) request a crop wider than the frame, which
  // ffmpeg rejects outright - and that single rejection used to kill the run.
  const padX = (maxX - minX) * 0.1 + 0.01;
  const padY = (maxY - minY) * 0.1 + 0.01;
  const left = Math.min(1, Math.max(0, minX - padX));
  const right = Math.min(1, Math.max(0, maxX + padX));
  const top = Math.min(1, Math.max(0, minY - padY));
  const bottom = Math.min(1, Math.max(0, maxY + padY));
  // floor(left*W) + floor((right-left)*W) <= floor(right*W) <= W, so the
  // crop always fits; the final -2 guards a degenerate zero-width box.
  const x = Math.min(Math.floor(left * info.width), info.width - 2);
  const y = Math.min(Math.floor(top * info.height), info.height - 2);
  const w = Math.max(2, Math.floor((right - left) * info.width));
  const h = Math.max(2, Math.floor((bottom - top) * info.height));

  const res = await run(ffmpeg, [
    '-y', '-ss', String(Math.max(0, timeSec)), '-i', sourceFile,
    '-vf', `crop=${w}:${h}:${x}:${y}`,
    '-frames:v', '1', '-q:v', '2', outPng,
  ]);
  if (res.code !== 0 || !existsSync(outPng)) {
    throw new Error(`crop failed: ${res.stderr.slice(-400)}`);
  }
  return outPng;
}

/** Stable on-disk location for a job's derived media. */
export function writeJson(file: string, value: unknown): string {
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export const TMP = path.join(os.tmpdir(), 'streetscan');

/**
 * Temp dir for derived chunks and extracted frames. Created on demand so it
 * survives a fresh machine or a cleared %TEMP%.
 */
export function tmpDir(): string {
  mkdirSync(TMP, { recursive: true });
  return TMP;
}
