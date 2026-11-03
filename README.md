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
               one spelling per street · a second pass that agrees = verified
   [Spark]    crop + full frame → {hazardType, severity, confidence, streetContext}
   [OSM]      Overpass reverse-geocode → validate the OCR'd street name, disagree → flag
   [Open311]  → SQLite → split-screen inspection UI → dispatch dashboard
```

## Functions

What the app does, function by function - the operator's view. Each one says where it lives.

### 1. Ingest footage - `/`

- Drag a clip in (or click to choose): MP4/MOV/M4V, streamed raw rather than multipart, so a
  10-minute 4K upload never buffers in memory and the progress bar is real.
- Optionally attach the **original** recording as the GPS source - a second upload
  (`?role=gps`) whose track is read with exiftool. A flattened export carries no GPS at all;
  if the attach fails the job still opens, because no GPS is a manual pin, not a dead job.
- **The scan starts on upload, in the background** - the page stays put and the audit list
  shows the new job's status. Drop three clips and all three work; a staged GPS source holds
  the start until that upload lands, so the pipeline never reads GPS off a half-written file.

### 2. Run an audit - the scan queue (`lib/queue.ts`)

- Uploads enqueue automatically; up to `SCAN_CONCURRENCY` (2) run at once, the rest wait in
  FIFO order. The **Scanning** strip on `/dashboard` shows every running and queued job with
  its stage and progress - no page needs to stay open on any of them.
- `/inspect/:id` polls the same queue snapshot instead of owning the run: stage bar,
  `queued - position 2`, and **Retry** on failure. Opening a legacy job that predates the
  queue starts it, as before.
- A server restart never resumes a run silently (that would re-bill unwatched): interrupted
  jobs are marked `failed - interrupted by a server restart` and wait for a human.
- Nothing is configured per run: prompts, persistence thresholds and the taxonomy
  (`pothole, cave_in, crack, blocked_lane, debris`) live in
  [`lib/taxonomy.ts`](lib/taxonomy.ts) and [`lib/config.ts`](lib/config.ts).

### 3. Triage in the queue - `/dashboard`

- Filter by audit, type, **surface** (everywhere / street only / sidewalk), severity ≥, status
  or `needs review`; the header counts `57 of 57 hazards`, so a filter that hides half the
  street says so.
- Every row carries a severity badge, **the frame the hazard was found on**, its street, a
  corroboration badge (`2 passes`, or `disputed` when a second audit saw the same spot and
  disagreed), and a status pill you click to change `detected → verified → filed → detected` -
  the wrap is the undo. Entries a reviewer rejected are **not** in this queue at all: they are
  not hazards, so they are not counted, mapped or filed (see section 5).
- Sidewalk findings wear a `walk` chip and the breakdown splits `18 street - 4 on sidewalk`:
  kept, visible, never passed off as street defects.
- The breakdown counts hazards by type and calls out how many are still waiting on a GPS fix.
  Each count is a toggle: click a type to filter queue **and** map to just those hazards.
  Counts are computed with the type filter lifted, so the pill you picked stays lit while the
  others keep their full counts - picking one narrows the view instead of erasing its siblings.
- Clicking an RQSI segment lines the queue up with the map: a strip under the Queue header says
  `N in this stretch: 1 pothole - 2 cracks` (and how many are hidden by active filters), and
  every row that lives in the stretch gets an amber rail. The strip is a button too - click it
  and the queue scrolls to the first member row.
- The **Intersections** card lists every place two audits' routes meet: the street, each pass's
  own grade for the shared ground, and an agree/dispute badge, disputed first. Each row's
  `▶ #4 @ 1:33` opens that audit's footage **at the shared spot** in a new tab, so a report can
  be weighed against a second sighting; clicking the row itself details the stretch on the map.

### 4. Hover a row - the still popup

- Shows that frame with SAM's polygon painted over it, plus hazard, severity and confidence,
  and a **Review video →** button that opens the footage at that hazard's timestamp.
- Images come from `GET /api/detections/:id/still` - one ffmpeg cut per detection, cached on
  the server, never a model call.
- The popup layers **above** the map and the sticky header: Leaflet's panes (z-index 200-1000)
  are contained in the map's own stacking context, so nothing on the page has to out-z them.

### 5. Review footage in place

