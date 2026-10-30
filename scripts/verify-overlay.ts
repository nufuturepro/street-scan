/**
 * Verification for the burned-in overlay reader.
 *
 * Why this exists: this is the one stage of StreetScan whose input is a guess
 * about pixels, and a single dropped minus sign turns a Brooklyn street into a
 * pin in Central Asia - which would then be graded as if it were the route.
 * Everything here runs offline, in milliseconds, against text actually read
 * off the dashcam clip plus the ways it is allowed to fail.
 *
 * What it pins down:
 *   1. the real overlay lines -> the exact coordinates the clip shows
 *   2. tolerant matching for the OCR damage already seen (missing colon or space)
 *   3. rejection of everything that is not a coordinate, especially the fused
 *      decimal, which passes a naive range check
 *   4. buildTrack stamps samples with their frame time and drops misreads
 *
 * Run: npm run verify
 */
import { parseOverlay, buildTrack } from '../lib/overlay';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   - ${msg}`);
  }
}

const fmt = (v: { lat: number; lon: number } | null) =>
  v ? `${v.lat},${v.lon}` : 'null';

/* ---------------- parseOverlay ---------------- */

type Case = { name: string; text: string; want: string };

const TABLE: Case[] = [
  {
    name: 'the real first line of the dashcam clip',
    text:
      '10/29/26, 5:41:13 PM. GPS Speed: 0.0 mph. Degrees: 40.70395, -73.94745. Altitude: - ft\n' +
      '610 Broadway, Brooklyn, NY 11206, USA',
    want: '40.70395,-73.94745',
  },
  {
    name: 'the real line at speed, with no space after the comma',
    text:
      '10/29/26, 5:42:07 PM. GPS Speed: 4.7 mph. Degrees: 40.70412,-73.94788. Altitude: 41.7 ft\n' +
      '567 Broadway, Brooklyn, NY 11206, USA',
    want: '40.70412,-73.94788',
  },
  {
    name: 'the colon eaten by OCR',
    text: '10/29/26, 5:42:37 PM. GPS Speed: 12.6 mph. Degrees 40.70421, -73.94829. Altitude: 72 ft',
    want: '40.70421,-73.94829',
  },
  { name: 'address line with no coordinate', text: '610 Broadway, Brooklyn, NY 11206, USA', want: 'null' },
  { name: 'a fix-less telemetry line', text: 'GPS Speed: 0.0 mph. Altitude: - ft', want: 'null' },
  {
    // The dangerous one: digits, minus sign, plausible shape, wrong number.
    name: 'fused decimal is not a coordinate',
    text: 'Degrees: 4070395, -7394745. Altitude: - ft',
    want: 'null',
  },
  { name: 'latitude out of range', text: 'Degrees: 407.0395, -73.94745', want: 'null' },
  { name: 'longitude out of range', text: 'Degrees: 40.70395, -739.4745', want: 'null' },
  { name: 'empty frame', text: '', want: 'null' },
];

for (const c of TABLE) {
  assert(fmt(parseOverlay(c.text)) === c.want, `${c.name} -> ${c.want}`);
}

/* ---------------- buildTrack ---------------- */

const at = (index: number, lat: number, lon: number) => ({ index, fix: { lat, lon } });

const drive = [
  at(0, 40.70395, -73.94745),
  at(30, 40.70412, -73.94788),
  // OCR dropped the minus sign here: same digits, other side of the planet.
  at(45, 40.70421, 73.94829),
  at(60, 40.70421, -73.94829),
];

const track = buildTrack(drive, 1);
assert(track.length === 3, `the misread fix is dropped, 3 kept - got ${track.length}`);
assert(
  track[0].t === 0 && track[1].t === 30_000 && track[2].t === 60_000,
  `sample times come from their frame index - got ${track.map((s) => s.t).join(',')}`
);
assert(
  track.every((s) => s.lon < 0),
  'no surviving sample keeps the flipped longitude'
);

assert(
  buildTrack(drive, 2)[1].t === 15_000,
  'sample times scale with the sampling rate'
);
assert(buildTrack([], 1).length === 0, 'no fixes -> no track');

// A point that leaves the route and comes straight back is the shape a single
// misread makes - the real clip had one at 74 m out and 73 m back.
const spiked = [
  at(0, 40.704, -73.9475),
  at(10, 40.704, -73.9475),
  at(11, 40.7046, -73.9481),
  at(12, 40.704, -73.9475),
  at(13, 40.7041, -73.9476),
];
assert(buildTrack(spiked, 1).length === 4, 'an isolated excursion is dropped - got 4');

// The same jump seen only on one side is real movement: the car left and
// stayed gone, which is what a stretch of unrecognised frames looks like.
const stepped = [
  at(0, 40.704, -73.9475),
  at(10, 40.7046, -73.9481),
  at(11, 40.7047, -73.9482),
  at(12, 40.7048, -73.9483),
];
assert(buildTrack(stepped, 1).length === 4, 'a sustained shift is kept - got 4');

console.log(process.exitCode ? '\nFAILED' : '\nAll overlay assertions passed.');
