import { API_KEY_SETTING, deleteSetting, setSetting, storedApiKey } from '@/lib/settings';

export const dynamic = 'force-dynamic';

type KeyView = { source: 'stored' | 'env' | null; masked: string | null };

/**
 * The Model API key's *status*, never the key.
 *
 * This response is read by the browser: it says where a key came from
 * (pasted at /settings, or the container's environment) and shows only the
 * first four and last four characters, which is enough to tell two keys
 * apart and not enough to use one.
 */
function view(): { modelApiKey: KeyView } {
  const stored = storedApiKey();
  const env = process.env.MODEL_API_KEY?.trim() || null;
  const key = stored || env;
  return {
    modelApiKey: {
      source: key ? (stored ? 'stored' : 'env') : null,
      masked: key ? (key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••') : null,
    },
  };
}

export async function GET() {
  return Response.json(view());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    modelApiKey?: string;
    clear?: boolean;
  } | null;
  if (!body) return Response.json({ error: 'expected a JSON body' }, { status: 400 });

  if (body.clear) {
    deleteSetting(API_KEY_SETTING);
    return Response.json(view());
  }

  const key = body.modelApiKey?.trim();
  if (!key) return Response.json({ error: 'the key is empty' }, { status: 400 });
  if (key.length > 4096) {
    return Response.json({ error: 'that is implausibly long for an API key' }, { status: 400 });
  }
  setSetting(API_KEY_SETTING, key);
  return Response.json(view());
}