- Clicking a row opens the footage **in the map's slot**, so the queue stays exactly where it
  is and nothing scrolls.
- The video jumps to that hazard's second, and its mask stays painted for ~2.6s around the
  sample frame. The timeline below carries one severity-coloured tick per hazard - click to
  jump.
- Beside it sits the live Open311 payload: correct the latitude, longitude, street, cross
  street - or **reclassify the hazard's type and severity** - then **Apply corrections** writes
  it back and the payload redraws with the corrected service code and priority. An emptied
  cross street **clears** a wrong one (omitting the field leaves it alone). **Copy JSON**
  takes it elsewhere. **full page ↗** opens the dedicated inspect view; **✕ Close** hands the
  slot back to the map.
- Type and severity are editable because they are the fields a pin fix cannot repair: a manhole
  the detector called a pothole ships the city the wrong service code, ranks at the wrong
  priority, and charges a defect to a street that does not have one.

### 5b. Correct or throw out an entry - `/inspect/:id`

- **Undo** walks a `verified` or `filed` detection back to `detected`. Verify and File used to be
  one-way in practice, so a misclick on the wrong row was permanent.
- **Not a hazard** rejects a false positive. The row keeps its still and its footage - rejecting
  is a decision, not a delete - but it leaves the route grade, the cross-audit corroboration and
  every export (`csv`, `geojson`, `open311`, `rqsi`), so a thrown-out detection cannot skew a
  score or reach a city. **Restore** puts it back.
- Both live on every queue row, next to Verify and File, and the audit header counts them:
  `12 detected · 3 verified · 1 filed` plus a red `2 rejected` when there are any.

### 6. Read the street - the map

- Detection pins are coloured by severity; **sidewalk findings are hollow with a blue ring**,
  and their popup says `on sidewalk - not in the roadway grade`. Clicking one selects the
  matching row in the queue. Where the map's own street name disagrees with the one read
  from the frame, the pin says so instead of picking a winner.
- **RQSI segments** run under the pins as green/amber/red polylines, one per ~100m of driven
  route, each with a popup: grade, score, length, defect count, worst severity and how many
  passes cover it. Clicking one marks its hazards in the queue (see section 3).
- The route-quality legend sits on the map, and its three grade rows are **toggles**: click one
  to draw only that grade (`12 of 247 segments shown`), click it again to show all - the counts
  stay whole while a grade is active, same rule as the breakdown pills. The view does not snap
  back to fit on every poll - the zoom you chose is the zoom you keep.
- The basemap is **Esri Dark Gray Canvas**, not Carto: Carto began keying its basemaps and
  answers unauthenticated requests with HTTP 200 plus an "API KEY REQUIRED" watermark tile -
  a silent blank map rather than a loud failure. Esri's canvas is keyless and already dark.

### 7. Grade the route (RQSI)

- Every **street** detection is snapped to a 100m window of the GPS track (rejected ones are
  not part of the road at all, so they never enter the arithmetic): density
  (severity-weighted defects per 100m) becomes `RQSI = 100 − density × K`, then a rubric
  grade - **red** for any severity ≥ 4 or a blocked-lane/cave-in ≥ 3, **yellow** for
  severity ≥ 2 or cracking, **green** when clean. Sidewalk findings are graded apart: a
  sidewalk defect must not redden a driving segment no tyre touched.
- The **Route quality** card shows the length-weighted score, `smooth / caution / hazardous`
  segment counts and the worst segment. Grades use every detection in the audit, not just the
  filtered view.

### 8. Let passes correct each other

- Two audits that saw the same defect → **corroborated**, and that pair is promoted to
  `verified` on its own; two that disagree on what it is → **disputed**, which waits for a
  human.
