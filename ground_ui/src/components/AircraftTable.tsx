import { colorFor } from '../geo';
import { store, useNow, type State, type Track } from '../store';
import { hexId } from './MapView';

function exportCsv(tracks: Track[]) {
  const rows = ['pc_time_iso,pc_time_ms,id_hex,type,flags,latitude,longitude,confidence'];
  for (const t of tracks)
    for (const p of t.points) rows.push([new Date(p.t).toISOString(), p.t, hexId(t.id), t.type, t.flags, p.lat, p.lon, p.confidence].join(','));
  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `aircraft-tracks-${new Date().toISOString().slice(0, 19)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
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
          <button className="ghost" onClick={() => exportCsv(tracks)} disabled={!tracks.length} title="Download every position as CSV">
            Export CSV
          </button>
          <button className="ghost" onClick={() => confirm('Clear the tracks on screen? (the log on disk is kept)') && store.clearTracks()}>
            Clear
          </button>
        </div>
      </div>
      <div className="scroll">
        <table className="aircraft">
          <thead>
            <tr>
              <th />
              <th>ID</th>
              <th>Speed</th>
              <th>Heading</th>
              <th>Points</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => {
              const age = (now - t.lastT) / 1000;
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
                  <td>{t.speed === null ? '—' : `${(t.speed * 1.94384).toFixed(0)} kt`}</td>
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
            <b>Aircraft {hexId(sel.id)}</b>
            <button className="ghost x" onClick={() => onSelect(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="detail-grid">
            <span>Position</span>
            <b>
              {sel.points[sel.points.length - 1].lat.toFixed(4)}, {sel.points[sel.points.length - 1].lon.toFixed(4)}
            </b>
            <span>First seen at</span>
            <b>
              {sel.points[0].lat.toFixed(4)}, {sel.points[0].lon.toFixed(4)}
            </b>
            <span>Tracked for</span>
            <b>{((sel.lastT - sel.firstT) / 1000).toFixed(0)} s</b>
            <span>Signal confidence</span>
            <b>{(sel.points[sel.points.length - 1].confidence * 100).toFixed(0)} %</b>
            <span>Type / flags</span>
            <b>
              {sel.type} / <code>{sel.flags.toString(2).padStart(8, '0')}</code>
            </b>
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
