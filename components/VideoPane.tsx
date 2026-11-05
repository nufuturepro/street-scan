'use client';

import { useEffect, useRef, useState } from 'react';
import type { Detection } from '@/lib/types';
import { paintMask, SEVERITY_COLORS } from './mask';

/** How long after its sample frame a mask stays painted. */
const MASK_HOLD_BEFORE = 0.8;
const MASK_HOLD_AFTER = 1.8;

type Props = {
  src: string | null;
  detections: Detection[];
  activeId: number | null;
  /** Increments on every selection, so re-asking for the same hazard re-seeks. */
  seekToken: number;
  /**
   * Open the footage at this moment instead of 00:00 - the ?t= deep link
   * from the dashboard's Intersections card. Used only while nothing is
   * selected: an active hazard's own timestamp wins.
   */
  seekMs?: number | null;
  onSelect: (id: number) => void;
};

/**
 * Split-screen left pane: the footage, with SAM's masks painted on top.
 *
 * Masks are representative frames, not per-frame video data - we keep the
 * single highest-confidence polygon per hazard. So a mask stays painted for a
 * short window around its sample time rather than flickering for 1/10s; the
 * alternative looks correct in code and terrible on screen.
 */
export default function VideoPane({ src, detections, activeId, seekToken, seekMs = null, onSelect }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    let stopped = false;

    const draw = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) {
        if (!stopped) frameRef.current = requestAnimationFrame(draw);
        return;
      }

      const w = video.clientWidth;
      const h = video.clientHeight;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const t = video.currentTime;

        for (const d of detections) {
          const sample = d.tMs / 1000;
          if (t < sample - MASK_HOLD_BEFORE || t > sample + MASK_HOLD_AFTER) continue;
          if (!d.polygon || d.polygon.length < 3) continue;

          paintMask(ctx, d, {
            width: canvas.width,
            height: canvas.height,
            active: d.id === activeId,
          });
        }
      }

      if (!stopped) frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frameRef.current);
    };
  }, [detections, activeId]);

  // A mask is only painted for ~2.6s around its sample frame, so an audit
  // opened at 00:00 shows an unmarked street and no way to tell why. Selecting
  // a hazard is the moment to jump to it - and selecting the same hazard a
  // second time has to jump again, which is what seekToken is for.
  //
  // Neither deps entry reacts to polling: the dashboard refreshes every 5s and
  // hands down a fresh detections array each time, so listing `detections`
  // here would re-seek every five seconds and yank playback out from under
  // whoever is reviewing it. It is read through a ref for the same reason.
  const detectionsRef = useRef(detections);
  useEffect(() => {
    detectionsRef.current = detections;
  }, [detections]);

  useEffect(() => {
    const fromActive =
      activeId != null
        ? detectionsRef.current.find((x) => x.id === activeId)?.tMs
        : undefined;
    const target = fromActive ?? seekMs;
    // `src` is a dependency because the <video> element does not exist until
    // the job fetch lands: an effect that ran while videoRef was still null
    // used to give up and never seek, which left a ?t= deep link parked at
    // 00:00. The element arrives with src, so this re-runs exactly then.
    if (target == null || !src) return;
    const video = videoRef.current;
    if (!video) return;
    const seek = () => {
      video.currentTime = target / 1000;
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [activeId, seekToken, seekMs, src]);

  const seekTo = (id: number) => {
    const d = detections.find((x) => x.id === id);
    const video = videoRef.current;
    if (!d || !video) return;
    video.currentTime = d.tMs / 1000;
    onSelect(id);
  };

  return (
    <div className="flex flex-col">
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            className="block w-full aspect-video"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center text-sm text-muted">
            Waiting for transcode…
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>

      {/* Hazard timeline: tick per detection, click to jump to it. */}
      {duration > 0 && detections.length > 0 && (
        <div className="mt-2">
          <div className="relative h-6 rounded bg-surface2 border border-line">
            {detections.map((d) => {
              const pct = Math.min(100, Math.max(0, (d.tMs / 1000 / duration) * 100));
              return (
                <button
                  key={d.id}
                  onClick={() => seekTo(d.id!)}
                  title={`${d.hazardType} · severity ${d.severity}`}
                  className={`absolute top-0 h-full w-1.5 -translate-x-1/2 rounded-sm transition-transform hover:scale-y-110 ${
                    d.id === activeId ? 'z-10 scale-y-110' : ''
                  }`}
                  style={{
                    left: `${pct}%`,
                    background: SEVERITY_COLORS[d.severity] ?? '#f59e0b',
                    opacity: d.needsReview ? 0.5 : 1,
                  }}
                  aria-label={`Jump to ${d.hazardType} at ${d.tMs}ms`}
                />
              );
            })}
            <div
              className="pointer-events-none absolute top-0 h-full w-px bg-white/70"
              style={{ left: `${duration ? (current / duration) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
