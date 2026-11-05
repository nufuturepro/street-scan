import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  META_API_BASE,
  SAM_MIN_BILLED_FRAMES,
  SAM_USD_PER_1000_FRAMES,
  SPARK_USD_PER_1M_IN,
  SPARK_USD_PER_1M_OUT,
  clientMode,
} from './config';
import type { Classification, HazardType, SamFrame } from './types';
import { HAZARD_TYPES } from './taxonomy';
import { buildFixtureClassification, streamFixtureFrames } from './fixtures';
import { recordSpend } from './spend';
import { storedApiKey } from './settings';

/**
 * The Meta Model API boundary.
 *
 * Everything upstream of this file talks to `MetaClient`. That is the whole
 * reason fixture mode costs nothing to switch on: billing currently returns
 * 402 `billing_not_configured`, so `auto` mode detects that once, remembers
 * it for the process, and serves deterministic recorded responses instead.
 * When billing is fixed, the same code path goes live with no edits.
 *
 * Endpoints (https://dev.meta.ai/docs/api-reference):
 *   POST {base}/files      multipart upload  -> { id }
 *   POST {base}/responses  OpenAI-compatible, supports stream:true
 */

export type SegmentRequest = {
  /** local file to send to SAM */
  filePath: string;
  prompt: string;
  /** global index of this chunk's first frame */
  globalStartFrame: number;
  /** how many frames this chunk covers */
  frameCount: number;
  chunkId: number;
  /** total frames in the whole analysis video, for fixture determinism */
  totalFrames: number;
  /** called once per frame SAM reports */
  onFrame: (f: SamFrame) => void;
  /** called when a frame range is billed, so the tally is honest */
  onBilled?: (frames: number) => void;
  /** audit these frames belong to; the spend row hangs off it */
  jobId?: number;
};

export type ClassifyRequest = {
  cropPath: string;
  framePath: string;
  prompt: string;
  /** used by the fixture path to stay deterministic */
  seed: number;
  /** audit this classification belongs to; the spend row hangs off it */
  jobId?: number;
};

export interface MetaClient {
  readonly mode: 'live' | 'fixture';
  /** why we are not live, when we are not live */
  readonly notice: string | null;
  segment(req: SegmentRequest): Promise<void>;
  classify(req: ClassifyRequest): Promise<Classification>;
}

function apiKey(): string {
  // A key pasted at /settings wins: the user just said so, and making them
  // restart the container to agree with the form would be absurd. The
  // environment stays as the deployment default underneath it.
  const key = storedApiKey()?.trim() || process.env.MODEL_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'MODEL_API_KEY is not set. Copy .env.example to .env, or paste one at /settings.'
    );
  }
  return key;
}

/**
 * Rolling tally so the dashboard can show spend against the $150 credit.
 *
 * SAM and Muse Spark bill on different axes - frames versus tokens - so they
 * are counted separately and summed at the end. Spark's calls used to be
 * invisible here, which made the pill under-report what a run really cost.
 */
const tally = {
  frames: 0,
  requests: 0,
  usd: 0,
  fixtureCalls: 0,
  classCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  classUsd: 0,
};

export function costTally() {
  return { ...tally, totalUsd: tally.usd + tally.classUsd };
}
export function resetTally() {
  tally.frames = 0;
  tally.requests = 0;
  tally.usd = 0;
  tally.fixtureCalls = 0;
  tally.classCalls = 0;
  tally.tokensIn = 0;
  tally.tokensOut = 0;
  tally.classUsd = 0;
}

/**
 * SAM charges the moment the stream bills a range - so the ledger row is
 * written here, at billing time, where a crash, a re-run or a deleted job
 * cannot lose it. `n` is the provider's own usage.video_frames_processed when
 * the response carries it, the chunk's frame count otherwise.
 */
function recordBilled(n: number, jobId: number | undefined, detail: string, onBilled?: (n: number) => void) {
  const billed = Math.max(n, SAM_MIN_BILLED_FRAMES);
  const usd = (billed / 1000) * SAM_USD_PER_1000_FRAMES;
  recordSpend({ jobId, kind: 'sam', frames: billed, usd, detail });
  tally.frames += billed;
  tally.requests += 1;
  tally.usd += usd;
  onBilled?.(billed);
}

type SparkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

