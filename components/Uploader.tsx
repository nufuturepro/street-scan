'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Raw streamed upload with progress.
 *
 * XMLHttpRequest, not fetch: fetch still has no reliable upload progress
 * event, and a 10-minute 4K clip is exactly the case where a dead progress
 * bar makes people close the tab.
 *
 * Two requests: the footage first (that creates the job), then - only if the
 * picker was used - the original recording for its GPS track, because the flattened
 * export carries none. A failed attach still navigates: no GPS is a
 * manual pin, not a dead job.
 */
export default function Uploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [phase, setPhase] = useState<'footage' | 'gps'>('footage');
  const [source, setSource] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setPhase('footage');
    setPct(0);

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.mp4';
    const url = `/api/jobs?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ''))}&ext=${encodeURIComponent(ext)}`;

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
        if (source) uploadGps(res.id, () => router.push(`/inspect/${res.id}`));
        else router.push(`/inspect/${res.id}`);
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
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-amber-400 bg-amber-950/30'
            : 'border-zinc-700 bg-zinc-900/50 hover:border-zinc-500'
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
        <span className="text-sm text-zinc-300">{status}</span>
        <span className="text-xs text-zinc-500">
          MP4 or MOV · flattened from your original recording
        </span>
        {pct !== null && (
          <div className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-amber-400 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </label>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
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
          <span className="text-emerald-400">✓ GPS source attached · {source.name}</span>
        ) : (
          <span>+ Attach the original recording for GPS — flattening drops it</span>
        )}
      </label>
      {error && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
