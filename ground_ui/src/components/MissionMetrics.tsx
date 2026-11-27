import { store, type State } from '../store';

type Verdict = 'good' | 'bad' | '';

function Row({ label, value, target, verdict, detail }: { label: string; value: string; target: string; verdict: Verdict; detail?: string }) {
  return (
    <div className="metric-row">
      <div>
        <span className="metric-label">{label}</span>
        {detail && <small className="muted"> · {detail}</small>}
      </div>
      <span className="metric-value">{value}</span>
      <span className={`state-chip ${verdict}`}>{target}</span>
    </div>
  );
}

function Meta({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="metric-target">
      {label}
      <input type="number" min={0} step={step} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
    </label>
  );
}

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);

/**
 * Critérios de sucesso da missão (HLR-ADS-08), contados desde o Start (ou o último Clear):
 * mensagens decodificadas a bordo, perda de quadros 'P' (buracos no seq) e latência entre a recepção
 * da posição a bordo e a transmissão da telemetria (tx_met_ms - last_pos_met_ms). Metas editáveis.
 */
export function MissionMetrics({ s }: { s: State }) {
  const m = s.metrics;
  const t = store.targets;
  const sent = m.pRecv + m.pLost;
  const loss = pct(m.pLost, sent);
  const lat = m.latMs;
  const sorted = lat.length ? [...lat].sort((a, b) => a - b) : [];
  const maxS = sorted.length ? sorted[sorted.length - 1] / 1000 : null;
  const meanS = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length / 1000 : null;
  const p95S = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] / 1000 : null;
  const has = m.pRecv > 0;
  const vDec: Verdict = !has ? '' : m.decoded >= t.minDecoded ? 'good' : 'bad';
  const vLoss: Verdict = !has ? '' : loss <= t.maxLossPct ? 'good' : 'bad';
  const vLat: Verdict = maxS === null ? '' : maxS <= t.maxLatencyS ? 'good' : 'bad';
  const all = vDec === 'good' && vLoss === 'good' && vLat === 'good';
  return (
    <section className="panel mission-metrics">
      <div className="row-between">
        <h2>Mission success</h2>
        <span className={`state-chip ${!has ? '' : all ? 'good' : 'bad'}`}>{!has ? 'no data yet' : all ? 'criteria met' : 'not met yet'}</span>
      </div>
      <p className="hint">HLR-ADS-08 · since Start / Clear</p>
      <Row label="Decoded messages" value={has ? String(m.decoded) : '—'} target={`≥ ${t.minDecoded}`} verdict={vDec} detail="on board, from the ADS-B decoder" />
      <Row
        label="Data loss"
        value={has ? `${loss.toFixed(1)} %` : '—'}
        target={`≤ ${t.maxLossPct} %`}
        verdict={vLoss}
        detail={has ? `${m.pLost} of ${sent} aircraft frames${m.tRecv ? ` · telemetry ${m.tLost} lost` : ''}` : undefined}
      />
      <Row
        label="Latency (max)"
        value={maxS === null ? '—' : `${maxS.toFixed(1)} s`}
        target={`≤ ${t.maxLatencyS} s`}
        verdict={vLat}
        detail={meanS === null ? 'reception → telemetry transmission' : `mean ${meanS.toFixed(1)} s · p95 ${p95S!.toFixed(1)} s · ${sorted.length} positions`}
      />
      <details className="metric-targets">
        <summary>Targets (defined by the team)</summary>
        <Meta label="Min. decoded messages" value={t.minDecoded} step={50} onChange={(v) => store.setTargets({ minDecoded: v })} />
        <Meta label="Max. data loss (%)" value={t.maxLossPct} step={1} onChange={(v) => store.setTargets({ maxLossPct: v })} />
        <Meta label="Max. latency (s)" value={t.maxLatencyS} step={1} onChange={(v) => store.setTargets({ maxLatencyS: v })} />
      </details>
    </section>
  );
}