/** The real token bill for one classification - ledgered and tallied together. */
function recordClassified(usage: SparkUsage | undefined, jobId: number | undefined, detail: string) {
  const inTok = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0;
  const outTok = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0;
  const usd = (inTok / 1e6) * SPARK_USD_PER_1M_IN + (outTok / 1e6) * SPARK_USD_PER_1M_OUT;
  recordSpend({ jobId, kind: 'spark', tokensIn: inTok, tokensOut: outTok, usd, detail });
  tally.classCalls += 1;
  tally.tokensIn += inTok;
  tally.tokensOut += outTok;
  tally.classUsd += usd;
}

type ApiError = Error & { status?: number; body?: string };

async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: ApiError = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res;
}

function isBillingOrAuthFailure(err: unknown): boolean {
  const e = err as ApiError;
  if (!e?.status) return false;
  if (e.status === 402) return true;
  if (e.status === 401 && /billing|invalid/i.test(e.body ?? '')) return true;
  if (e.body && /billing_not_configured|billing_error/i.test(e.body)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Live client
 * ------------------------------------------------------------------ */

class LiveClient implements MetaClient {
  readonly mode = 'live' as const;
  notice: string | null = null;

  async segment(req: SegmentRequest): Promise<void> {
    // 1. Upload the chunk once; SAM reads it by file id.
    // purpose=user_data is mandatory on POST /v1/files for anything referenced
    // in inference - omitting it 400s with "Missing required multipart field".
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', await fileBlob(req.filePath), path.basename(req.filePath));
    const uploaded = await apiFetch(`${META_API_BASE}/files`, { method: 'POST', body: form });
    const { id: fileId } = (await uploaded.json()) as { id: string };
    if (!fileId) throw new Error('file upload returned no id');

    // 2. Ask for streaming segmentation.
    const res = await apiFetch(`${META_API_BASE}/responses`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'sam-3.1',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_video', file_id: fileId },
              { type: 'input_text', text: req.prompt },
            ],
          },
        ],
      }),
    });

    if (!res.body) throw new Error('responses endpoint returned no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** the provider's own billed count, when the stream reports one */
    let usageFrames = 0;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return;
      const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (payload === '[DONE]') return;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      // The exact frame charge, when the stream says it: the response's
      // usage.video_frames_processed is what Meta bills this request for.
      // Our frame count is only a fallback for a stream that omits it.
      const ev = event as {
        usage?: { video_frames_processed?: number };
        response?: { usage?: { video_frames_processed?: number } };
      };
      const reported = Number(ev.usage?.video_frames_processed ?? ev.response?.usage?.video_frames_processed ?? 0);
      if (Number.isFinite(reported) && reported > usageFrames) usageFrames = reported;
      const delta = (event as { delta?: unknown }).delta;
      const fromText =
        typeof delta === 'string' && delta.includes('<|box;') ? parseSamText(delta) : [];
      for (const frame of fromText.length ? fromText : extractFrames(event)) {
        req.onFrame({
          frameIndex: req.globalStartFrame + frame.frameIndex,
          objectId: frame.objectId,
          score: frame.score,
          polygon: frame.polygon,
        });
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    // SAM bills per video frame processed, not per match: 724 frames cost the
    // same whether 3 or 300 of them matched. The response's own
    // usage.video_frames_processed is authoritative when it arrives; the
    // chunk's frame count is the fallback. The floor still applies.
    // The detail tags which source produced the number - the usage probe and
    // any later audit read it back to know whether parsing worked.
    recordBilled(
      usageFrames > 0 ? usageFrames : req.frameCount,
      req.jobId,
      `chunk ${req.chunkId} / prompt "${req.prompt}" - ${
        usageFrames > 0 ? 'provider usage' : 'frame-count estimate'
      }`,
      req.onBilled
    );
  }

  async classify(req: ClassifyRequest): Promise<Classification> {

    const res = await apiFetch(`${META_API_BASE}/responses`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'muse-spark-1.3',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: dataUrl(req.framePath) },
              { type: 'input_image', image_url: dataUrl(req.cropPath) },
              { type: 'input_text', text: req.prompt },
            ],
          },
        ],
      }),
    });
    const data = (await res.json()) as { output?: unknown; usage?: SparkUsage };
    recordClassified(data.usage, req.jobId, `classify ${path.basename(req.framePath)}`);
    return coerceClassification(data);
  }
}

