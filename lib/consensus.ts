import { CONSENSUS_RADIUS_M, SEGMENT_MERGE_M } from './config';
import { haversineM } from './rqsi';
import type { Detection, HazardGroup, RouteSegment, RqsiGrade } from './types';

/**
 * What one audit learns from another.
 *
 * Two clips of the same street are two independent witnesses. Agreeing makes a
 * hazard more believable than any single pass; disagreeing is information too -
 * a stretch one run graded red and another graded green is exactly where a
 * detector is unreliable, and hiding that behind an average is how a demo
 * looks better than the product is.
 *
 * Two rules carry the whole design, both learned from measuring this project's
 * own three jobs rather than from theory:
 *
 *   1. ONE SIGHTING PER AUDIT, PER GROUP. A naive radius union welds a whole
 *      route into a single blob: job 4's detections sit ~10 m apart and job 6's
 *      segments 23 m apart, so at a 20 m radius a chain of links merges an
 *      entire street. A detection therefore only ever joins a group that does
 *      not already contain its own job.
 *
 *   2. AGREEMENT IS RARE AT POINT LEVEL. The two passes' nearest detections are
 *      15-24 m apart (median 23 m), so CONSENSUS_RADIUS_M is deliberately tight
 *      at 20 m: corroboration claims "same physical defect", and a false match
 *      is worse than a missed one. Most agreement shows up between route
 *      segments instead, which is why both layers exist.
 *
 * Everything here is pure arithmetic over rows already in the database -
 * nothing is written, so a re-run cannot corrupt it and existing jobs get
 * consensus the moment they are read. Same contract as lib/rqsi.ts.
 */

const CELL = 111_320; // metres per degree of latitude, close enough at city scale

const GRADE_RANK: Record<RqsiGrade, number> = { green: 0, yellow: 1, red: 2 };

function cellKey(lat: number, lon: number, sizeM: number): string {
  const row = Math.floor((lat * CELL) / sizeM);
  const col = Math.floor((lon * CELL * Math.cos((lat * Math.PI) / 180)) / sizeM);
  return `${row}:${col}`;
}

/* ------------------------------ hazards ------------------------------ */

type Draft = {
  /** the first sighting's coordinates; fixed, so matching never drifts */
  anchor: { lat: number; lon: number };
  detections: Detection[];
};

/**
 * Cluster detections across audits into physical hazards.
 *
 * State falls out of membership:
 *   single        - one audit saw it
 *   corroborated  - 2+ audits saw it and agreed on what it is
 *   disputed      - 2+ audits saw it and called it different things
 */
export function groupHazards(
  detections: Detection[],
  radiusM: number = CONSENSUS_RADIUS_M
): HazardGroup[] {
  const drafts: Draft[] = [];
  const cells = new Map<string, Draft[]>();

  for (const d of detections) {
    if (d.lat == null || d.lon == null) continue;
    const point = { lat: d.lat, lon: d.lon };

    const [row, col] = cellKey(point.lat, point.lon, radiusM)
      .split(':')
      .map(Number);

    let best: Draft | null = null;
    let bestDist = Infinity;
    // The 3x3 neighbourhood covers any point within `radiusM` of the anchor on
    // either side of a cell boundary, so edge cases are matched, not missed.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const draft of cells.get(`${row + dr}:${col + dc}`) ?? []) {
          if (draft.detections.some((x) => x.jobId === d.jobId)) continue;
          const dist = haversineM(draft.anchor, point);
          if (dist <= radiusM && dist < bestDist) {
            best = draft;
            bestDist = dist;
          }
        }
      }
    }

    if (best) {
      best.detections.push(d);
    } else {
      const draft: Draft = { anchor: point, detections: [d] };
      drafts.push(draft);
      const key = cellKey(point.lat, point.lon, radiusM);
      const bucket = cells.get(key);
      if (bucket) bucket.push(draft);
      else cells.set(key, [draft]);
    }
  }

  return drafts.map((draft, id) => {
    const jobs = [...new Set(draft.detections.map((d) => d.jobId))];
    const winner = draft.detections.reduce((best, d) =>
      d.severity > best.severity ||
      (d.severity === best.severity && d.confidence > best.confidence)
        ? d
        : best
    );
    const types = new Set(draft.detections.map((d) => d.hazardType));

    return {
      id,
      lat: winner.lat!,
      lon: winner.lon!,
      hazardType: winner.hazardType,
      severity: winner.severity,
      confidence: winner.confidence,
      detectionIds: draft.detections
        .map((d) => d.id!)
        .filter((n) => n != null)
        .sort((a, b) => a - b),
      jobs,
      passes: jobs.length,
      state:
        jobs.length === 1 ? 'single' : types.size === 1 ? 'corroborated' : 'disputed',
    };
  });
}

