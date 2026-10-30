/**
 * Shared domain types for StreetScan.
 */

/** Normalized polygon points, 0..1 relative to the analysis frame. */
export type Polygon = Array<[number, number]>;

/** One object observed in one frame of the SAM streaming response. */
export type SamFrame = {
  frameIndex: number;
  objectId: number;
  score: number;
  polygon: Polygon;
};

/** A persistent hazard after the temporal filter has run. */
export type Detection = {
  id?: number;
  jobId: number;
  hazardType: HazardType;
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  /** milliseconds from the start of the analysis video */
  tMs: number;
  lat: number | null;
  lon: number | null;
  street: string | null;
  crossStreet: string | null;
  description: string;
  needsReview: boolean;
  reviewStatus: 'detected' | 'verified' | 'filed';
  /** representative mask, normalized polygon */
  polygon: Polygon;
  /** frame index of the representative mask inside the analysis video */
  frameIndex: number;
  osmStreet: string | null;
  osmDisagrees: boolean;
  serviceCode: string;
  priority: string;
};

export type HazardType =
  | 'pothole'
  | 'cave_in'
  | 'crack'
  | 'blocked_lane'
  | 'debris';

export type GpsSample = {
  /** ms since the start of the recording */
  t: number;
  lat: number;
  lon: number;
};

export type GpsTrack = {
  /** 'overlay' = read out of text the recording app burned into the frame. */
  source: 'exiftool' | 'gpx' | 'overlay' | 'manual' | 'none';
  samples: GpsSample[];
};

export type JobStatus = 'ingested' | 'transcoded' | 'segmenting' | 'enriching' | 'ready' | 'failed';

export type Job = {
  id: number;
  name: string;
  footagePath: string | null;
  playbackPath: string | null;
  analysisPath: string | null;
  /** Original recording attached purely for its GPS track. */
  gpsPath: string | null;
  gpsSource: string;
  status: JobStatus;
  /** frames in the analysis video — the billing unit */
  frames: number;
  /** fps the analysis video was encoded at */
  analysisFps: number;
  costEstimateUsd: number;
  error: string | null;
  createdAt: string;
};

export type StreetContext = {
  street: string | null;
  crossStreet: string | null;
  nearestAddress: string | null;
  direction: string | null;
};

/**
 * The Open311 GeoService payload we assemble. Kept in the shared types file so
 * the inspection UI can render it without importing server-only modules.
 */
export type Open311Shape = {
  service_code: string;
  lat: number | null;
  lon: number | null;
  address_string: string;
  description: string;
  first_name: string;
  last_name: string;
  phone: string;
  device_id: string;
  account_id: string;
  metadata: Record<string, unknown>;
};

/**
 * RQSI route grading. Shared with the client so the map, the legend and the
 * export all read the same three words and the same three colours.
 *   green  - smooth:   no severe defects or obstructions
 *   yellow - caution:  surface cracks, uneven cuts
 *   red    - hazardous: deep potholes, blockages, cave-ins
 */
export type RqsiGrade = 'green' | 'yellow' | 'red';

/** One graded stretch of the camera's own GPS track. */
export type RouteSegment = {
  /** the first audit that contributed to this stretch */
  jobId: number;
  /** every audit whose route covers this stretch */
  jobIds: number[];
  /** distinct audits covering it: 1 = one pass, 2+ = cross-audit corroboration */
  passes: number;
  /** the contributing audits graded this stretch differently */
  disagree: boolean;
  /** 0-based position along the route, so segments can be listed in order */
  index: number;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  midLat: number;
  midLon: number;
  lengthM: number;
  detectionIds: number[];
  defectCount: number;
  /** detections attached by the off-track fallback rather than a clean snap */
  offRoute: number;
  /** 0 when the segment is clean */
  worstSeverity: number;
  /** weighted load normalised to 100 m */
  density: number;
  /** 0-100, higher is smoother */
  rqsi: number;
  grade: RqsiGrade;
};

/**
 * One physical hazard, as seen across every audit that drove past it.
 *
 * Derived at read time from the detections table, exactly like RouteSegment:
 * nothing is stored, so a re-run cannot corrupt it and the three jobs already
 * on disk get consensus the moment the dashboard loads.
 */
export type HazardGroup = {
  id: number;
  /** the winning sighting's coordinates - never an average of two defects */
  lat: number;
  lon: number;
  hazardType: HazardType;
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  /** every detection id in the group, including the winner */
  detectionIds: number[];
  /** the audits that saw it - one sighting per audit, by construction */
  jobs: number[];
  passes: number;
  /** single = one pass · corroborated = passes agree · disputed = they don't */
  state: 'single' | 'corroborated' | 'disputed';
};

/** Structured response we ask Muse Spark for. */
export type Classification = {
  hazardType: HazardType;
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  justification: string;
  /** false when the patch sits on sidewalk, curb or property, not the roadway */
  onRoadway: boolean;
  streetContext: StreetContext;
};
