import { db } from './db';

/**
 * Server-side app settings, set from /settings and read on demand.
 *
 * The Model API key lives here as well as in the environment so it can be
 * pasted in without rebuilding the container - one row in the same database
 * as everything else, not a file the app has to rewrite under a mount.
 */

/** The one setting this app has today. */
export const API_KEY_SETTING = 'model_api_key';

export function getSetting(key: string): string | null {
  const row = db()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function deleteSetting(key: string): void {
  db().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** The key pasted at /settings, if any - checked before the environment. */
export function storedApiKey(): string | null {
  return getSetting(API_KEY_SETTING);
}
