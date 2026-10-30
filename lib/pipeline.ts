import path from 'node:path';
import { transcode } from './ffmpeg';
import { extractGps } from './gps';
import { extractOverlayGps } from './overlay';
import { corroboratedIds, groupHazards } from './consensus';
import { runSegmentation } from './sam';
import { resolveTracks } from './filter';
import { classifyTrack } from './spark';
import { getMetaClient, costTally } from './meta';
import { storageDir } from './db';
import {
  createJob,
  deleteDetections,
  getJob,
  insertDetection,
  listAllDetections,
  listDetections,
  promoteVerified,
  readGps,
  updateJob,
} from './repo';
import type { GpsTrack } from './types';/**
 * The whole job, end to end:
 *
 *   ingest -> transcode -> GPS -> SAM -> persistence filter -> Spark -> rows
 *
 * Each stage reports progress, because a 10-minute clip takes real wall-clock
 * time and a silent spinner is how people close tabs.
 */
export type Stage =
  | 'transcoding'
  | 'gps'
  | 'segmenting'
  | 'filtering'
  | 'classifying'
  | 'done'
  | 'failed';

export type Progress = {
  stage: Stage;
  done: number;
  total: number;
  message: string;
  clientMode?: 'live' | 'fixture';
};

export type ProgressSink = (p: Progress) => void;

const noop: ProgressSink = () => {};

export function newJob(name: string, footagePath?: string | null): number {
  const id = createJob(name);
  if (footagePath) updateJob(id, { footage_path: footagePath, status: 'ingested' });
  return id;
}

export async function runJob(jobId: number, onProgress: ProgressSink = noop): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const outDir = storageDir('jobs', String(jobId));
  const report = (p: Progress) => onProgress(p);

  try {
    /* ---- 1. transcode (once) ---- */
    let analysisPath = job.analysisPath;
    let frames = job.frames;
    let fps = job.analysisFps;

    if (!analysisPath || !frames) {
      if (!job.footagePath) throw new Error('job has no footage attached');
      report({ stage: 'transcoding', done: 0, total: 2, message: 'cutting analysis + playback files' });
      const res = await transcode(job.footagePath, outDir, (pct) =>
        report({
          stage: 'transcoding',
          done: pct === 100 ? 2 : 1,
          total: 2,
          message: pct === 100 ? 'transcode complete' : 'playback file encoded',
        })
      );
      analysisPath = res.analysisPath;
      frames = res.analysisFrames;
      fps = res.analysisFps;
      updateJob(jobId, {
        playback_path: res.playbackPath,
        analysis_path: res.analysisPath,
        frames,
        analysis_fps: fps,
        status: 'transcoded',
      });
    }

    /* ---- 2. GPS from the ORIGINAL recording ----
       The flattened export carries no GPS (measured: 0 tags vs 701 in the
       source), so a job may carry the original recording purely for its track. */
    let gps: GpsTrack = readGps(jobId);
    const gpsFile = job.gpsPath ?? job.footagePath;
    if (!gps.samples.length && gpsFile) {
      report({ stage: 'gps', done: 0, total: 1, message: 'reading GPS from source file' });
      gps = await extractGps(gpsFile);

      // Some apps keep no track at all and burn the fix into the picture
      // instead. Reading it back out of the footage is the last resort before
      // the job gives up on geo and asks for a manual pin.
      if (!gps.samples.length && job.footagePath) {
        report({ stage: 'gps', done: 0, total: 1, message: 'reading burned-in GPS overlay' });
        gps = await extractOverlayGps(job.footagePath, (done, total) =>
          report({ stage: 'gps', done, total, message: `overlay OCR ${done}/${total} frames` })
        );
      }
      updateJob(jobId, {
        gps_source: gps.source,
        gps_json: JSON.stringify(gps),
      });
      report({
        stage: 'gps',
        done: 1,
        total: 1,
        message: gps.samples.length
          ? `${gps.samples.length} GPS fixes (${gps.source})`
          : 'no GPS track - hazards will need a manual pin',
      });
    }

    /* ---- 3. SAM 3.1 over overlapping windows ---- */
    const client = await getMetaClient();
    report({ stage: 'segmenting', done: 0, total: frames, message: 'requesting masks', clientMode: client.mode });
    const seg = await runSegmentation({
      analysisPath: analysisPath!,
      totalFrames: frames,
      fps,
      onProgress: (doneChunks, totalChunks) =>
        report({
          stage: 'segmenting',
          done: doneChunks,
          total: totalChunks,
          message: `segment ${doneChunks}/${totalChunks} requests`,
          clientMode: client.mode,
        }),
    });

    /* ---- 4. temporal filter ---- */
    report({
      stage: 'filtering',
      done: 0,
      total: seg.frames.length,
      message: `filtering ${seg.frames.length} raw masks`,
      clientMode: seg.clientMode,
    });
    const tracks = resolveTracks(seg.frames, fps);
    report({
      stage: 'filtering',
      done: seg.frames.length,
      total: seg.frames.length,
      message: `${tracks.length} persistent hazards survived the filter`,
      clientMode: seg.clientMode,
    });

    /* ---- 5. classify + geo + cross-check, then persist ---- */
    const skipOsm = client.mode === 'fixture'; // no coords yet means nothing to check
    let done = 0;
    let skipped = 0;

    // A re-run replaces this job's results instead of appending a second set.
    deleteDetections(jobId);

    for (const track of tracks) {
      const result = await classifyTrack({
        jobId,
        analysisPath: analysisPath!,
        track,
        fps,
        gps,
        client,
        skipOsm: skipOsm || gps.samples.length === 0,
      });
      done += 1;

      // Rejected as not-on-roadway: count it so the skip is visible in the
      // progress stream instead of a detection that silently never appears.
      if (!result) {
        skipped += 1;
        report({
          stage: 'classifying',
          done,
          total: tracks.length,
          message: `not on roadway - ${skipped} rejected of ${done} seen`,
          clientMode: seg.clientMode,
        });
        continue;
      }

      const { detection } = result;
      insertDetection(detection);
      report({
        stage: 'classifying',
        done,
        total: tracks.length,
        message: `${detection.hazardType} · severity ${detection.severity}`,
        clientMode: seg.clientMode,
      });
    }

    /* ---- 6. a second pass that agrees is a verification ----
       Not a human clicking Verify twice for one pothole: two audits agreeing
       on the type is agreeing about what the thing is, which is what the
       button means. Disputed groups are excluded by corroboratedIds(), so a
       disagreement still waits for a person. */
    const corroborated = corroboratedIds(groupHazards(listAllDetections()));
    const promoted = promoteVerified(corroborated);

    const cost = costTally();
    updateJob(jobId, {
      status: 'ready',
      cost_estimate: Number(cost.totalUsd.toFixed(4)),
      error: null,
    });

    report({
      stage: 'done',
      done: tracks.length,
      total: tracks.length,
      message:
        `${listDetections(jobId).length} detections from ${seg.chunks} chunks ` +
        `· ${cost.totalUsd.toFixed(3)} · mode: ${seg.clientMode}` +
        (promoted ? ` · ${promoted} verified by a second pass` : '') +
        (seg.notice ? ` · ${seg.notice}` : ''),
      clientMode: seg.clientMode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: 'failed', error: message });
    report({ stage: 'failed', done: 0, total: 0, message });
    throw err;
  }
}

/**
 * Absolute URL the browser can use to stream the playback file.
 */
export function relativePlayback(jobId: number, playbackPath: string): string {
  return `/api/files/${path.basename(path.dirname(playbackPath))}/${path.basename(playbackPath)}`;
}
