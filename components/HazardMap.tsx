'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Detection, HazardGroup, RouteSegment } from '@/lib/types';
import { GRADE_COLOR, GRADE_LABEL, summarize } from '@/lib/rqsi';

const SEVERITY_COLORS: Record<number, string> = {
  1: '#71717a',
  2: '#0ea5e9',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

function pin(severity: number, active: boolean, surface?: string): L.DivIcon {
  const color = SEVERITY_COLORS[severity] ?? '#f59e0b';
  const size = active ? 22 : 16;
  // Sidewalk findings are hollow with a blue ring: same severity ramp inside,
  // unmistakably not a street defect from across the room. A judge who saw
  // SAM paint a pothole on a sidewalk once should never be fooled again.
  const sidewalk = surface === 'sidewalk';
  const ring = sidewalk ? '#38bdf8' : color;
  const fill = sidewalk ? '#0c4a6e' : color;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:9999px;
      background:${fill};border:2px solid ${ring};
      box-shadow:0 0 0 ${active ? 3 : 1}px ${ring}55;
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

type Props = {
  detections: Detection[];
  /** RQSI segments for the routes currently in view. */
  segments: RouteSegment[];
  /** Cross-audit hazard groups, so a pin can say a second pass saw it too. */
  hazards?: HazardGroup[];
  activeId: number | null;
  onSelect: (id: number) => void;
  /**
   * False while the dashboard shows footage in this slot instead. Leaflet
   * cannot see a display:none container, so it needs telling when it is back.
   */
  visible?: boolean;
};

/** Where the map sits before any detection has a fix - a neutral world view. */
const FALLBACK_CENTER: [number, number] = [30.2672, -97.7431];

/**
 * Leaflet reads MapContainer's center/zoom exactly once, at mount - but
 * detections arrive from an async fetch, so the map mounts on an empty set and
 * would sit on the fallback view forever. This fits the bounds whenever the set
 * of visible hazards changes, then pans to whichever one is selected in the
 * queue, which is what makes clicking a row actually move the map.
 */
function MapController({
  located,
  segments,
  activeId,
  visible,
}: {
  located: Detection[];
  segments: RouteSegment[];
  activeId: number | null;
  visible: boolean;
}) {
  const map = useMap();

  // The dashboard polls every 5s, so each poll hands down brand-new arrays
  // even when neither the hazards nor the road have moved. Keying anything on
  // that identity re-ran fitBounds after every poll and snapped the map back to
  // zoom 17 the instant you zoomed in - hence refs for the data and a signature
  // for what actually changed. Only real content can move the camera.
  const locatedRef = useRef(located);
  const segmentsRef = useRef(segments);
  useEffect(() => {
    locatedRef.current = located;
    segmentsRef.current = segments;
  }, [located, segments]);

  // Swapping this pane for the footage panel hides it with display:none, which
  // leaves Leaflet holding a 0x0 container: come back and the tiles are laid
  // out for a box that no longer exists and clicks land off-target.
  // invalidateSize re-measures without touching center or zoom, so the view
  // you left is the view you return to - the fit() below is keyed on content,
  // not on visibility, so it does not re-run here.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [map, visible]);

  // Segments get a fresh object identity on every poll while their content
  // stays identical, so the signature comes from what identifies a route: which
  // job, which stretch, how it graded. Grades only change on a re-run.
  const signature =
    located.map((d) => d.id).join(',') +
    '|' +
    segments.map((s) => `${s.jobId}:${s.index}:${s.grade}`).join(',');

  const fit = useCallback(() => {
    const points: Array<[number, number]> = [];
    for (const d of locatedRef.current) {
      if (d.lat != null && d.lon != null) points.push([d.lat, d.lon]);
    }
    // The route runs past its own hazards, so frame the road we drove rather
    // than only the pins found on it.
    for (const s of segmentsRef.current) points.push([s.lat1, s.lon1], [s.lat2, s.lon2]);
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17, animate: false });
  }, [map]);

  useEffect(() => {
    fit();
  }, [fit, signature]);

  useEffect(() => {
    if (activeId == null) return;
    const active = locatedRef.current.find((d) => d.id === activeId);
    if (active?.lat == null || active?.lon == null) return;
    map.setView([active.lat, active.lon], Math.max(map.getZoom(), 17));
  }, [map, activeId, signature]);

  return null;
}

