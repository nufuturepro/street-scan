import path from 'node:path';
import { transcode } from './ffmpeg';
import { extractGps } from './gps';
import { extractOverlayGps } from './overlay';
import { corroboratedIds, groupHazards } from './consensus';
import { runSegmentation } from './sam';
import { resolveTracks } from './filter';
import { tooSmall } from './scale';
import { classifyTrack } from './spark';
import { getMetaClient } from './meta';
import { jobSpend } from './spend';
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

  // The tally is per-process and cumulative - resetTally() has no callers, so
  // a second run in the same container also sees what the first one spent.
  // What a job records has to be what THIS run cost, because that number is
  // what the dashboard quotes per audit: take a reading now, store the
  // difference when the run finishes.
  // What this audit had already cost before this run. The end-of-run figure
  // is a ledger delta, so a parallel job's charges can never fold into it.
  const spendBefore = jobSpend(jobId).usd;

  try {
    /* ---- 1. transcode (once) ---- */
    let analysisPath = job.analysisPath;
    let frames = job.frames;
    let fps = job.analysisFps;

    if (!analysisPath || !frames) {
      if (!job.footagePath) throw new Error('job has no footage attached');
      updateJob(jobId, { status: 'transcoding' });
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
    updateJob(jobId, { status: 'segmenting' });
    const client = await getMetaClient();
    report({ stage: 'segmenting', done: 0, total: frames, message: 'requesting masks', clientMode: client.mode });
    const seg = await runSegmentation({
      analysisPath: analysisPath!,
      totalFrames: frames,
      fps,
      jobId,
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

    // Size gate at scan time (lib/scale.ts): a mask the picture cannot support
    // is not sent to the classifier at all. That saves a Spark call per speck
    // and - the point - stops the work order from ever existing. Existing
    // audits get the same verdict at read time, so nothing had to be re-scanned.
    const judged = tracks.filter((t) => !tooSmall(t.best.polygon));
    const tooSmallTracks = tracks.length - judged.length;

    report({
      stage: 'filtering',
      done: seg.frames.length,
      total: seg.frames.length,
      message:
        `${judged.length} persistent hazards survived the filter` +
        (tooSmallTracks ? ` · ${tooSmallTracks} too small to judge` : ''),
      clientMode: seg.clientMode,
    });

    /* ---- 5. classify + geo + cross-check, then persist ---- */
    const skipOsm = client.mode === 'fixture'; // no coords yet means nothing to check
    let done = 0;
    let skipped = 0;
    let skippedSmall = 0;
    let failed = 0;

    // A re-run replaces this job's results instead of appending a second set.
    deleteDetections(jobId);
    updateJob(jobId, { status: 'enriching' });

    for (const track of judged) {
      // One bad track must not cost the whole audit: a crop ffmpeg rejects or
      // a transient API error skips that detection - counted below - instead
      // of failing the run after its rows were already cleared for the re-run.
      let result: Awaited<ReturnType<typeof classifyTrack>>;
      try {
        result = await classifyTrack({
          jobId,
          analysisPath: analysisPath!,
          track,
          fps,
          gps,
          client,
          skipOsm: skipOsm || gps.samples.length === 0,
        });
      } catch (err) {
        done += 1;
        failed += 1;
        console.error(
          `[classify] job ${jobId} frame ${track.best.frameIndex} skipped:`,
          err instanceof Error ? err.message : err
        );
        report({
          stage: 'classifying',
          done,
          total: judged.length,
          message: `classification error - ${failed} skipped of ${done} seen`,
          clientMode: seg.clientMode,
        });
        continue;
      }
      done += 1;

      // Rejected by the classifier as not a defect (see lib/spark.ts): counted
      // so the skip shows in the progress stream instead of silently vanishing.
      // 'too_small' is called out separately - it is the reason the app used to
      // have no way to hear, and a run that hides specks should say so.
      if (!result.detection) {
        skipped += 1;
        if (result.classification.rejectReason === 'too_small') skippedSmall += 1;
        report({
          stage: 'classifying',
          done,
          total: judged.length,
          message:
            `not a defect - ${skipped} rejected of ${done} seen` +
            (skippedSmall ? ` (${skippedSmall} too small)` : ''),
          clientMode: seg.clientMode,
        });
        continue;
      }

      const detection = result.detection;
      insertDetection(detection);
      report({
        stage: 'classifying',
        done,
        total: judged.length,
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

    // The ledger, not the session tally: every billing event landed its row
    // under this job id the moment it was charged, so crashes, restarts,
    // re-runs and deleted siblings cannot erase it. jobs.cost_estimate is no
    // longer written - it was per-run and overwrote itself, which is how the
    // app came to claim $12.09 against Meta's $33.38.
    const spent = Number((jobSpend(jobId).usd - spendBefore).toFixed(4));
    updateJob(jobId, {
      status: 'ready',
      error: null,
    });

    // listDetections is the read-time view: street names canonicalised, one
    // row per physical defect within the audit, size verdict stamped. What the
    // audit page counts is what this line reports.
    const kept = listDetections(jobId);
    const mergedAway = kept.reduce((n, d) => n + (d.mergedIds?.length ?? 0), 0);

    report({
      stage: 'done',
      done: judged.length,
      total: judged.length,
      message:
        `${kept.length} detections from ${seg.chunks} chunks ` +
        `· ${spent.toFixed(3)} · mode: ${seg.clientMode}` +
        (mergedAway ? ` · ${mergedAway} duplicates merged` : '') +
        (tooSmallTracks ? ` · ${tooSmallTracks} too small to judge` : '') +
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
