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
    <div className="mx-auto max-w-3xl px-4 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Link href="/" className="text-xs text-muted hover:text-accent">
          ← back to Dispatch
        </Link>
      </div>

      <div className="panel p-4">
        <h2 className="label">
          Model API key
        </h2>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              key?.source ? 'bg-good' : 'bg-gold'
            }`}
          />
          {key?.source === 'stored' && (
            <span className="text-ink/90">
              Pasted here <span className="font-mono text-muted">{key.masked}</span>
            </span>
          )}
          {key?.source === 'env' && (
            <span className="text-ink/90">
              From the container environment <span className="font-mono text-muted">{key.masked}</span>
            </span>
          )}
          {!key?.source && <span className="text-gold">Not set — audits run on recorded fixtures.</span>}
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
            className="min-w-0 flex-1 rounded border border-line bg-bg px-2.5 py-1.5 font-mono text-sm text-ink placeholder:text-muted2 focus:border-gold/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="rounded border border-gold/40 bg-gold/15 px-3 py-1.5 text-xs text-gold hover:border-accent disabled:opacity-40"
          >
            Save
          </button>
          {key?.source === 'stored' && (
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy}
              className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:border-raised disabled:opacity-40"
              title="forget the pasted key and fall back to the environment"
            >
              Clear
            </button>
          )}
        </form>

        {message && <p className="mt-2 text-xs text-good">{message}</p>}
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}

        <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-muted2">
          Stored server-side in this install&apos;s database and sent only to this
          server — it is never rendered back to the browser. This deployment has
          no login and listens on your LAN: anyone who can reach this page can
          change the key.
        </p>
      </div>

      <div className="mt-4 panel p-4">
        <h2 className="label">
          API status
        </h2>
        {status ? (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 ${
                live
                  ? 'border-good/40 bg-good/10 text-good'
                  : 'border-gold/40 bg-gold/10 text-gold'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-good' : 'bg-gold'}`} />
              {live ? 'live API' : 'fixtures'}
            </span>
            <span className="text-muted">{status.live.detail}</span>
            <span className="ml-auto text-muted2">mode: {status.mode}</span>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted2">checking…</p>
        )}
        <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-muted2">
          <code className="text-muted">META_API_MODE</code> decides the world
          the pipeline runs in: <code className="text-muted">auto</code>{' '}
          (default) probes the key once and falls back to recorded fixtures when
          billing blocks the call; <code className="text-muted">fixture</code>{' '}
          never calls the API; <code className="text-muted">live</code> always
          does. Set it in <code className="text-muted">.env</code>.
        </p>
      </div>
    </div>
  );
}
