'use client';

import { useEffect, useState } from 'react';
import { HAZARD_TYPES, TAXONOMY } from '@/lib/taxonomy';
import type { Detection, HazardType, Open311Shape } from '@/lib/types';

/** What a reviewer may correct on an entry. See repo.DetectionEdit. */
export type DetectionEditPatch = {
  lat?: number;
  lon?: number;
  street?: string;
  /** null clears a name that is wrong - undefined leaves it alone */
  crossStreet?: string | null;
  hazardType?: HazardType;
  severity?: Detection['severity'];
  /** a rewritten classifier sentence */
  description?: string;
  /** the reviewer's extra detail - '' clears it */
  note?: string;
};

type Props = {
  detection: Detection | null;
  onPatch: (id: number, patch: DetectionEditPatch) => Promise<void>;
};

const SEVERITY_LABELS = ['trivial', 'minor', 'moderate', 'serious', 'critical'];

/**
 * The Open311 payload, live - and the one place a reviewer can correct an
 * entry's *identity*, not just its pin.
 *
 * Shown next to the footage rather than hidden behind an export button, because
 * the payload *is* the product: a municipal work order the city can accept.
 * Everything the reviewer changes - a manual pin, a corrected street, a
 * reclassified hazard - is reflected here immediately.
 *
 * Type and severity are editable because they are what makes a work order
 * wrong in a way a pin fix cannot repair. A manhole the detector called a
 * pothole ships the wrong service code, ranks at the wrong priority, and
 * charges a defect to a street that does not have one.
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
  const [crossStreet, setCrossStreet] = useState(() => detection?.crossStreet ?? '');
  const [description, setDescription] = useState(() => detection?.description ?? '');
  const [note, setNote] = useState(() => detection?.note ?? '');
  const [hazardType, setHazardType] = useState<HazardType | ''>(
    () => detection?.hazardType ?? ''
  );
  const [severity, setSeverity] = useState<Detection['severity'] | ''>(
    () => detection?.severity ?? ''
  );
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  // Bumped after a save so the payload below re-reads from the server: the
  // form is the input, the JSON is the artefact, and a corrected entry that
  // still showed the old service code would be lying about what was applied.
  const [version, setVersion] = useState(0);

  const detectionId = detection?.id;
  useEffect(() => {
    if (!detectionId) return;
    let alive = true;
    fetch(`/api/detections/${detectionId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { workOrder?: Open311Shape } | null) => {
        if (alive && data?.workOrder) setPayload(data.workOrder);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [detectionId, version]);

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

  const rejected = detection.reviewStatus === 'rejected';

  const save = async () => {
    const next: DetectionEditPatch = {};
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (lat && Number.isFinite(parsedLat)) next.lat = parsedLat;
    if (lon && Number.isFinite(parsedLon)) next.lon = parsedLon;
    if (street.trim() && street.trim() !== detection.street) next.street = street.trim();
    // Cross street is compared, not just checked: blanking a wrong name is a
    // correction too, so an empty box that used to hold one sends null. An
    // untouched empty box sends nothing.
    const cross = crossStreet.trim();
    if (cross !== (detection.crossStreet ?? '')) next.crossStreet = cross || null;
    // Type and severity only when changed, so a plain pin correction does not
    // rewrite the classification columns (and their service code) as a side
    // effect of clicking Save.
    if (hazardType && hazardType !== detection.hazardType) next.hazardType = hazardType;
    if (severity && severity !== detection.severity) next.severity = severity;
    // Both texts are compared, not just checked for content: a reviewer who
    // deletes a wrong sentence has to be able to save that, and an untouched
    // box sends nothing.
    const desc = description.trim();
    if (desc !== detection.description) next.description = desc;
    const noteText = note.trim();
    if (noteText !== (detection.note ?? '')) next.note = noteText;

    if (!Object.keys(next).length) return;
    await onPatch(detection.id!, next);
    setVersion((v) => v + 1);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  const field = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs';

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

      {rejected && (
        <p className="border-b border-red-900 bg-red-950/50 px-3 py-2 text-[11px] text-red-300">
          Marked <strong>not a hazard</strong>. It is out of the grades,
          corroboration and every export until you restore it.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 px-3 py-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Hazard type</span>
          <select
            value={hazardType}
            onChange={(e) => setHazardType(e.target.value as HazardType)}
            className={field}
          >
            {HAZARD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TAXONOMY[t].label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Severity</span>
          <select
            value={severity}
            onChange={(e) =>
              setSeverity(Number(e.target.value) as Detection['severity'])
            }
            className={field}
          >
            {[1, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>
                {s} - {SEVERITY_LABELS[s - 1]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Priority</span>
          <div className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs tabular-nums text-zinc-400">
            {detection.priority} · {detection.serviceCode}
          </div>
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Latitude</span>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="—"
            className={`${field} tabular-nums`}
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Longitude</span>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="—"
            className={`${field} tabular-nums`}
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Street</span>
          <input
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            placeholder="—"
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Cross street</span>
          <input
            value={crossStreet}
            onChange={(e) => setCrossStreet(e.target.value)}
            placeholder="—"
            className={field}
          />
        </label>

        {/*
          The two texts a city actually reads. `description` starts as the
          classifier's sentence and is editable, because a reviewer looking at
          the frame knows more than the model did. `note` is theirs alone -
          kept separate so the record never mixes what a model said with what
          a person added.
        */}
        <label className="col-span-3 block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Description (goes into the work order)
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="what the classifier said - rewrite it if it is wrong"
            className={`${field} resize-y leading-relaxed`}
          />
        </label>
        <label className="col-span-3 block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Reviewer note (extra detail for the crew)
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="access, surrounding damage, what the classifier missed - appended to the description"
            className={`${field} resize-y leading-relaxed`}
          />
        </label>
        <div className="col-span-2 flex items-end justify-end gap-2">
          <span className="mr-auto text-[10px] leading-tight text-zinc-500">
            Type and severity set the service code, priority and street grade.
          </span>
          <button
            onClick={save}
            className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-amber-500 hover:text-amber-300"
          >
            {saved ? 'Applied' : 'Apply corrections'}
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