/**
 * SAM 3.1 streams its result as text records, not JSON objects:
 *
 *   <0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;...|>,1<|box;...|>
 *
 * "<Nf>" opens frame N of the chunk; the comma-separated records after it are
 * one match each - object ordinal, then box, then mask payload. We take the box
 * and expand it to a four-corner polygon normalised to 0..1, which is the shape
 * the filter, the crop and the overlay all already expect. The mask payload is
 * a separate encoding and is left for a later pass; the box carries the
 * detection, the tracking and the IoU.
 */
function parseSamText(text: string): SamFrame[] {
  const out: SamFrame[] = [];
  if (!text || !text.includes('<|box;')) return out;

  const markers: Array<{ frame: number; at: number }> = [];
  const frameRe = /<(\d+)f>/g;
  let m: RegExpExecArray | null;
  while ((m = frameRe.exec(text))) markers.push({ frame: Number(m[1]), at: m.index });
  if (!markers.length) return out;

  const boxRe =
    /(\d+)?<\|box;x1=([-\d.]+);y1=([-\d.]+);x2=([-\d.]+);y2=([-\d.]+);w=([\d.]+);h=([\d.]+)\|>/g;
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].at;
    const end = i + 1 < markers.length ? markers[i + 1].at : text.length;
    const seg = text.slice(start, end);
    boxRe.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = boxRe.exec(seg))) {
      const w = Number(b[6]);
      const h = Number(b[7]);
      if (!w || !h) continue;
      const x1 = clamp(Number(b[2]) / w);
      const y1 = clamp(Number(b[3]) / h);
      const x2 = clamp(Number(b[4]) / w);
      const y2 = clamp(Number(b[5]) / h);
      out.push({
        frameIndex: markers[i].frame,
        objectId: b[1] ? Number(b[1]) : markers[i].frame,
        score: 1,
        polygon: [
          [x1, y1],
          [x2, y1],
          [x2, y2],
          [x1, y2],
        ],
      });
    }
  }
  return out;
}

