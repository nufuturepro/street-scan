'use client';

import { useEffect, useState } from 'react';
import type { Detection, Open311Shape } from '@/lib/types';

type Props = {
  detection: Detection | null;
  onPatch: (
    id: number,
    patch: { lat?: number; lon?: number; street?: string }
  ) => Promise<void>;
};

/**
 * The Open311 payload, live.
 *
 * Shown next to the footage rather than hidden behind an export button, because
 * the payload *is* the product: a municipal work order the city can accept.
 * Everything the reviewer changes - a manual pin, a corrected street - is
 * reflected here immediately.
 */
export default function WorkOrderPanel({ detection, onPatch }: Props) {
  // The parent keys this component on the detection id, so the drafts reset on
  // selection instead of needing an effect to copy props into state.
  const [payload, setPayload] = useState<Open311Shape | null>(null);
  const [lat, setLat] = useState(() =>
    detection?.lat != null ? detection.lat.toFixed(6) : ''
  );
  const [lon, setLon] = useState(() =>
    detection?.lon != null ? detection.lon.toFixed(6) : ''
  );
  const [street, setStreet] = useState(() => detection?.street ?? '');
  const [copied, setCopied] = useState(false);

  const detectionId = detection?.id;
  useEffect(() => {
    if (!detectionId) return;
    let alive = true;
    fetch(`/api/detections/${detectionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { workOrder?: Open311Shape } | null) => {
        if (alive && data?.workOrder) setPayload(data.workOrder);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [detectionId]);

  if (!detection) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">
        Select a hazard to assemble its work order.
      </div>
    );
  }

  const copy = async () => {
    if (!payload) return;
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const save = () => {
    const next: { lat?: number; lon?: number; street?: string } = {};
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (lat && Number.isFinite(parsedLat)) next.lat = parsedLat;
    if (lon && Number.isFinite(parsedLon)) next.lon = parsedLon;
    if (street.trim()) next.street = street.trim();
    if (Object.keys(next).length) void onPatch(detection.id!, next);
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Open311 work order
        </span>
        <div className="flex gap-2">
          <button
            onClick={copy}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500"
          >
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-3 py-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Latitude</span>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="—"
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs tabular-nums"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Longitude</span>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="—"
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs tabular-nums"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Street</span>
          <input
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            placeholder="—"
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
          />
        </label>
        <div className="col-span-3 flex justify-end">
          <button
            onClick={save}
            className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-amber-500 hover:text-amber-300"
          >
            Apply corrections
          </button>
        </div>
      </div>

      <pre className="max-h-72 overflow-auto border-t border-zinc-800 bg-zinc-950 px-3 py-3 text-[11px] leading-relaxed text-emerald-200/90">
        {payload ? JSON.stringify(payload, null, 2) : 'loading…'}
      </pre>

      <p className="border-t border-zinc-800 px-3 py-2 text-[10px] text-zinc-500">
        Assembled, not submitted. Filing against a live 311 endpoint needs a jurisdiction
        account and that city&apos;s real service codes.
      </p>
    </div>
  );
}
