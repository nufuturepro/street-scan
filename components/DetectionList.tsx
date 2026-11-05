'use client';

import type { Detection } from '@/lib/types';

const SEVERITY_LABELS = ['trivial', 'minor', 'moderate', 'serious', 'critical'];

type Props = {
  detections: Detection[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onStatus: (id: number, status: Detection['reviewStatus']) => void;
};

function Flag({ tone, children }: { tone: 'amber' | 'red' | 'zinc'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-gold/40 bg-gold/10 text-gold'
      : tone === 'red'
        ? 'border-bad/40 bg-bad/10 text-bad'
        : 'border-line bg-surface2 text-muted';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

/**
 * Right-hand inspection list.
 *
 * Everything that would make a work order wrong is surfaced as a visible flag
 * rather than silently resolved: low confidence, a street name that contradicts
 * OpenStreetMap, a missing GPS fix. The reviewer is the verification step, and
 * a reviewer who cannot see the doubt is not verifying anything.
 */
export default function DetectionList({ detections, activeId, onSelect, onStatus }: Props) {
  if (!detections.length) {
    return (
      <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
        No hazards detected yet.
        <br />
        Masks appear here as each chunk finishes.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {detections.map((d) => {
        const active = d.id === activeId;
        return (
          <li key={d.id}>
            <div
              onClick={() => onSelect(d.id!)}
              className={`cursor-pointer rounded-lg border px-3 py-2.5 transition-colors ${
                active
                  ? 'border-gold bg-surface2'
                  : 'border-line bg-surface/60 hover:border-line'
              } ${d.reviewStatus === 'rejected' ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`sev-${d.severity} inline-flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold text-bg`}
                  title={SEVERITY_LABELS[d.severity - 1]}
                >
                  {d.severity}
                </span>
                <span className="flex-1 truncate text-sm font-medium capitalize">
                  {d.hazardType.replace('_', '-')}
                </span>
                <span className="text-[11px] tabular-nums text-muted">
                  {(d.confidence * 100).toFixed(0)}%
                </span>
              </div>

              <div className="mt-1.5 text-xs text-muted">
                {d.street ?? 'street unknown'}
                {d.crossStreet ? ` @ ${d.crossStreet}` : ''}
                <span className="text-muted2"> · {(d.tMs / 1000).toFixed(1)}s</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {d.reviewStatus === 'rejected' && <Flag tone="red">not a hazard</Flag>}
                {d.needsReview && d.reviewStatus !== 'rejected' && (
                  <Flag tone="amber">needs review</Flag>
                )}
                {d.note && <Flag tone="zinc">note</Flag>}
                {d.tooSmall && d.reviewStatus !== 'rejected' && (
                  <Flag tone="amber">too small</Flag>
                )}
                {(d.mergedIds?.length ?? 0) > 0 && (
                  <Flag tone="zinc">{d.mergedIds!.length + 1} sightings</Flag>
                )}
                {d.osmDisagrees && <Flag tone="red">map disagrees</Flag>}
                {(d.lat == null || d.lon == null) && <Flag tone="red">no geo</Flag>}
                <Flag tone="zinc">{d.priority}</Flag>
                <Flag tone="zinc">{d.serviceCode}</Flag>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStatus(d.id!, 'verified');
                  }}
                  disabled={d.reviewStatus !== 'detected'}
                  className="rounded border border-line px-2 py-1 text-[11px] text-ink/90 hover:border-good/60 hover:text-good disabled:opacity-35 disabled:pointer-events-none"
                >
                  {d.reviewStatus === 'detected' || d.reviewStatus === 'rejected'
                    ? 'Verify'
                    : 'Verified'}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStatus(d.id!, 'filed');
                  }}
                  disabled={d.reviewStatus === 'filed' || d.reviewStatus === 'rejected'}
                  className="rounded border border-gold/40 bg-gold/10 px-2 py-1 text-[11px] text-gold hover:bg-gold/15 disabled:opacity-35 disabled:pointer-events-none"
                >
                  {d.reviewStatus === 'filed' ? 'Filed' : 'File work order'}
                </button>
                {/*
                  Undo, not a status cycle: Verify and File are one-way in
                  practice until this button existed, so a misclick on the
                  wrong row was permanent. Both land back on 'detected'.
                */}
                {(d.reviewStatus === 'verified' || d.reviewStatus === 'filed') && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatus(d.id!, 'detected');
                    }}
                    title="walk the status back to detected"
                    className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-raised hover:text-ink"
                  >
                    Undo
                  </button>
                )}
                {/*
                  The false-positive verdict. A rejected row keeps its still
                  and its footage - rejecting is a decision, not a delete -
                  but it leaves the grades, the corroboration and the export.
                */}
                {d.reviewStatus === 'rejected' ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatus(d.id!, 'detected');
                    }}
                    title="put this hazard back in the queue"
                    className="rounded border border-line px-2 py-1 text-[11px] text-ink/90 hover:border-good/60 hover:text-good"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatus(d.id!, 'rejected');
                    }}
                    title="not a real hazard - drop it from grades and exports"
                    className="rounded border border-bad/40 px-2 py-1 text-[11px] text-bad hover:bg-bad/10"
                  >
                    Not a hazard
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