/** Inline a local image as a base64 data URL - the API takes no local paths. */
function dataUrl(p: string): string {
  const buf = readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

async function fileBlob(p: string): Promise<Blob> {
  const buf = readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase() || 'bin';
  const type = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'video/mp4';
  return new Blob([new Uint8Array(buf)], { type });
}

/**
 * Tolerant reader for SAM's streaming event shapes.
 *
 * The exact event schema is NOT yet verified against a live response - billing
 * is 402 - so this accepts the common shapes rather than betting on one, and
 * silently skips anything it cannot interpret. When the spike finally runs we
 * tighten this to the documented schema and delete the guesswork.
 */
function extractFrames(event: unknown): SamFrame[] {
  const out: SamFrame[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const frameIndex = firstNumber(obj, ['frame_index', 'frameIndex', 'frame', 'index']);
    const objectId = firstNumber(obj, ['object_id', 'objectId', 'id', 'track_id', 'trackId']);
    const polygon = readPolygon(obj);
    if (frameIndex != null && objectId != null && polygon && polygon.length >= 3) {
      out.push({
        frameIndex,
        objectId,
        score: firstNumber(obj, ['score', 'confidence', 'iou']) ?? 1,
        polygon,
      });
      return;
    }
    for (const v of Object.values(obj)) visit(v);
    if (Array.isArray(node)) for (const v of node) visit(v);
  };
  visit(event);
  return out;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function readPolygon(obj: Record<string, unknown>): Array<[number, number]> | null {
  for (const key of ['polygon', 'points', 'mask', 'outline', 'segmentation', 'rle']) {
    const v = obj[key];
    if (Array.isArray(v) && v.length >= 6) {
      // Flat [x0,y0,x1,y1,...] normalized or pixel coords.
      if (typeof v[0] === 'number') {
        const flat = v as number[];
        const max = Math.max(...flat.map(Math.abs));
        const norm = max > 1.5; // pixel coordinates -> normalize later by caller
        const pts: Array<[number, number]> = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          pts.push([flat[i], flat[i + 1]]);
        }
        if (norm) {
          // Without frame dimensions we cannot normalize here; scale to 0..1
          // using the observed maximum so downstream math stays valid.
          const scale = 1 / (max || 1);
          for (const p of pts) {
            p[0] *= scale;
            p[1] *= scale;
          }
        }
        return pts;
      }
      if (typeof v[0] === 'object') {
        const pts: Array<[number, number]> = [];
        for (const item of v as Array<Record<string, unknown>>) {
          const x = firstNumber(item, ['x', '0']);
          const y = firstNumber(item, ['y', '1']);
          if (x != null && y != null) pts.push([x, y]);
        }
        if (pts.length >= 3) return pts;
      }
    }
  }
  return null;
}

function coerceClassification(data: unknown): Classification {
  const text = JSON.stringify(data);
  try {
    const parsed = JSON.parse(text);
    // output[0] is a reasoning item; the answer lives on the message item.
    const items: Array<Record<string, unknown>> = Array.isArray(parsed?.output)
      ? parsed.output
      : [];
    const message = items.find((o) => o && o.type === 'message' && Array.isArray(o.content));
    const parts: Array<Record<string, unknown>> = Array.isArray(message?.content)
      ? message.content
      : [];
    const outputText =
      (parts.find((c) => c && c.type === 'output_text')?.text as string | undefined) ??
      (parsed?.output_text as string | undefined) ??
      parsed?.choices?.[0]?.message?.content;
    if (typeof outputText === 'string') return normalize(JSON.parse(outputText));
  } catch {
    /* fall through to shape-based read */
  }
  return normalize(parsedShape(data));
}

function parsedShape(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const output = Array.isArray(d.output) ? (d.output as Array<Record<string, unknown>>) : [];
  const message = output.find((o) => o && o.type === 'message' && Array.isArray(o.content));
  const parts = Array.isArray(message?.content)
    ? (message.content as Array<Record<string, unknown>>)
    : [];
  if (parts[0] && typeof parts[0] === 'object') return parts[0];
  return d;
}

/**
 * The seam where a model answer becomes a work order. Case, padding and
 * separators are normalised the way models actually emit them; a present-but-
 * unknown answer is a REJECT, not a pothole. The old unknown->'pothole'
 * fallback here is how an intact manhole cover came out of the pipeline as a
 * pothole work order: a fabricated filing is worse than a skipped detection,
 * and the pipeline counts rejects out loud.
 */
/**
 * Map the classifier's words onto the taxonomy.
 *
 * An exact enum match used to be the only thing that survived, and everything
 * else became not_a_defect - so a perfectly good answer worded "Potholes",
 * "alligator crack" or "pothole (sunken)" was silently filed as a refusal.
 * That turned a wording difference into a lost hazard, and it is a large part
 * of why recall looked broken. Now the vocabulary is matched, and a refusal
 * only happens when the answer actually names a non-defect.
 */
const REJECT_WORDS = ['not_a_defect', 'not_a_hazard', 'manhole', 'cover', 'lid', 'valve', 'marking', 'shadow', 'drain', 'intact'];

const TYPE_WORDS: Array<[HazardType, string[]]> = [
  ['cave_in', ['cave', 'sink', 'collapse', 'subsiden']],
  ['pothole', ['pothole', 'pot_hole', 'pit']],
  ['crack', ['crack', 'alligator', 'fissure', 'ravel']],
  ['blocked_lane', ['block', 'obstruct', 'parked', 'encroach']],
  ['debris', ['debris', 'gravel', 'pallet', 'litter', 'spill']],
];

export function normalizeType(v: unknown): HazardType | 'not_a_defect' {
  if (v == null) return 'pothole';
  const requested = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((HAZARD_TYPES as readonly string[]).includes(requested)) {
    return requested as HazardType;
  }
  // A hazard word wins over a reject word: "pothole, not a manhole cover" is
  // still a pothole, and the rubric invites exactly that phrasing.
  for (const [type, words] of TYPE_WORDS) {
    if (words.some((w) => requested.includes(w))) return type;
  }
  if (REJECT_WORDS.some((w) => requested.includes(w))) return 'not_a_defect';
  return 'not_a_defect';
}

function normalize(raw: Record<string, unknown>): Classification {
  const severityRaw = Math.round(Number(raw.severity ?? 3));
  const sc = (raw.streetContext ?? {}) as Record<string, unknown>;
  return {
    hazardType: normalizeType(raw.hazardType ?? raw.hazard_type),
    severity: (Number.isFinite(severityRaw)
      ? Math.min(5, Math.max(1, severityRaw))
      : 3) as Classification['severity'],
    confidence: Math.min(1, Math.max(0, Number(raw.confidence ?? 0.5))),
    justification: String(raw.justification ?? raw.description ?? ''),
    // Why it refused, when it did - 'too_small' is the verdict this app had no
    // way to hear before lib/scale.ts measured the patch for it.
    rejectReason: str(raw.rejectReason ?? raw.reject_reason),
    // Default true: a field the model forgets must not delete every detection.
    onRoadway: parseBool(raw.onRoadway ?? raw.on_roadway, true),
    streetContext: {
      street: str(sc.street ?? raw.street),
      crossStreet: str(sc.crossStreet ?? raw.crossStreet),
      nearestAddress: str(sc.nearestAddress ?? raw.nearestAddress),
      direction: str(sc.direction ?? raw.direction),
    },
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

let fallbackNotice: string | null = null;
let forcedFixture = false;
let probed = false;

/**
 * One probe per process, so `mode` is truthful from the first progress event
 * instead of claiming "live" until the first call happens to fail.
 */
async function ensureProbed(): Promise<void> {
  if (probed) return;
  probed = true;
  const res = await probeLive();
  if (res.detail.includes('402') || /billing/i.test(res.detail)) {
    forcedFixture = true;
    fallbackNotice =
      'Meta Model API returned 402 billing_not_configured - serving recorded fixture responses. ' +
      'Resolve billing at https://dev.meta.ai/billing/ then restart to go live.';
  }
}

function makeFixture(): MetaClient {
  return {
    mode: 'fixture',
    notice: fallbackNotice,
    async segment(req) {
      tally.fixtureCalls += 1;
      const frames = streamFixtureFrames(req);
      for (const f of frames) req.onFrame(f);
      // Fixtures still exercise the billing floor so the cost UI is realistic.
      const billed = Math.max(frames.length, SAM_MIN_BILLED_FRAMES);
      req.onBilled?.(billed);
    },
    classify: async (req) => buildFixtureClassification(req),
  };
}

async function makeLive(): Promise<MetaClient> {
  return new LiveClient();
}

export async function getMetaClient(): Promise<MetaClient> {
  const mode = clientMode();
  if (mode === 'fixture') {
    fallbackNotice = 'META_API_MODE=fixture';
    return makeFixture();
  }
  if (mode === 'live') return makeLive();

  // auto: probe once; if billing blocks us, stay on fixtures for the process.
  await ensureProbed();
  if (forcedFixture) return makeFixture();
  const live = await makeLive();
  return {
    mode: 'live',
    notice: null,
    async segment(req) {
      try {
        return await live.segment(req);
      } catch (err) {
        if (isBillingOrAuthFailure(err)) {
          forcedFixture = true;
          fallbackNotice =
            'Meta Model API returned 402 billing_not_configured - serving recorded fixture responses. ' +
            'Resolve billing at https://dev.meta.ai/billing/ then restart to go live.';
          return makeFixture().segment(req);
        }
        throw err;
      }
    },
    async classify(req) {
      try {
        return await live.classify(req);
      } catch (err) {
        if (isBillingOrAuthFailure(err)) {
          forcedFixture = true;
          fallbackNotice =
            'Meta Model API returned 402 billing_not_configured - serving recorded fixture responses.';
          return makeFixture().classify(req);
        }
        throw err;
      }
    },
  };
}

/** Cheap pre-flight: is billing live yet? Used by the UI status pill. */
export async function probeLive(): Promise<{ ok: boolean; detail: string }> {
  if (clientMode() === 'fixture') return { ok: false, detail: 'fixture mode forced' };
  if (!existsSync('.env') && !process.env.MODEL_API_KEY && !storedApiKey()) {
    return { ok: false, detail: 'MODEL_API_KEY not set' };
  }
  try {
    await apiFetch(`${META_API_BASE}/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'muse-spark-1.3', input: 'ping' }),
    });
    return { ok: true, detail: 'live' };
  } catch (err) {
    const e = err as ApiError;
    if (isBillingOrAuthFailure(err)) {
      return { ok: false, detail: '402 billing_not_configured' };
    }
    return { ok: false, detail: e.message ?? String(err) };
  }
}
