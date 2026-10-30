# StreetScan

Automated urban hazard & infrastructure auditor.

StreetScan turns passive footage — dashcam, handlebar camera, action cam — into **verified,
geo-tagged municipal work orders**. It segments every frame with SAM 3.1, discards anything
not persistent enough to be a real hazard, tags each survivor with the camera's own GPS, then
asks Muse Spark what the thing actually *is* and assembles an Open311 payload.

```
original ──exiftool──► GPS samples {t, lat, lon}        (recorded in-camera at capture)
  └ no track ──ffmpeg + OCR──► the same samples, read back out of the
                               text an app burned into the frame
  └─flatten to MP4──► footage.mp4
        │
   [ffmpeg] ──► playback.mp4 (720p@30)  +  analysis.mp4 (480p@10)
   │             both start at t=0, so hazardTime = frameIndex / 10 → playback.currentTime
   [chunker] windows of 3,000 frames with 150 frames of overlap
   [SAM 3.1]  "pothole" → {frameIndex, objectId, polygon}
   [filter]   ≥6 frames AND ≥0.6s → keep · IoU merge across the chunk seam
   [geo]      interpolate → GPS sample | null → overlay OCR | manual pin
   [consensus] across audits → same defect seen twice → corroborated · disputed
   [Spark]    crop + full frame → {hazardType, severity, confidence, streetContext}
   [OSM]      Overpass reverse-geocode → validate the OCR'd street name, disagree → flag
   [Open311]  → SQLite → split-screen inspection UI → dispatch dashboard
```

## The one architectural claim

**SAM detects generically; Muse Spark classifies specifically.**

SAM gets a single durable noun phrase for the whole taxonomy. It produces pixel-accurate
masks but has no idea what it is looking at — a shallow pothole and a collapsed cave-in both
read as a dark hole in pavement. Muse Spark sees the masked crop *and* the full frame, and
makes the pothole-vs-cave-in call, because that depends on depth, edge condition, surrounding
context and street signs that a segmentation model is never asked to reason about.

The payoff: one segmentation pass instead of one per hazard class, and a taxonomy you can
extend by editing [`data/service-codes.json`](data/service-codes.json) and
[`lib/taxonomy.ts`](lib/taxonomy.ts) without re-running any video.

## Setup

```bash
npm install
cp .env.example .env        # set MODEL_API_KEY
npm run dev                 # http://localhost:3000
```

Requires **ffmpeg/ffprobe** on PATH (`winget install Gyan.FFmpeg`), or set `FFMPEG_PATH` /
`FFPROBE_PATH`. Nothing else is needed — storage is SQLite via Node's built-in `node:sqlite`,
the map is Leaflet with OpenStreetMap tiles (no API keys).

A clip whose GPS is burned into the picture instead of tracked needs `tesseract.js`, which
fetches its English language data once (needs the network that one time) and caches it in
`storage/tesseract/`, a mounted volume, so no container restart refetches it.

## ⚠️ Billing status: running on fixtures

Your Meta Model API key currently returns:

```json
{"code":"billing_not_configured","message":"To use this API key, your team needs to
resolve a billing issue first."}
```

So `META_API_MODE=auto` (the default) probes once, detects the 402, and serves
**deterministic recorded responses** instead. The header pill shows `fixtures` — it is never
hidden, because a judge who assumes the masks are live when they are not has been misled.

Fix it at https://dev.meta.ai/billing/?team_id=2138064107073975 and restart. The same code
path then goes live with no edits: set `META_API_MODE=live` to force it, `fixture` to stay off.