/** detection id -> which hazard it belongs to, for counting defects once. */
export function groupIndex(groups: HazardGroup[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const g of groups) for (const id of g.detectionIds) map.set(id, g.id);
  return map;
}

/**
 * The detections a second pass has earned a verification for.
 *
 * Corroborated only: two audits that agree on the type are agreeing about what
 * the thing IS, which is what a human clicking Verify means. A disputed group
 * is deliberately absent - disagreement is a reason to look, never a reason to
 * sign off - and a single pass has no one to corroborate it.
 */
export function corroboratedIds(groups: HazardGroup[]): number[] {
  return groups
    .filter((g) => g.state === 'corroborated')
    .flatMap((g) => g.detectionIds);
}

/* ------------------------------ segments ------------------------------ */

/** Midpoint-to-midpoint distance between two stretches of road. */
function midDist(a: RouteSegment, b: RouteSegment): number {
  return haversineM({ lat: a.midLat, lon: a.midLon }, { lat: b.midLat, lon: b.midLon });
}

/**
 * Pairs of stretches that both contain the same hazard - the strongest evidence
 * there is that two windows describe one piece of road. A detection sits in
 * exactly one stretch (its own audit's), so each hazard yields one pair per
 * pair of audits that saw it.
 */
function sharedHazardPairs(segments: RouteSegment[], hazards: HazardGroup[]): Pair[] {
  const segOf = new Map<number, number>();
  segments.forEach((s, i) => {
    for (const id of s.detectionIds) if (!segOf.has(id)) segOf.set(id, i);
  });

  const out: Pair[] = [];
  for (const g of hazards) {
    if (g.jobs.length < 2) continue;
    const owners = [
      ...new Set(
        g.detectionIds
          .map((id) => segOf.get(id))
          .filter((i): i is number => i != null)
      ),
    ];
    for (let x = 0; x < owners.length; x++) {
      for (let y = x + 1; y < owners.length; y++) {
        const a = segments[owners[x]];
        const b = segments[owners[y]];
        if (a.jobId === b.jobId) continue;
        out.push({ i: owners[x], j: owners[y], dist: midDist(a, b) });
      }
    }
  }
  return out;
}

type Pair = { i: number; j: number; dist: number };

/**
 * Maximum bipartite matching between two audits' segments (Kuhn's augmenting
 * paths).
 *
 * Greedy input order cannot see the swap: A1 claims its nearest window B1, A2's
 * only option was B1, and A1 fits B2 just as well - one merge where two were
 * possible. Augmenting paths re-route A1 to B2 and hand B1 to A2, which is the
 * difference between merging most shared streets and merging some of them.
 * O(V*E) over a few dozen segments - microseconds.
 */
