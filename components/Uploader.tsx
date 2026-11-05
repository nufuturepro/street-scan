'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

/**
 * Raw streamed upload with progress.
 *
 * XMLHttpRequest, not fetch: fetch still has no reliable upload progress
 * event, and a 10-minute 4K clip is exactly the case where a dead progress
 * bar makes people close the tab.
 *
 * Two requests: the footage first (that creates the job), then - only if the
 * picker was used - the original recording for its GPS track, because the flattened
 * export carries none. A failed attach still queues the scan: no GPS is a
 * manual pin, not a dead job.
 *
 * The scan itself starts server-side on ingest (autostart), so the page does
 * not navigate away and does not hold a stream open. When a GPS source is
 * staged, the footage upload sends autostart=0 and the GPS upload enqueues
 * instead - otherwise the pipeline would read GPS before it finished landing.
 */
export default function Uploader({ compact = false }: { compact?: boolean } = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [phase, setPhase] = useState<'footage' | 'gps'>('footage');
  const [source, setSource] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ id: number; deferred: boolean } | null>(null);

  const uploadGps = (id: number, done: () => void) => {
    const file = source;
    if (!file) {
      done();
      return;
    }
    setPhase('gps');
    setPct(0);

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.insv';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/jobs?id=${id}&role=gps&ext=${encodeURIComponent(ext)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    // The GPS call enqueues the scan whether it lands or fails, so either way
    // the job is moving - report it and let the audits list show the rest.
    xhr.onload = () => {
      setPct(null);
      done();
    };
    xhr.onerror = () => {
      setPct(null);
      done();
    };
    xhr.send(file);
  };

  const upload = (file: File) => {
    setError(null);
    setQueued(null);
    setPhase('footage');
    setPct(0);

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.mp4';
    // A staged GPS source means a second upload is coming; hold the scan until
    // it lands so the pipeline reads the original recording, not the flattened one.
    const autostart = source ? '0' : '1';
    const url = `/api/jobs?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ''))}&ext=${encodeURIComponent(ext)}&autostart=${autostart}`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => {
      setError('Upload failed. Is the dev server still running?');
      setPct(null);
    };
    xhr.onload = () => {
      setPct(null);
      try {
        const res = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) {
          setError(res.error ?? `Upload failed (${xhr.status})`);
          return;
        }
        if (source) {
          uploadGps(res.id, () =>
            setQueued({ id: res.id, deferred: true })
          );
        } else {
          setQueued({ id: res.id, deferred: false });
        }
      } catch {
        setError('Could not read server response.');
      }
    };
    xhr.send(file);
  };

  const status =
    pct === null
      ? 'Drop a clip here, or click to choose'
      : phase === 'gps'
        ? `Attaching GPS source… ${pct}%`
        : `Uploading… ${pct}%`;
  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) upload(f);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 text-center cursor-pointer transition-colors ${
          compact ? 'py-8' : 'py-12'
        } ${
          dragging
            ? 'border-gold bg-gold/10'
            : 'border-line bg-surface/50 hover:border-raised'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.m4v,video/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = '';
          }}
        />
        <span className="text-sm text-ink/90">{status}</span>
        <span className="text-xs text-muted">MP4 or MOV</span>
        {pct !== null && (
          <div className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-surface2">
            <div
              className="h-full bg-gold transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </label>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted transition-colors hover:text-ink">
        <input
          type="file"
          accept=".insv,.mp4,.mov,video/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setSource(f);
            e.target.value = '';
          }}
        />
        {source ? (
          <span className="text-good">✓ GPS source attached · {source.name}</span>
        ) : (
          <span>+ Attach the original recording for GPS — flattening drops it</span>
        )}
      </label>
      {error && (
        <p className="mt-3 text-sm text-bad" role="alert">
          {error}
        </p>
      )}        {queued && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-sm text-good">
          <span>
            #{queued.id} queued — scanning starts in the background. You can
            upload more while it runs.
          </span>
          <Link
            href={`/inspect/${queued.id}`}
            className="text-gold hover:text-gold"
          >
            Watch it →
          </Link>
          {!compact && (
            <Link href="/" className="text-muted hover:text-ink/90">
              (stay here)
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
