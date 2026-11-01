import type { Detection } from '@/lib/types';

/** Severity ramp, used everywhere a hazard is badged or masked. */
export const SEVERITY_COLORS: Record<number, string> = {
  1: '#71717a',
  2: '#0ea5e9',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

/**
 * Draw one hazard's polygon and label onto a canvas.
 *
 * Shared by the video overlay and the queue's still preview: both show the
 * same normalized polygon over the same framing, so two copies of this would
 * only be two chances to drift apart. Coordinates are 0..1 relative to the
 * frame, so the caller passes the canvas size it wants them mapped onto.
 */
export function paintMask(
  ctx: CanvasRenderingContext2D,
  d: Detection,
  opts: { width: number; height: number; active?: boolean }
): void {
  if (!d.polygon || d.polygon.length < 3) return;
  const { width, height, active = false } = opts;
  const color = SEVERITY_COLORS[d.severity] ?? '#f59e0b';

  ctx.beginPath();
  d.polygon.forEach(([x, y], i) => {
    const px = x * width;
    const py = y * height;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.globalAlpha = active ? 0.42 : 0.22;
  ctx.fill();
  ctx.globalAlpha = active ? 1 : 0.65;
  ctx.strokeStyle = color;
  ctx.lineWidth = active ? 3 : 2;
  ctx.stroke();

  const first = d.polygon[0];
  const label = `${d.hazardType.replace('_', '-')}  S${d.severity}`;
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  const textW = ctx.measureText(label).width;
  const lx = Math.max(2, first[0] * width);
  const ly = Math.max(16, first[1] * height - 8);
  ctx.globalAlpha = active ? 1 : 0.8;
  ctx.fillStyle = color;
  ctx.fillRect(lx - 2, ly - 14, textW + 8, 17);
  ctx.fillStyle = '#09090b';
  ctx.fillText(label, lx + 2, ly - 2);
  ctx.globalAlpha = 1;
}