export default function HazardMap({ detections, segments, hazards = [], activeId, onSelect, visible = true }: Props) {
  // Memoised: MapController re-fits on this array's identity, so a filter that
  // rebuilt it every render would snap the map back mid-interaction.
  const located = useMemo(
    () => detections.filter((d) => d.lat != null && d.lon != null),
    [detections]
  );
  // Deliberately not a useMemo: `hazards` is a fresh array on every 5s poll,
  // so a memo keyed on it would rebuild every time anyway.
  const hazardOf = new Map<number, HazardGroup>();
  for (const g of hazards) for (const id of g.detectionIds) hazardOf.set(id, g);
  const route = summarize(segments);
  const center: [number, number] =
    located.length > 0
      ? [
          located.reduce((s, d) => s + (d.lat as number), 0) / located.length,
          located.reduce((s, d) => s + (d.lon as number), 0) / located.length,
        ]
      : segments.length > 0
        ? [segments[0].midLat, segments[0].midLon]
        : FALLBACK_CENTER;

  return (
    /*
      isolate: Leaflet paints its panes at z-index 200-1000, and without a
      stacking context of its own the map container let those values compete
      with everything on the page - the queue-row hover popup (z-50) and the
      sticky header (z-500) both lost to map tiles and the legend. Isolation
      contains every Leaflet z-index inside this wrapper, so overlays outside
      the map layer in DOM order instead of against a magic number.
    */
    <div className="relative isolate h-full w-full">
    <MapContainer
      center={center}
      zoom={located.length > 0 || segments.length > 0 ? 16 : 13}
      className="h-full w-full rounded-lg"
      style={{ background: '#18181b' }}
    >
      <TileLayer
        attribution={'Sources: <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, FAO, NOAA, USGS'}
        // Carto began keying its basemaps: unauthenticated requests return HTTP 200
        // with a "API KEY REQUIRED" watermark tile instead of failing loudly, which
        // silently blanked this map. Esri's Dark Gray Canvas is keyless, and already
        // dark, so no CSS filter is needed to match the UI.
        //
        // Esri's Canvas layer does the same thing one zoom further out: it serves
        // real tiles through z=16 and answers EVERY request above that with HTTP 200
        // plus a 2,521-byte gray tile reading "Map data not yet available" - so
        // img.complete stays true, naturalWidth stays 256, no error event fires and
        // nothing in the app can see the failure. Our own camera goes to 17 (fit()
        // maxZoom, and row selection calls setView at 17), which is exactly why the
        // basemap blanked whenever a route was framed or a row was opened.
        //
        // maxNativeZoom tells Leaflet the truth about the provider: past 16 it
        // re-requests the z=16 tile and scales it, so the view stays usable instead
        // of going gray. Measured 2026-10-30 against this URL: z 9-16 return
        // 7.9-15.3 KB JPEGs, z 17-20 all return the identical 2,521-byte placeholder.
        maxNativeZoom={16}
        url="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      />
      <MapController located={located} segments={segments} activeId={activeId} visible={visible} />
      {segments.map((s) => (
        <Polyline
          key={`${s.jobId}:${s.index}`}
          positions={[
            [s.lat1, s.lon1],
            [s.lat2, s.lon2],
          ]}
          pathOptions={{
            color: GRADE_COLOR[s.grade],
            weight: 6,
            opacity: 0.85,
            lineCap: 'round',
          }}
        >
          <Popup>
            <div style={{ minWidth: 180, fontFamily: 'inherit' }}>
              <strong style={{ color: GRADE_COLOR[s.grade] }}>
                {GRADE_LABEL[s.grade]}
              </strong>{' '}
              <span style={{ color: '#52525b' }}>· RQSI {s.rqsi}</span>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {s.lengthM} m · {s.defectCount} defect{s.defectCount === 1 ? '' : 's'}
                {/* "0 defects · none" read as if something were missing - say nothing
                    when there is nothing to be worst. */}
                {s.defectCount > 0 ? ` · worst severity ${s.worstSeverity}` : ''}
              </div>
              <div style={{ fontSize: 11, color: '#71717a' }}>
                segment {s.index + 1} · density {s.density}/100 m
                {s.offRoute > 0 ? ` · ${s.offRoute} placed off-track` : ''}
              </div>
              {s.passes > 1 && (
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  <strong>{s.passes} passes</strong> cover this stretch
                  {s.disagree
                    ? ' and grade it differently'
                    : ' and agree on the grade'}
                  {' · '}jobs {s.jobIds.map((id) => `#${id}`).join(', ')}
                </div>
              )}
            </div>
          </Popup>
        </Polyline>
      ))}
      {located.map((d) => {
        const group = hazardOf.get(d.id!);
        return (
        <Marker
          key={d.id}
          position={[d.lat as number, d.lon as number]}
          icon={pin(d.severity, d.id === activeId, d.surface)}
          eventHandlers={{ click: () => onSelect(d.id!) }}
        >
          <Popup>
            <div style={{ minWidth: 180, fontFamily: 'inherit' }}>
              <strong className="capitalize">
                {d.hazardType.replace('_', '-')} · severity {d.severity}
              </strong>
              {d.surface === 'sidewalk' && (
                <div style={{ fontSize: 12, color: '#38bdf8' }}>
                  on sidewalk — not in the roadway grade
                </div>
              )}
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {[d.street, d.crossStreet].filter(Boolean).join(' @ ') || 'street unknown'}
              </div>
              <div style={{ fontSize: 12, color: '#52525b' }}>
                {d.serviceCode} · {d.priority} · {(d.confidence * 100).toFixed(0)}%
              </div>
              <div style={{ fontSize: 11, marginTop: 4, color: '#71717a' }}>
                {d.reviewStatus}
                {d.osmDisagrees ? ' · map disagrees' : ''}
                {d.needsReview ? ' · needs review' : ''}
              </div>
              {group && group.passes > 1 && (
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 4,
                    color: group.state === 'disputed' ? '#f59e0b' : '#22c55e',
                  }}
                >
                  {group.state === 'disputed'
                    ? `${group.passes} passes disagree on what this is`
                    : `seen in ${group.passes} passes`}
                </div>
              )}
            </div>
          </Popup>
        </Marker>
        );
      })}
    </MapContainer>
      {segments.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded border border-zinc-700 bg-zinc-950/85 px-2.5 py-2 text-[11px] text-zinc-300">
          <div className="mb-1.5 font-medium uppercase tracking-wider text-zinc-500">
            Route quality
          </div>
          {(['green', 'yellow', 'red'] as const).map((g) => (
            <div key={g} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-5 rounded-sm"
                style={{ background: GRADE_COLOR[g] }}
              />
              <span>{GRADE_LABEL[g]}</span>
              <span className="ml-auto tabular-nums text-zinc-500">
                {route.counts[g]}
              </span>
            </div>
          ))}
          <div className="mt-1.5 border-t border-zinc-800 pt-1 text-zinc-500">
            {segments.length} segments · {Math.round(route.totalLengthM)} m
          </div>
          {segments.some((s) => s.passes > 1) && (
            <div className="mt-1 text-zinc-500">
              {segments.filter((s) => s.passes > 1).length} shared ·{' '}
              {segments.filter((s) => s.disagree).length} disagree
            </div>
          )}
        </div>
      )}
    </div>
  );
}
