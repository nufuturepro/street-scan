'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type KeyView = { source: 'stored' | 'env' | null; masked: string | null };
type Status = { mode: string; live: { ok: boolean; detail: string } };

/**
 * Paste the Model API key without rebuilding the container.
 *
 * The key is stored server-side (a row in the same SQLite database as the
 * audits) and is never read back - GET reports only where a key came from
 * and its last four characters. The draft field is cleared after every save
 * so the value cannot linger in the DOM.
 */
export default function SettingsClient() {
  const [key, setKey] = useState<KeyView | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([
        fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setKey((k as { modelApiKey: KeyView }).modelApiKey);
      setStatus(s as Status);
    } catch {
      /* server not up yet */
    }
  }, []);

  useEffect(() => {
    // Deferred so the first fetch does not cascade a render during commit -
    // the same shape the dashboard's initial load uses.
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const save = async (clear: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clear ? { clear: true } : { modelApiKey: draft }),
      });
      const body = (await res.json()) as { modelApiKey?: KeyView; error?: string };
      if (!res.ok || !body.modelApiKey) throw new Error(body.error ?? `HTTP ${res.status}`);
      setKey(body.modelApiKey);
      setDraft('');
      setMessage(
        clear
          ? 'Cleared — the container environment (if any) is in effect again.'
          : 'Saved — applies from the next API call; the status badge refreshes within a minute.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const live = status?.live.ok ?? false;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-amber-400">
          ← back to Dispatch
        </Link>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Model API key
        </h2>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              key?.source ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
          />
          {key?.source === 'stored' && (
            <span className="text-zinc-300">
              Pasted here <span className="font-mono text-zinc-500">{key.masked}</span>
            </span>
          )}
          {key?.source === 'env' && (
            <span className="text-zinc-300">
              From the container environment <span className="font-mono text-zinc-500">{key.masked}</span>
            </span>
          )}
          {!key?.source && <span className="text-amber-400">Not set — audits run on recorded fixtures.</span>}
        </div>

        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="paste a new key"
            autoComplete="off"
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="rounded border border-amber-700 bg-amber-950/70 px-3 py-1.5 text-xs text-amber-300 hover:border-amber-500 disabled:opacity-40"
          >
            Save
          </button>
          {key?.source === 'stored' && (
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 disabled:opacity-40"
              title="forget the pasted key and fall back to the environment"
            >
              Clear
            </button>
          )}
        </form>

        {message && <p className="mt-2 text-xs text-emerald-400">{message}</p>}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <p className="mt-3 border-t border-zinc-800 pt-2.5 text-[11px] leading-relaxed text-zinc-600">
          Stored server-side in this install&apos;s database and sent only to this
          server — it is never rendered back to the browser. This deployment has
          no login and listens on your LAN: anyone who can reach this page can
          change the key.
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          API status
        </h2>
        {status ? (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 ${
                live
                  ? 'border-emerald-700 bg-emerald-950 text-emerald-300'
                  : 'border-amber-700 bg-amber-950 text-amber-300'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              {live ? 'live API' : 'fixtures'}
            </span>
            <span className="text-zinc-500">{status.live.detail}</span>
            <span className="ml-auto text-zinc-600">mode: {status.mode}</span>
          </div>
        ) : (
          <p className="mt-2 text-xs text-zinc-600">checking…</p>
        )}
        <p className="mt-2.5 border-t border-zinc-800 pt-2.5 text-[11px] leading-relaxed text-zinc-600">
          <code className="text-zinc-500">META_API_MODE</code> decides the world
          the pipeline runs in: <code className="text-zinc-500">auto</code>{' '}
          (default) probes the key once and falls back to recorded fixtures when
          billing blocks the call; <code className="text-zinc-500">fixture</code>{' '}
          never calls the API; <code className="text-zinc-500">live</code> always
          does. Set it in <code className="text-zinc-500">.env</code>.
        </p>
      </div>
    </div>
  );
}