The fixtures are deliberately adversarial — persistent hazards that must survive the filter,
2–4 frame flickers that must die, and **object IDs that differ in each overlapping chunk**
(matching Meta's documented "IDs are not stable across responses") so the boundary merge has
to actually work.

## Verify

```bash
npx tsc --noEmit          # types
npm run lint              # lint
npm run build             # build
npm run verify            # behaviour: 154 assertions across four verify scripts
```

`npm run verify` compiles the four `scripts/verify-*.ts` files to `.verify/`
(gitignored) and runs them in sequence, stopping at the first failure: a failing assertion exits
non-zero, so the command is safe to wire into CI or a pre-commit hook. Plain
`node scripts/*.ts` does not work - Node's type stripping does not resolve this project's
extensionless imports.

The filter script runs the temporal filter against hand-built cases and asserts the three things
most likely to be wrong: transients are killed by frame count, codec-noise bursts are killed by
duration, and a hazard straddling a chunk seam arrives as two different object IDs and is
re-joined into one track without welding distinct hazards together.

The RQSI script is the contract for route grading - splitting, snapping, the grade rubric, the
index arithmetic, and the real audit. It asserts the cases a browser pass never catches: a track
that is an exact multiple of the window (float drift used to split a 25 m road into two halves),
a pin just outside the snap radius, every red/yellow/green boundary in the rubric, the index
clamp, and the 78 m audit reproducing 3 smooth / 1 hazardous at RQSI 75.

The overlay script is the contract for reading GPS out of the picture: the real lines off the
dashcam clip parse to the coordinates the clip shows, OCR damage (an eaten colon, a missing
space) is tolerated, a fused decimal and an out-of-range value are rejected rather than
believed, and a fix that leaves the route and comes straight back is dropped as a misread
while a genuine shift is kept.

The consensus script is the contract for what one audit learns from another:
two passes agreeing on a defect, two passes calling it different things, and -
the case the whole design turns on - a 10 m chain of detections from one audit
that must never weld a single drive into one hazard. It also pins the merging
arithmetic: the worse grade wins, shared metres count once (the same 50 m
street reads 50 m unmerged 100 m), and two sightings of one pothole are one
defect.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/jobs?name=&ext=` | raw streamed upload (no multipart buffering — a 10-minute 4K clip would otherwise take the dev server down) |
| `POST /api/jobs/:id/process` | runs the pipeline, streams SSE progress |
| `GET /api/jobs/:id` | job + detections + counts + GPS + cost |
| `PATCH /api/detections/:id` | the human verification step: status, manual pin, street correction |
| `GET /api/jobs/:id/export?format=` | `csv` · `geojson` · `open311` |
| `GET /api/files/:id/:name` | Range-aware video streaming (206) so scrubbing works |
| `GET /api/status` | live-vs-fixture, billing state, spend against the $150 credit |

## Cost control

SAM bills per video frame: **$0.20 / 1,000 frames**. That is why the pipeline transcodes a
separate 10fps analysis copy — a 10-minute drive is 6,000 frames instead of 18,000, about
$1.20 rather than $3.60, and a pothole is still on screen for 10–20 frames, which is far more
than the persistence filter needs.

The spend readout in the header is the real tally from `lib/meta.ts`, not a projection.

## Assumptions still open

1. **SAM processes an uploaded video at its native frame rate.** If the spike disproves this,
   set `ANALYSIS_FPS = PLAYBACK_FPS` in [`lib/config.ts`](lib/config.ts) and nothing else
   changes. This is the single switch the whole transcoding design hangs on.
2. **SAM's streaming event schema.** Unverifiable while billing returns 402, so
   `extractFrames()` in [`lib/meta.ts`](lib/meta.ts) accepts the common shapes rather than
   betting on one. Tighten it to the documented schema once a live call succeeds.
3. **Open311 service codes are jurisdiction-specific.** `data/service-codes.json` ships a
   placeholder profile. Payloads are assembled and exported, never POSTed — filing against a
   live 311 endpoint needs a city account and that city's real `/services` catalog.

## Capturing footage

Some action cameras have **no GPS in the camera body**. To get coordinates into the pipeline:

1. Enable **GPS capture** in the camera’s companion app before you record — camera
   connected, app open, screen on.
2. The GPS lands **inside the original recording file** on the card. That file is the only
   copy of the track, so keep it.
3. Flatten the original to a plain MP4 with the camera vendor’s desktop app, **keeping the
   original**: **the exported MP4 contains no GPS at all.** StreetScan reads the track out
   of the original with exiftool.
4. If there is no GPS, detections get `lat: null` and the pipeline never blocks — you place
   the pin by hand in the work-order panel.

## Not built (deliberately)

Live streaming capture, POSTing to a real municipal API, multi-user accounts, and Glimmer
(it is an open-weight model, not available on the Model API).
