import { Fragment, useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { colorFor, destination } from '../geo';
import { useNow, type State, type Track } from '../store';

const DEFAULT_CENTER: [number, number] = [-34.5776, -58.5196]; // UNSAM
const STALE_MS = 30_000;

/** Grade lat/lon: referência visual quando não há internet para os tiles. */
function Graticule() {
  const map = useMap();
  const [, setTick] = useState(0);
  useMapEvents({ moveend: () => setTick((x) => x + 1), zoomend: () => setTick((x) => x + 1) });
  const b = map.getBounds();
  const span = Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest());
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10].find((s) => span / s <= 12) ?? 10;
  const lines: [number, number][][] = [];
  for (let la = Math.floor(b.getSouth() / step) * step; la <= b.getNorth(); la += step)
    lines.push([
      [la, b.getWest() - step],
      [la, b.getEast() + step],
    ]);
  for (let lo = Math.floor(b.getWest() / step) * step; lo <= b.getEast(); lo += step)
    lines.push([
      [b.getSouth() - step, lo],
      [b.getNorth() + step, lo],
    ]);
  return (
    <>
      {lines.map((l, i) => (
        <Polyline key={i} positions={l} pathOptions={{ color: '#3a4656', weight: 1, interactive: false }} />
      ))}
    </>
  );
}

function FitButton({ tracks, sat }: { tracks: Track[]; sat: [number, number] | null }) {
  const map = useMap();
  const fit = () => {
    const pts: [number, number][] = tracks.flatMap((t) => t.points.map((p) => [p.lat, p.lon] as [number, number]));
    if (sat) pts.push(sat);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13 });
  };
  // Enquadra automaticamente quando os primeiros dados chegam.
  const has = tracks.length > 0 || sat !== null;
  useEffect(() => {
    if (has) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [has]);
  return (
    <div className="leaflet-top leaflet-right">
      <div className="leaflet-control map-ctl">
        <button onClick={fit}>Fit all</button>
      </div>
    </div>
  );
}

export function MapView({ s, selected, onSelect }: { s: State; selected: number | null; onSelect: (id: number | null) => void }) {
  const now = useNow();
  const [base, setBase] = useState<'dark' | 'osm' | 'none'>('dark');
  const [projMin, setProjMin] = useState(5);
  const [onlyActive, setOnlyActive] = useState(false);
  // A telemetria do OBC não tem a posição do satélite (fica parado no local da prova).
  const sat: [number, number] | null = null;

  const tracks = useMemo(
    () => [...s.tracks.values()].filter((t) => t.points.length > 0 && (!onlyActive || now - t.lastT < STALE_MS)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.tracks, s.tracks.size, onlyActive, now, s.payloadFrames],
  );

  return (
    <section className="panel map-panel" style={{ position: 'relative' }}>
      <div className="map-toolbar">
        <h2>Aircraft trajectories</h2>
        <label>
          Map{' '}
          <select value={base} onChange={(e) => setBase(e.target.value as 'dark' | 'osm' | 'none')}>
            <option value="dark">Dark (online)</option>
            <option value="osm">Streets (online)</option>
            <option value="none">Grid only (offline)</option>
          </select>
        </label>
        <label title="Dashed line: where each aircraft will be if it keeps its current heading and speed">
          Predict{' '}
          <select value={projMin} onChange={(e) => setProjMin(Number(e.target.value))}>
            {[0, 2, 5, 10, 30].map((m) => (
              <option key={m} value={m}>
                {m ? `${m} min ahead` : 'off'}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> active only
        </label>
      </div>
      <MapContainer center={DEFAULT_CENTER} zoom={9} className="map" preferCanvas>
        {base === 'dark' && (
          <TileLayer
            key="dark"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap"
            className="tiles-dark"
            maxZoom={18}
          />
        )}
        {base === 'osm' && <TileLayer key="osm" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" maxZoom={18} />}
        {base === 'none' && <Graticule />}
        <FitButton tracks={tracks} sat={sat} />
        {tracks.map((t) => {
          const color = colorFor(t.id);
          const stale = now - t.lastT > STALE_MS;
          const sel = selected === t.id;
          const pos = t.points.map((p) => [p.lat, p.lon] as [number, number]);
          const last = pos[pos.length - 1];
          const proj =
            projMin && t.speed && t.heading !== null && !stale
              ? destination(last[0], last[1], t.heading, t.speed * 0.514444 * projMin * 60) // kt -> m/s
              : null;
          return (
            <Fragment key={t.id}>
              <Polyline
                positions={pos}
                pathOptions={{ color, weight: sel ? 4 : 2, opacity: stale ? 0.35 : 0.9 }}
                eventHandlers={{ click: () => onSelect(t.id) }}
              />
              {proj && <Polyline positions={[last, proj]} pathOptions={{ color, weight: 1.5, dashArray: '6 6', opacity: 0.7 }} />}
              <CircleMarker center={pos[0]} radius={3} pathOptions={{ color, fillOpacity: 0.3, weight: 1 }}>
                <Tooltip>first seen · {hexId(t.id)}</Tooltip>
              </CircleMarker>
              <CircleMarker
                center={last}
                radius={sel ? 8 : 6}
                pathOptions={{ color: '#0b0f14', weight: 2, fillColor: color, fillOpacity: stale ? 0.4 : 1 }}
                eventHandlers={{ click: () => onSelect(t.id) }}
              >
                <Tooltip permanent={sel} direction="top" offset={[0, -6]}>
                  {hexId(t.id)}
                  {t.altitude !== null && ` · ${Math.round(t.altitude)} ft`}
                  {t.speed !== null && ` · ${t.speed.toFixed(0)} kt`}
                  {t.heading !== null && ` · ${t.heading.toFixed(0)}°`}
                </Tooltip>
              </CircleMarker>
            </Fragment>
          );
        })}
        {sat && (
          <CircleMarker center={sat} radius={9} pathOptions={{ color: '#f5f7fa', weight: 2, fillColor: '#e0a030', fillOpacity: 1 }}>
            <Tooltip>Hermes CubeSat</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
      {s.tracks.size === 0 && (
        <div className="map-empty">
          <b>No aircraft yet</b>
          <span>
            {s.tm.length === 0
              ? 'Waiting for the satellite to start talking…'
              : 'Turn on ADS-B Mission in Mission control and press Send.'}
          </span>
        </div>
      )}
      <div className="legend">
        <span>
          <i className="lg-dot" /> aircraft now
        </span>
        <span>
          <i className="lg-line" /> path flown
        </span>
        <span>
          <i className="lg-dash" /> predicted path
        </span>
        <span>
          <i className="lg-origin" /> first seen
        </span>
        <span className="muted">Click an aircraft for details. Times are ground arrival times.</span>
      </div>
    </section>
  );
}

export const hexId = (id: number) => id.toString(16).toUpperCase().padStart(6, '0'); // ICAO 24 bits