- Street names are canonicalised across passes (`Hart St` ≡ `Hart Street`) so an Open311
  export never carries both spellings, while a genuine disagreement (`Stuyvesant Ave` against
  the map's `Broadway`) is flagged rather than silently renamed.

### 9. Export, and watch the cost

- Per audit: `csv` for a spreadsheet, `geojson` for a GIS, `rqsi` for the graded segments as
  LineStrings, `open311` for the assembled payloads. They are **assembled, never POSTed** -
  filing needs a jurisdiction account and that city's real service codes.
- Every export row carries **what that audit cost**, and `/inspect/:id` shows the meter behind
  that figure: ffmpeg $0.00, SAM off the frames Meta actually billed, Muse Spark off its real
  token counts, then the total and **$/km** over the metres this run drove. A run served from
  fixtures is tagged `simulated`, so a projected number is never mistaken for a charge.
- The arithmetic lives in [`lib/cost.ts`](lib/cost.ts) over the spend ledger - one row per
  charge, written when the money moves - plus frames and the GPS track, so the meter, the
  export pills and the header pill cannot disagree with each other.
- The header pill reports live-vs-fixtures and spend against the $150 credit. SAM bills
  $0.20 per 1,000 frames, which is why the pipeline analyses a separate 10fps copy.
- **Every amount links to `/costs`** - the expense ledger: per-audit SAM/Spark/total/$-per-km
  rows, the credit bar, the rate card, and how every charge is accounted. Export pills
  deep-link to their own row (`/costs#job-7`).
- CSV, GeoJSON and Open311 all carry a `surface` column (`roadway`/`sidewalk`), and a
  sidewalk work order is prefixed `Sidewalk:` so it cannot be misfiled as a street defect.

### 10. Set the Model API key - `/settings`

- Paste a key into **Settings** (nav bar) and it takes effect from the next API call - no
  container rebuild, no restart. Stored server-side as one row in the same SQLite database;
  `GET /api/settings` reports only where the key came from (pasted vs environment) and its
  first four and last four characters, never the key itself.
- The environment (`MODEL_API_KEY` in `.env`) stays as the deployment default; a key pasted
  at `/settings` wins while it exists, and **Clear** falls back to the environment again.
- The page also shows which world the pipeline is in (`live` / `auto` / `fixture`) and the
  live-vs-fixtures probe. This deployment has no login and is LAN-only - anyone who can reach
  the page can change the key, which the page says so plainly.

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
cp .env.example .env        # set MODEL_API_KEY (or paste one later at /settings)
npm run dev                 # http://localhost:3000
```

Requires **ffmpeg/ffprobe** on PATH (`winget install Gyan.FFmpeg`), or set `FFMPEG_PATH` /
`FFPROBE_PATH`. Nothing else is needed — storage is SQLite via Node's built-in `node:sqlite`,
the map is Leaflet with OpenStreetMap tiles (no API keys).

A clip whose GPS is burned into the picture instead of tracked needs `tesseract.js`, which
fetches its English language data once (needs the network that one time) and caches it in
`storage/tesseract/`, a mounted volume, so no container restart refetches it.

## Billing status: live

`GET /api/status` reports `mode: live`, `billing.blocked: false`, and real spend against the
$150 credit - exactly what the header pill shows.

`META_API_MODE` decides which path runs: `live` forces real calls, `fixture` forces recorded
ones, and `auto` (the default) probes the key once at startup. Should billing ever lapse
again, the key answers:

```json
{"code":"billing_not_configured","message":"To use this API key, your team needs to
resolve a billing issue first."}
```

and `auto` serves **deterministic recorded responses** instead of failing the run. The pill
then shows `fixtures` - never hidden, because a judge who assumes the masks are live when
they are not has been misled. With billing resolved the same code path goes live with no
edits: set `META_API_MODE=live` to force it, `fixture` to stay off.

The fixtures are deliberately adversarial — persistent hazards that must survive the filter,
2–4 frame flickers that must die, and **object IDs that differ in each overlapping chunk**
(matching Meta's documented "IDs are not stable across responses") so the boundary merge has
to actually work.

## Verify

```bash
npx tsc --noEmit          # types
npm run lint              # lint
npm run build             # build
npm run verify            # behaviour: 169 assertions across four verify scripts
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

`scripts/probe-prompts.ts` is separate from the suite: it spends real money
asking SAM whether a candidate prompt finds anything, so it is run by hand. It
tests one sliced chunk per candidate, prints boxes and frames-hit, reports which
frames each prompt found that the control missed, and crops the largest box it
matched to a PNG - because "260 boxes" never says whether those boxes are cars
or tree trunks. That probe is why the prompt list is `pothole, crack, car` and
not the six-word obstruction battery first proposed.

The consensus script is the contract for what one audit learns from another:
two passes agreeing on a defect, two passes calling it different things, and -
the case the whole design turns on - a 10 m chain of detections from one audit
that must never weld a single drive into one hazard. It also pins the merging
arithmetic: the worse grade wins, shared metres count once (the same 50 m
street reads 50 m unmerged 100 m), two sightings of one pothole are one defect,
and the matching must be MAXIMUM rather than first-come - the fixture there is
a pair of stretches where input-order greedy merges one and augmenting paths
merge two, plus a four-window street where a hazard that has already claimed
its partner must not be offered to the matching again: offered, it strands two
windows and merges two stretches where three were possible. Street naming is
covered too: `Hart St` and `Hart Street` collapse to
one identity while `Stuyvesant Ave` against OSM's `Broadway` stays a disagreement,
and only a corroborated pair - never a disputed one - earns a verification.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/jobs?name=&ext=` | raw streamed upload (no multipart buffering — a 10-minute 4K clip would otherwise take the dev server down) |
| `POST /api/jobs/:id/process` | enqueues a scan (JSON, idempotent) - the queue runs it; any page reads progress from the job/dashboard GETs |
| `GET /api/dashboard` | every job + detection + hazard group + RQSI segment + cross-audit intersection, plus the live queue snapshot, in one request |
| `GET /api/jobs/:id` | job + detections + counts + GPS + cost + live queue progress |
| `PATCH /api/detections/:id` | the human correction step: status (including `detected` = undo, and `rejected` = not a hazard), manual pin, street/cross-street, hazard type + severity (service code and priority follow the reclassification) |
| `GET /api/detections/:id/still` | the frame a hazard was found on - cut from playback on first request, then cached |
| `GET /api/jobs/:id/export?format=` | `csv` · `geojson` · `open311` · `rqsi` |
| `GET /api/files/:id/:name` | Range-aware video streaming (206) so scrubbing works |
| `GET /api/costs` | the spend ledger: per-audit frames/SAM/Spark/total, lifetime credit spend, rate card |
| `GET /api/status` | live-vs-fixture, billing state, spend against the $150 credit |
| `GET/POST /api/settings` | the Model API key's status (masked) · save or clear it - never returns the key |

## Cost control

SAM bills per video frame: **$0.20 / 1,000 frames**. That is why the pipeline transcodes a
separate 10fps analysis copy — a 10-minute drive is 6,000 frames instead of 18,000, about
$1.20 rather than $3.60, and a pothole is still on screen for 10–20 frames, which is far more
than the persistence filter needs.

The spend readout in the header is the **spend ledger** ([`lib/spend.ts`](lib/spend.ts)): one
row per charge, written the moment SAM or Spark bills it, so a crash, a restart, a re-run or a
deleted audit cannot erase what was spent. That matters - the earlier design kept a single
per-run estimate per job, re-runs overwrote it, and the app claimed $12.09 against Meta's
$33.38. Jobs from that period are seeded from their recorded estimate on first read, and
Meta's usage page remains the authority for anything before the ledger.
[`scripts/probe-usage.ts`](scripts/probe-usage.ts) exercises the live write path for about a
cent and reads back whether the provider's own billed frame count arrived.

Because Meta exposes no usage API, `/costs` also carries a **reconcile** box: type the
free-credits-remaining figure from Meta's Billing page and the app appends the difference
as one dated `adjustment` row - the ledger's redo button. Seed rows are never rewritten:
the seed stays what the app claimed, the adjustment stays what Meta said, and a later
reconciliation corrects in either direction. Each audit row expands to its billed frames,
SAM and classification counts, token totals, and the underlying ledger rows, so a
`pre-ledger seed` is never mistaken for a live `provider usage` charge.

## Assumptions still open

1. **SAM processes an uploaded video at its native frame rate.** Settled by
   [`scripts/probe-usage.ts`](scripts/probe-usage.ts): 50 frames sent at 10fps came back
   billed 1:1, with the response's own `usage.video_frames_processed` saying 50. Should a
   rate-card change ever break this, set `ANALYSIS_FPS = PLAYBACK_FPS` in
   [`lib/config.ts`](lib/config.ts) and nothing else changes.
2. **SAM's streaming event schema.** `extractFrames()` in [`lib/meta.ts`](lib/meta.ts)
   still accepts the common shapes rather than betting on one, but the billed frame count
   no longer guesses: it prefers `usage.video_frames_processed`, and every spend row's
   `detail` records which source produced the number (`provider usage` vs
   `frame-count estimate`), so a silent regression is readable in the ledger.
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
