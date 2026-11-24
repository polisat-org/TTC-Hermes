import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNow, type State } from '../store';

interface Pt {
  t: number;
  y: number;
}

interface Spec {
  key: string;
  title: string;
  unit: string;
  series: (s: State) => Pt[];
  ref?: { y: number; label: string };
  digits: number;
  empty: string;
}

const mvToV = (mv: number) => (mv > 0 ? mv / 1000 : NaN);

// Uma medida por gráfico (sem eixo duplo). Linhas de referência = limites das regras.
// 'T' chega a cada 60 s; o térmico ('H') a cada 5 s durante a missão.
const SPECS: Spec[] = [
  {
    key: 'tcs',
    title: 'Battery temperature (coldest TCS probe)',
    unit: '°C',
    series: (s) =>
      s.thermal.map((h) => {
        const v = h.probes_c.filter((x): x is number => x !== null);
        return { t: h.t, y: v.length ? Math.min(...v) : NaN };
      }),
    ref: { y: 0, label: 'keep battery above 0 °C' },
    digits: 2,
    empty: 'Arrives every 5 s while the ADS-B mission is on.',
  },
  {
    key: 'tb',
    title: 'Battery / structure temperature (housekeeping)',
    unit: '°C',
    series: (s) => s.tm.map((p) => ({ t: p.t, y: p.temperatura_bateria })),
    ref: { y: 0, label: 'keep battery above 0 °C' },
    digits: 1,
    empty: 'One point per telemetry frame (every 60 s).',
  },
  {
    key: 'vb',
    title: 'Battery 1 voltage',
    unit: 'V',
    series: (s) => s.tm.map((p) => ({ t: p.t, y: mvToV(p.tensao_bateria_1) })),
    digits: 3,
    empty: 'One point per telemetry frame (every 60 s).',
  },
  {
    key: 'bus',
    title: '13.8 V bus',
    unit: 'V',
    series: (s) => s.tm.map((p) => ({ t: p.t, y: p.tensao_13v8 })),
    digits: 2,
    empty: 'One point per telemetry frame (every 60 s).',
  },
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
  const thin = (pts: Pt[]) => {
    const k = Math.ceil(pts.length / MAX_POINTS);
    return k > 1 ? pts.filter((_, i) => i % k === 0 || i === pts.length - 1) : pts;
  };

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
      <div className="charts">
        {SPECS.map((spec) => {
          const pts = thin(spec.series(s).filter((p) => p.t >= from));
          const t0 = pts[0]?.t ?? now;
          const data = pts.map((p) => ({ x: (p.t - t0) / 1000, y: p.y, t: p.t }));
          const last = data[data.length - 1]?.y;
          return (
            <figure key={spec.key} className="chart">
              <figcaption>
                {spec.title}{' '}
                <b>
                  {last === undefined || Number.isNaN(last) ? '—' : last.toFixed(spec.digits)} {spec.unit}
                </b>
              </figcaption>
              {data.length === 0 && <p className="empty">{spec.empty}</p>}
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
                  <Line type="monotone" dataKey="y" stroke="var(--chart)" strokeWidth={2} dot={data.length < 30} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </figure>
          );
        })}
      </div>
    </section>
  );
}
