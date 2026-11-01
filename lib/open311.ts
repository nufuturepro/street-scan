import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { TAXONOMY } from './taxonomy';
import type { Detection, Open311Shape } from './types';

/**
 * Open311 GeoService payloads.
 *
 * Important, and worth stating plainly: we BUILD correct work orders, we do not
 * POST them. Filing against a real 311 endpoint needs a jurisdiction account
 * and a service-code lookup against that city's /services catalog - shipping
 * that unverified would mean writing potholes into someone's live dispatch.
 * So the payload is the deliverable, and the profile is swappable.
 */

type Profile = {
  jurisdiction: string;
  endpoint: string;
  codes: Record<string, { service_code: string; priority: string; description: string }>;
};

type Catalog = {
  defaultProfile: string;
  profiles: Record<string, Profile>;
};

let cached: Catalog | null = null;

function catalog(): Catalog {
  if (cached) return cached;
  const file = path.join(process.cwd(), 'data', 'service-codes.json');
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}`);
  }
  cached = JSON.parse(readFileSync(file, 'utf8')) as Catalog;
  return cached;
}

export function profileNames(): string[] {
  return Object.keys(catalog().profiles);
}

export function getProfile(name?: string): Profile {
  const c = catalog();
  return c.profiles[name ?? c.defaultProfile] ?? c.profiles[c.defaultProfile];
}

/** Alias so the payload shape lives in exactly one place. */
export type Open311Request = Open311Shape;

export function buildAddress(d: Detection): string {
  const parts = [d.street, d.crossStreet].filter((s): s is string => !!s);
  if (parts.length === 2) return `${parts[0]} @ ${parts[1]}`;
  if (parts.length === 1) return parts[0];
  if (d.lat != null && d.lon != null) return `${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}`;
  return 'Location not yet placed';
}

export function buildWorkOrder(d: Detection, profileName?: string): Open311Request {
  const profile = getProfile(profileName);
  const spec = TAXONOMY[d.hazardType];
  const code = profile.codes[d.hazardType]?.service_code ?? d.serviceCode;
  const priority = profile.codes[d.hazardType]?.priority ?? spec.priority;
  const label = profile.codes[d.hazardType]?.description ?? spec.label;

  const onSidewalk = d.surface === 'sidewalk';
  return {
    service_code: code,
    lat: d.lat,
    lon: d.lon,
    address_string: buildAddress(d),
    description:
      // A sidewalk finding must not read like a street defect in a dispatch
      // queue - the prefix is what a human triaging the ticket sees first.
      `${onSidewalk ? 'Sidewalk: ' : ''}${label}. Severity ${d.severity}/5, confidence ${(d.confidence * 100).toFixed(0)}%. ` +
      `${d.description}`,
    first_name: 'StreetScan',
    last_name: 'Audit',
    phone: '',
    device_id: 'streetscan',
    account_id: '',
    metadata: {
      hazard_type: d.hazardType,
      surface: d.surface,
      severity: d.severity,
      confidence: Number(d.confidence.toFixed(3)),
      priority,
      detected_at_ms: d.tMs,
      osm_street: d.osmStreet,
      street_source_disagreement: d.osmDisagrees,
      review_status: d.reviewStatus,
      needs_review: d.needsReview,
      generator: 'StreetScan',
      endpoint: profile.endpoint,
      filed: false,
    },
  };
}

/* ------------------------- exports for handoff ------------------------- */

export function toGeoJson(detections: Detection[]): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: detections.map((d) => ({
        type: 'Feature',
        geometry:
          d.lat != null && d.lon != null
            ? { type: 'Point', coordinates: [d.lon, d.lat] }
            : null,
        properties: {
          id: d.id,
          hazard_type: d.hazardType,
          surface: d.surface,
          severity: d.severity,
          confidence: Number(d.confidence.toFixed(3)),
          street: d.street,
          cross_street: d.crossStreet,
          service_code: d.serviceCode,
          priority: d.priority,
          status: d.reviewStatus,
          osm_street: d.osmStreet,
          osm_disagrees: d.osmDisagrees,
          needs_review: d.needsReview,
        },
      })),
    },
    null,
    2
  );
}

const CSV_COLUMNS = [
  'id',
  'hazard_type',
  'surface',
  'severity',
  'confidence',
  'lat',
  'lon',
  'street',
  'cross_street',
  'service_code',
  'priority',
  'status',
  'needs_review',
  'osm_street',
  'osm_disagrees',
  't_ms',
] as const;

export function toCsv(detections: Detection[]): string {
  const esc = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = detections.map((d) =>
    [
      d.id,
      d.hazardType,
      d.surface,
      d.severity,
      d.confidence.toFixed(3),
      d.lat,
      d.lon,
      d.street,
      d.crossStreet,
      d.serviceCode,
      d.priority,
      d.reviewStatus,
      d.needsReview,
      d.osmStreet,
      d.osmDisagrees,
      d.tMs,
    ]
      .map(esc)
      .join(',')
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}