function bestPairs(
  left: number[],
  right: number[],
  segments: RouteSegment[],
  canMerge: (i: number, j: number) => boolean
): Pair[] {
  const adj = left.map((li) =>
    right
      .map((rj, j) =>
        midDist(segments[li], segments[rj]) <= SEGMENT_MERGE_M && canMerge(li, rj) ? j : -1
      )
      .filter((j) => j >= 0)
  );
  const matched = new Array<number>(right.length).fill(-1);

  const augment = (i: number, seen: boolean[]): boolean => {
    for (const j of adj[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (matched[j] === -1 || augment(matched[j], seen)) {
        matched[j] = i;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < left.length; i++) {
    augment(i, new Array<boolean>(right.length).fill(false));
  }

  const pairs: Pair[] = [];
  matched.forEach((i, j) => {
    if (i < 0) return;
    pairs.push({
      i: left[i],
      j: right[j],
      dist: midDist(segments[left[i]], segments[right[j]]),
    });
  });
  return pairs;
}

/**
 * Collapse segments from different audits that grade the same stretch of
 * street, so "All audits" reports the street once instead of once per clip.
 *
 * A merged stretch takes the WORST grade and the LOWEST index of its
 * contributors: two passes disagreeing about a road is not a reason to average
 * them into something nobody drove. Its length is the longest contributor
 * rather than the sum - the point of merging is that shared metres are counted
 * once - and its defect count is the number of distinct hazards inside it, so
 * one pothole seen twice still reads as one pothole.
 */
export function mergeSegments(
  segments: RouteSegment[],
  hazards: HazardGroup[] = []
): RouteSegment[] {
  // Which audit drove which stretch. Membership is capped at one stretch per
  // audit per group - the same rule the hazard grouping runs on.
  const byJob = new Map<number, number[]>();
  segments.forEach((s, i) => {
    const list = byJob.get(s.jobId);
    if (list) list.push(i);
    else byJob.set(s.jobId, [i]);
  });

  const parent = segments.map((_, i) => i);
  const members: number[][] = segments.map((_, i) => [i]);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const unionAll = (list: Pair[]) => {
    for (const p of [...list].sort((a, b) => a.dist - b.dist)) {
      const ra = find(p.i);
      const rb = find(p.j);
      if (ra === rb) continue;
      const jobsA = new Set(members[ra].map((k) => segments[k].jobId));
      if (members[rb].some((k) => jobsA.has(segments[k].jobId))) continue;
      parent[rb] = ra;
      members[ra].push(...members[rb]);
    }
  };

  // Phase 1: fix the pairs that contain the same hazard. Done before any
  // distance matching, because a geometrically convenient swap elsewhere in the
  // street must never separate one pothole's two sightings into two stretches.
  unionAll(sharedHazardPairs(segments, hazards));

  // Phase 2: pair up what is left by geometry, as a maximum matching.
  //
  // The matching is offered exactly the pairs unionAll would accept - both
  // groups' jobs disjoint, which covers a partner phase 1 has already claimed.
  // Offering a pair that will be thrown away is not harmless: the matching
  // spends a slot on it and strands a window that had no other neighbour, so a
  // shared street silently stays unmerged. Measured on jobs 4 and 6's first
  // geometry, that cost one stretch in three; the contract in
  // scripts/verify-consensus.ts fails if it comes back.
  const canMerge = (i: number, j: number) => {
    const jobsA = members[find(i)].map((k) => segments[k].jobId);
    return !members[find(j)].some((k) => jobsA.includes(segments[k].jobId));
  };
  const jobs = [...byJob.keys()];
  const pairs: Pair[] = [];
  for (let x = 0; x < jobs.length; x++) {
    for (let y = x + 1; y < jobs.length; y++) {
      pairs.push(
        ...bestPairs(byJob.get(jobs[x])!, byJob.get(jobs[y])!, segments, canMerge)
      );
    }
  }
  unionAll(pairs);

  const buckets: number[][] = [];
  const done = new Set<number>();
  for (let i = 0; i < segments.length; i++) {
    const root = find(i);
    if (done.has(root)) continue;
    done.add(root);
    buckets.push(members[root]);
  }

  const groupOf = groupIndex(hazards);

  return buckets.map((idxs) => {
    const members = idxs.map((k) => segments[k]);
    // Longest contributor supplies the drawn geometry: it is the better
    // measured description of the road, and merging must not invent one.
    const lead = members.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
    const jobIds = [...new Set(members.map((m) => m.jobId))];
    const grade = members.reduce<RqsiGrade>(
      (worst, m) => (GRADE_RANK[m.grade] > GRADE_RANK[worst] ? m.grade : worst),
      'green'
    );
    const detectionIds = [...new Set(members.flatMap((m) => m.detectionIds))].sort(
      (a, b) => a - b
    );
    const distinctHazards = new Set(
      detectionIds.map((id) => groupOf.get(id) ?? `d${id}`)
    ).size;

    return {
      ...lead,
      jobId: lead.jobId,
      jobIds,
      passes: jobIds.length,
      // Only a disagreement between passes is a disagreement; one pass cannot
      // disagree with itself.
      disagree: jobIds.length > 1 && new Set(members.map((m) => m.grade)).size > 1,
      detectionIds,
      defectCount: distinctHazards,
      offRoute: members.reduce((sum, m) => sum + m.offRoute, 0),
      worstSeverity: members.reduce((m, x) => Math.max(m, x.worstSeverity), 0),
      density: members.reduce((m, x) => Math.max(m, x.density), 0),
      rqsi: Math.min(...members.map((m) => m.rqsi)),
      grade,
    } satisfies RouteSegment;
  });
}
