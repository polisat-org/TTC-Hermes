import { useNow, type State } from '../store';

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const fmt = (x: number | undefined | null, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? '—' : x.toFixed(d));

function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v ${cls ?? ''}`}>{v}</span>
    </div>
  );
}

/** Detalhes técnicos: enlace, contadores, Telemetry_t completo e console USB. */
export function RawPanel({ s }: { s: State }) {
  const now = useNow();
  const tm = s.tm[s.tm.length - 1];
  const latency = tm && s.minDelayOffset !== null ? tm.t - tm.timestamp_ms - s.minDelayOffset : null;
  const entries = tm
    ? Object.entries(tm).map(([k, v]) => [k, Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'number' ? String(+v.toFixed(5)) : String(v)])
    : [];
  const log = [...s.console.map((c) => ({ ...c, cls: 'muted' })), ...s.errors.map((e) => ({ ...e, cls: 'bad' }))].sort((a, b) => b.t - a.t);

  return (
    <section className="panel advanced">
      <details>
        <summary>
          <h2>Advanced</h2>
          <span className="help">link details, raw telemetry and console</span>
        </summary>

        <h3>Link</h3>
        <Row k="Dashboard ↔ bridge" v={s.ws} cls={s.ws === 'open' ? 'ok' : 'bad'} />
        <Row k={`Ground station (${s.link?.mode ?? '?'})`} v={s.link ? `${s.link.connected ? 'connected' : 'disconnected'} · ${s.link.port}` : '—'} cls={s.link?.connected ? 'ok' : 'bad'} />
        {s.link?.error && <Row k="Error" v={s.link.error} cls="bad" />}
        <Row k="Relative TM latency" v={latency === null ? '—' : `${(latency / 1000).toFixed(2)} s`} />
        <Row k="Aircraft frames" v={s.payloadFrames} />
        {s.parser && <Row k="USB parser" v={<code>{s.parser.frames} ok · {s.parser.rejected} rejected · {s.parser.droppedBytes} B noise</code>} />}
        <Row k="Bytes in / out" v={s.link ? `${s.link.bytesRx} / ${s.link.bytesTx}` : '—'} />
        {s.link?.logDir && <Row k="Session log" v={<code className="path">{s.link.logDir}</code>} />}

        <h3>Satellite</h3>
        {tm ? (
          <>
            <Row k="Last telemetry" v={`${((now - tm.t) / 1000).toFixed(1)} s ago`} />
            <Row k="Position" v={`${fmt(tm.latitude, 5)}, ${fmt(tm.longitude, 5)} · ${fmt(tm.altitude, 0)} m`} />
            <Row k="Mode / flags" v={<code>{tm.mode} / {tm.flags.toString(2).padStart(8, '0')}</code>} />
            <Row k="OBC errors" v={tm.error_count} cls={tm.error_count ? 'warn' : ''} />
            <Row k="Counters" v={<code>cmd {tm.command_count} · tm {tm.telemetry_count} · pkt {tm.packet_count}</code>} />
            <Row k="OBC uptime" v={`${(tm.uptime_ms / 1000).toFixed(0)} s`} />
          </>
        ) : (
          <p className="hint">No telemetry yet.</p>
        )}

        <h3>Telemetry_t (last frame)</h3>
        <div className="scroll small raw">
          {entries.map(([k, v]) => (
            <div key={k} className="kv">
              <span className="k">{k}</span>
              <code className="v">{v}</code>
            </div>
          ))}
        </div>

        <h3>USB console / errors</h3>
        <div className="scroll small console">
          {log.length === 0 && <span className="muted">Nothing yet.</span>}
          {log.slice(0, 200).map((l, i) => (
            <div key={i} className={l.cls}>
              <span className="muted">{clock(l.t)}</span> {l.text}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
