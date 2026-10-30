import type { Detection } from './types';

/**
 * One spelling per street, across every audit.
 *
 * Two passes read the same sign differently - "Hart Street" and "Hart St",
 * "Malcolm X Boulevard" and "Malcolm X Blvd" - and both spellings then travel
 * into an Open311 address_string, so a city receiving our payloads sees one
 * street under three names. Measured on this project's three jobs: 46
 * detections carried 9 distinct street strings for what is really 7 streets.
 *
 * The rule is deliberately not "trust the loudest vote". Names are grouped by
 * what they MEAN (abbreviations expanded: st -> street, blvd -> boulevard, av
 * -> avenue), and within a group the winner is:
 *
 *   1. the spelling OpenStreetMap uses, when the map names this street at all -
 *      it is the naming authority behind the coordinates we already reverse
 *      geocode against, and it never abbreviates;
 *   2. otherwise the most frequent spelling, then the longest, then alphabetical.
 *
 * Two names that mean different streets never meet: "Stuyvesant Ave" against
 * OSM's "Broadway" at a corner are different keys, so the existing `osmDisagrees`
 * flag still reports that honestly instead of silently renaming the street.
 *
 * Derived on read, never written back: rows keep what the model or the human
 * typed, and every view agrees because they all vote over the same full table.
 */

const ABBREVIATIONS: Record<string, string> = {
  st: 'street',
  str: 'street',
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  rd: 'road',
  dr: 'drive',
  ln: 'lane',
  ct: 'court',
  pkwy: 'parkway',
  hwy: 'highway',
  sq: 'square',
  ter: 'terrace',
  pl: 'place',
  cir: 'circle',
};

/** The identity of a street name: case, punctuation and abbreviations folded out. */
export function streetKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(' ');
}

type Candidate = { value: string; count: number; fromMap: boolean };

function tally(detections: Detection[]): Map<string, Map<string, Candidate>> {
  const byKey = new Map<string, Map<string, Candidate>>();

  const add = (raw: string | null, fromMap: boolean) => {
    if (!raw) return;
    let inner = byKey.get(streetKey(raw));
    if (!inner) {
      inner = new Map();
      byKey.set(streetKey(raw), inner);
    }
    const hit = inner.get(raw);
    if (hit) {
      hit.count += 1;
      hit.fromMap = hit.fromMap || fromMap;
    } else {
      inner.set(raw, { value: raw, count: 1, fromMap });
    }
  };

  for (const d of detections) {
    add(d.street, false);
    add(d.crossStreet, false);
    add(d.osmStreet, true);
  }
  return byKey;
}

function pick(candidates: Map<string, Candidate>): string {
  const list = [...candidates.values()];
  list.sort(
    (a, b) =>
      Number(b.fromMap) - Number(a.fromMap) ||
      b.count - a.count ||
      b.value.length - a.value.length ||
      a.value.localeCompare(b.value)
  );
  return list[0].value;
}

export type StreetNames = { street: string | null; crossStreet: string | null };

/**
 * The canonical street/cross-street for every detection passed in.
 *
 * `voters` should be the whole table even when `rows` is one job's worth: a
 * single-audit view must not outvote the rest of the database and answer
 * differently from the dashboard.
 */
export function canonicalStreets(
  rows: Detection[],
  voters: Detection[] = rows
): Map<number, StreetNames> {
  const byKey = tally(voters);
  const out = new Map<number, StreetNames>();

  for (const d of rows) {
    if (d.id == null) continue;
    const street = d.street ? byKey.get(streetKey(d.street)) : undefined;
    const cross = d.crossStreet ? byKey.get(streetKey(d.crossStreet)) : undefined;
    out.set(d.id, {
      street: street ? pick(street) : d.street,
      crossStreet: cross ? pick(cross) : d.crossStreet,
    });
  }
  return out;
}
