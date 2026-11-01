'use client';

import { useEffect, useRef } from 'react';
import type { Detection } from '@/lib/types';
import { paintMask } from './mask';

/**
 * The still a queue row promises: the frame the hazard was found on, with the
 * mask SAM drew over it, so a reviewer can judge the hazard before spending a
 * video load on it.
 *
 * Position: fixed, not absolute. The queue scrolls inside an overflow-auto
 * list, and an absolutely positioned child would be clipped by it; fixed is
 * laid out against the viewport, so the popup clears the list entirely. It is
 * still a DOM child of the hovered row, which is what keeps it open while the
 * pointer is over it - moving onto a descendant does not fire mouseleave.
 */
const W = 256;
const H = 144;

type Props = {
  detection: Detection;
  /** Viewport rectangle of the row being hovered; the popup hangs off its edge. */
  rect: { left: number; top: number; width: number };
  onReview: (id: number) => void;
};

export default function StillPopup({ detection, rect, onReview }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Painted on mount rather than on image load: the canvas draws only the
  // polygon, so it does not depend on the still's pixels, and a cached still
  // can already be complete before this effect runs anyway.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    paintMask(ctx, detection, { width: W, height: H, active: true });
  }, [detection]);

  // Prefer hanging off the left of the row (the queue sits on the right of the
  // screen); fall back to the right, then to the viewport edge on narrow ones.
  const left = Math.max(
    8,
    Math.min(rect.left - W - 8, window.innerWidth - W - 8)
  );
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - H - 104));

  return (
    <div
      className="fixed z-50 w-64 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-xl shadow-black/50"
      style={{ left, top }}
    >
      <div className="relative bg-zinc-800">
        <img
          src={`/api/detections/${detection.id}/still`}
          alt=""
          width={W}
          height={H}
          className="block h-36 w-full object-cover"
          onError={(e) => {
            // No playback yet, or the frame could not be cut: keep the box and
            // the mask rather than a broken-image icon.
            e.currentTarget.style.visibility = 'hidden';
          }}
        />
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>
      <div className="px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs capitalize text-zinc-200">
            {detection.hazardType.replace('_', '-')}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">
            sev {detection.severity} · {Math.round(detection.confidence * 100)}%
          </span>
        </div>
        <div className="truncate text-[11px] text-zinc-500">
          {[detection.street, detection.crossStreet].filter(Boolean).join(' @ ') ||
            'location not placed'}
        </div>
        <button
          onClick={() => onReview(detection.id!)}
          className="mt-2 w-full rounded border border-amber-700 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-900/60"
        >
          Review video →
        </button>
      </div>
    </div>
  );
}
