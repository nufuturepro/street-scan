'use client';

import { useEffect, useRef, useState } from 'react';
import type { Detection } from '@/lib/types';

const SEVERITY_COLORS: Record<number, string> = {
  1: '#71717a',
  2: '#0ea5e9',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

/** How long after its sample frame a mask stays painted. */
const MASK_HOLD_BEFORE = 0.8;
const MASK_HOLD_AFTER = 1.8;

type Props = {
  src: string | null;
  detections: Detection[];
  activeId: number | null;
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
export default function VideoPane({ src, detections, activeId, onSelect }: Props) {
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

          const isActive = d.id === activeId;
          const color = SEVERITY_COLORS[d.severity] ?? '#f59e0b';

          ctx.beginPath();
          d.polygon.forEach(([x, y], i) => {
            const px = x * canvas.width;
            const py = y * canvas.height;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();

          ctx.fillStyle = color;
          ctx.globalAlpha = isActive ? 0.42 : 0.22;
          ctx.fill();
          ctx.globalAlpha = isActive ? 1 : 0.65;
          ctx.strokeStyle = color;
          ctx.lineWidth = isActive ? 3 : 2;
          ctx.stroke();

          const first = d.polygon[0];
          const label = `${d.hazardType.replace('_', '-')}  S${d.severity}`;
          ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
          const textW = ctx.measureText(label).width;
          const lx = Math.max(2, first[0] * canvas.width);
          const ly = Math.max(16, first[1] * canvas.height - 8);
          ctx.globalAlpha = isActive ? 1 : 0.8;
          ctx.fillStyle = color;
          ctx.fillRect(lx - 2, ly - 14, textW + 8, 17);
          ctx.fillStyle = '#09090b';
          ctx.fillText(label, lx + 2, ly - 2);
          ctx.globalAlpha = 1;
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
          <div className="flex aspect-video w-full items-center justify-center text-sm text-zinc-500">
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
          <div className="relative h-6 rounded bg-zinc-900 border border-zinc-800">
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
