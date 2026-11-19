import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNow, type State, type TmPoint } from '../store';

interface Spec {
  key: string;
  title: string;
  unit: string;
  get: (p: TmPoint) => number;
  ref?: { y: number; label: string };
  digits: number;
}

// Uma medida por gráfico (sem eixo duplo). Linhas de referência = limites das regras.
const SPECS: Spec[] = [
  { key: 'v', title: 'Battery voltage', unit: 'V', get: (p) => p.battery_voltage, digits: 2 },
  { key: 'i', title: 'Battery current', unit: 'A', get: (p) => p.battery_current, ref: { y: 0, label: 'charging above · discharging below' }, digits: 3 },
  { key: 't', title: 'Temperature', unit: '°C', get: (p) => p.temperature, ref: { y: 0, label: 'keep battery above 0 °C' }, digits: 1 },
  { key: 'rpm', title: 'Spin rate', unit: 'rpm', get: (p) => p.rpm, ref: { y: 5, label: 'target: below 5 rpm' }, digits: 1 },
];

const WINDOWS = [
  { label: '2 min', ms: 2 * 60e3 },
  { label: '10 min', ms: 10 * 60e3 },
  { label: '1 h', ms: 60 * 60e3 },
  { label: 'all', ms: Infinity },
];
const MAX_POINTS = 600;

export function TelemetryCharts({ s }: { s: State }) {
  const now = useNow();
  const [win, setWin] = useState(1);
  const from = now - WINDOWS[win].ms;
  let pts = s.tm.filter((p) => p.t >= from);
  if (pts.length > MAX_POINTS) {
    const k = Math.ceil(pts.length / MAX_POINTS);
    pts = pts.filter((_, i) => i % k === 0 || i === pts.length - 1);
  }
  const t0 = pts[0]?.t ?? now;

  return (
    <section className="panel charts-panel">
      <div className="row-between">
        <h2>Telemetry history</h2>
        <div className="seg">
          {WINDOWS.map((w, i) => (
            <button key={w.label} className={i === win ? 'on' : ''} onClick={() => setWin(i)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {pts.length === 0 && <p className="empty">Charts fill in as telemetry arrives (one point per packet).</p>}
      <div className="charts">
        {SPECS.map((spec) => {
          const data = pts.map((p) => ({ x: (p.t - t0) / 1000, y: spec.get(p), t: p.t }));
          const last = data[data.length - 1]?.y;
          return (
            <figure key={spec.key} className="chart">
              <figcaption>
                {spec.title}{' '}
                <b>
                  {last === undefined || Number.isNaN(last) ? '—' : last.toFixed(spec.digits)} {spec.unit}
                </b>
              </figcaption>
              <ResponsiveContainer width="100%" height={130}>
                <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={{ fill: 'var(--muted)', fontSize: 10 }}
                    tickFormatter={(x: number) => `${Math.round(x)}s`}
                    stroke="var(--grid)"
                  />
                  <YAxis tick={{ fill: 'var(--muted)', fontSize: 10 }} stroke="var(--grid)" domain={['auto', 'auto']} width={44} />
                  {spec.ref && (
                    <ReferenceLine
                      y={spec.ref.y}
                      stroke="var(--muted)"
                      strokeDasharray="4 4"
                      label={{ value: spec.ref.label, fill: 'var(--muted)', fontSize: 10, position: 'insideTopRight' }}
                    />
                  )}
                  <Tooltip
                    contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', fontSize: 12 }}
                    labelStyle={{ color: 'var(--muted)' }}
                    itemStyle={{ color: 'var(--text)' }}
                    labelFormatter={(_, p) => (p?.[0] ? new Date(p[0].payload.t).toLocaleTimeString('en-GB', { hour12: false }) : '')}
                    formatter={(v: number) => [`${v.toFixed(spec.digits)} ${spec.unit}`, spec.title]}
                  />
                  <Line type="monotone" dataKey="y" stroke="var(--chart)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </figure>
          );
        })}
      </div>
    </section>
  );
}
