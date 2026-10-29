/**
 * Render stills for a job's detections - the before/after images a README or a
 * demo video needs to show what the pipeline actually found.
 *
 * For every detection it writes a pair:
 *
 *   screenshots/job<id>/NNN-<type>-raw.png        the frame as SAM saw it
 *   screenshots/job<id>/NNN-<type>-annotated.png   mask box + label drawn on
 *
 * Frames come from the analysis video and rows come from the local database, so
 * this never calls the API: $0, and safe to re-run as often as you like.
 *
 * Run (same pattern as verify-filter.ts - the project's imports are extensionless):
 *
 *   OUT=$(mktemp -d) && npx tsc scripts/render-stills.ts --outDir "$OUT" \
 *     --module commonjs --target es2021 --moduleResolution node \
 *     --esModuleInterop --skipLibCheck --strict false \
 *     && node "$OUT/scripts/render-stills.js" 4
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrame, probe, resolveBinary, run } from '../lib/ffmpeg';
import { bbox } from '../lib/filter';
import { getJob, listDetections } from '../lib/repo';
import type { Detection } from '../lib/types';

const SEVERITY_COLORS: Record<number, string> = {
  1: '0x71717a',
  2: '0x0ea5e9',
  3: '0xf59e0b',
  4: '0xf97316',
  5: '0xef4444',
};

/**
 * drawtext needs an explicit fontfile: the Windows build has no fontconfig, so
 * omitting it fails outright. The path carries a colon, and inside a filter
 * description a colon ends the option. Two backslashes are required: ffmpeg
 * unescapes once while building the graph and again while parsing the option,
 * so a single one arrives as a bare colon and breaks the whole chain.
 */
const FONT =
  process.platform === 'win32'
    ? "'C\\:/Windows/Fonts/arial.ttf'"
    : "'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'";

/** drawtext stops at the first quote, so sanitise rather than try to escape. */
function labelFor(d: Detection): string {
  const bits = [
    d.hazardType.replace('_', '-'),
    `sev ${d.severity}`,
    `${Math.round(d.confidence * 100)}%`,
  ];
  if (d.street) bits.push(d.street);
  return bits.join(' \u00b7 ').replace(/['"{}]/g, '');
}

async function main() {
  const jobId = Number(process.argv[2] ?? 4);
  const job = getJob(jobId);
  if (!job) {
    console.error(`no job ${jobId}`);
    process.exit(1);
  }
  if (!job.analysisPath || !existsSync(job.analysisPath)) {
    console.error(`job ${jobId} has no analysis video at ${job.analysisPath}`);
    process.exit(1);
  }

  const ffmpeg = resolveBinary('ffmpeg');
  if (!ffmpeg) {
    console.error('ffmpeg not found. Install it or set FFMPEG_PATH.');
    process.exit(1);
  }

  const detections = listDetections(jobId);
  if (!detections.length) {
    console.log(`job ${jobId} has no detections to render`);
    return;
  }

  // Polygons are normalised 0..1, so every box has to be scaled to the frame.
  const { width, height } = await probe(job.analysisPath);
  const outDir = path.join(process.cwd(), 'screenshots', `job${jobId}`);
  mkdirSync(outDir, { recursive: true });

  let ok = 0;
  let index = 0;
  for (const d of detections) {
    index += 1;
    const n = String(index).padStart(3, '0');
    const slug = `${n}-${d.hazardType.replace('_', '-')}`;
    const rawPath = path.join(outDir, `${slug}-raw.png`);
    const annPath = path.join(outDir, `${slug}-annotated.png`);

    await extractFrame(job.analysisPath, d.tMs / 1000, rawPath);

    const b = bbox(d.polygon);
    const x = Math.max(0, Math.min(width - 8, Math.round(b.x * width)));
    const y = Math.max(0, Math.min(height - 8, Math.round(b.y * height)));
    // A one-pixel box is invisible; keep a floor so small hazards still read.
    const bw = Math.max(12, Math.min(width - x, Math.round(b.w * width)));
    const bh = Math.max(12, Math.min(height - y, Math.round(b.h * height)));
    const color = SEVERITY_COLORS[d.severity] ?? '0xf59e0b';
    const label = labelFor(d);

    const filter = [
      `drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:color=${color}@0.9:t=4`,
      `drawtext=fontfile=${FONT}:text='${label}':x=${x}:y=${Math.max(0, y - 34)}` +
        ':fontsize=26:fontcolor=white:box=1:boxcolor=0x000000@0.72:boxborderw=6:expansion=none',
    ].join(',');

    const res = await run(ffmpeg, ['-y', '-i', rawPath, '-vf', filter, annPath]);
    if (res.code !== 0) {
      console.error(`FAIL ${slug}: ${res.stderr.slice(-300)}`);
      continue;
    }
    ok += 1;
    console.log(
      `ok   ${slug}  ${d.hazardType} sev${d.severity} ` +
        `${Math.round(d.confidence * 100)}%  ${(statSync(annPath).size / 1024).toFixed(0)} KB`
    );
  }

  console.log(`\n${ok}/${detections.length} stills in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
