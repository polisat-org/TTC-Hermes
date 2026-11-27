import { colorFor } from '../geo';
import { store, useNow, type State, type Track } from '../store';
import { hexId } from './MapView';

function exportCsv(tracks: Track[], callsigns: Map<number, string>) {
  const rows = ['pc_time_iso,pc_time_ms,icao_hex,callsign,latitude,longitude,altitude_ft'];
  for (const t of tracks)
    for (const p of t.points) rows.push([new Date(p.t).toISOString(), p.t, hexId(t.id), callsigns.get(t.id) ?? '', p.lat, p.lon, p.alt].join(','));
  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `aircraft-tracks-${new Date().toISOString().slice(0, 19)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
  store.markExported();
}

/** Reset com proteção: se há posições não exportadas, oferece exportar antes de apagar. */
function resetResults(tracks: Track[], callsigns: Map<number, string>) {
  if (store.hasUnexported()) {
    if (confirm('There are results that have not been exported yet.\n\nOK: export the CSV and then clear.\nCancel: other options.')) {
      exportCsv(tracks, callsigns);
    } else if (!confirm('Clear WITHOUT exporting? The unsaved results will be lost from the screen (the bridge log on disk is kept).')) {
      return;
    }
  } else if (!confirm('Clear the results on screen? (everything was already exported; the log on disk is kept)')) {
    return;
  }
  store.resetResults();
}

export function AircraftTable({ s, selected, onSelect }: { s: State; selected: number | null; onSelect: (id: number | null) => void }) {
  const now = useNow();
  const tracks = [...s.tracks.values()].sort((a, b) => b.lastT - a.lastT);
  const sel = selected !== null ? s.tracks.get(selected) : undefined;
  return (
    <section className="panel aircraft-panel">
      <div className="row-between">
        <h2>
          Aircraft tracked <span className="count">{tracks.length}</span>
        </h2>
        <div className="btns">
          <button className="ghost" onClick={() => exportCsv(tracks, s.callsigns)} disabled={!tracks.length} title={store.hasUnexported() ? 'Download every position as CSV (there are unsaved results)' : 'Download every position as CSV'}>
            Export CSV
          </button>
          <button className="ghost" onClick={() => resetResults(tracks, s.callsigns)} disabled={!tracks.length} title="Clear aircraft, tracks and call signs (asks to export first if needed)">
            Clear
          </button>
        </div>
      </div>
      <div className="scroll">
        <table className="aircraft">
          <thead>
            <tr>
              <th />
              <th>ICAO</th>
              <th>Call sign</th>
              <th>Lat.</th>
              <th>Lon.</th>
              <th>Alt.</th>
              <th>Speed</th>
              <th>Heading</th>
              <th>Points</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => {
              const age = (now - t.lastT) / 1000;
              const pos = t.points[t.points.length - 1];
              return (
                <tr
                  key={t.id}
                  className={`${selected === t.id ? 'sel' : ''} ${age > 30 ? 'stale' : ''}`}
                  onClick={() => onSelect(selected === t.id ? null : t.id)}
                >
                  <td>
                    <i className="swatch" style={{ background: colorFor(t.id) }} />
                  </td>
                  <td>
                    <code>{hexId(t.id)}</code>
                  </td>
                  <td>{s.callsigns.get(t.id) ?? '—'}</td>
                  <td>{pos ? pos.lat.toFixed(4) : '—'}</td>
                  <td>{pos ? pos.lon.toFixed(4) : '—'}</td>
                  <td>{t.altitude === null ? '—' : `${Math.round(t.altitude)} ft`}</td>
                  <td>{t.speed === null ? '—' : `${t.speed.toFixed(0)} kt`}</td>
                  <td>{t.heading === null ? '—' : <Arrow deg={t.heading} />}</td>
                  <td>{t.points.length}</td>
                  <td className={age < 5 ? 'ok' : ''}>{age < 5 ? 'now' : `${age.toFixed(0)} s ago`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tracks.length === 0 && <p className="empty">Aircraft appear here as soon as the ADS-B payload hears them.</p>}
      {sel && (
        <div className="detail">
          <div className="detail-head">
            <i className="swatch" style={{ background: colorFor(sel.id) }} />
            <b>
              Aircraft {hexId(sel.id)}
              {s.callsigns.has(sel.id) ? ` · ${s.callsigns.get(sel.id)}` : ''}
            </b>
            <button className="ghost x" onClick={() => onSelect(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="detail-grid">
            <span>Position</span>
            <b>{sel.points.length ? `${sel.points[sel.points.length - 1].lat.toFixed(4)}, ${sel.points[sel.points.length - 1].lon.toFixed(4)}` : 'no position yet'}</b>
            <span>First seen at</span>
            <b>{sel.points.length ? `${sel.points[0].lat.toFixed(4)}, ${sel.points[0].lon.toFixed(4)}` : '—'}</b>
            <span>Altitude</span>
            <b>{sel.altitude === null ? '—' : `${Math.round(sel.altitude)} ft`}</b>
            <span>Speed / track</span>
            <b>
              {sel.speed === null ? '—' : `${sel.speed.toFixed(0)} kt`} / {sel.heading === null ? '—' : `${sel.heading.toFixed(0)}°`}
            </b>
            <span>Tracked for</span>
            <b>{((sel.lastT - sel.firstT) / 1000).toFixed(0)} s</b>
            <span>Position at mission time</span>
            <b>{sel.lastPosMet ? `${(sel.lastPosMet / 1000).toFixed(1)} s` : '—'}</b>
          </div>
        </div>
      )}
    </section>
  );
}

function Arrow({ deg }: { deg: number }) {
  return (
    <span className="heading">
      <span style={{ display: 'inline-block', transform: `rotate(${deg}deg)` }}>↑</span> {deg.toFixed(0)}°
    </span>
  );
}
