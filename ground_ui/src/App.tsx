import { useState } from 'react';
import { AircraftTable } from './components/AircraftTable';
import { CommandPanel } from './components/CommandPanel';
import { KpiStrip } from './components/KpiStrip';
import { MapView } from './components/MapView';
import { RawPanel } from './components/RawPanel';
import { TelemetryCharts } from './components/TelemetryCharts';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export function App() {
  const s = useStore();
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="app">
      <TopBar s={s} />
      <KpiStrip s={s} />
      <aside className="left">
        <CommandPanel s={s} />
      </aside>
      <main className="center">
        <MapView s={s} selected={selected} onSelect={setSelected} />
        <TelemetryCharts s={s} />
      </main>
      <aside className="right">
        <AircraftTable s={s} selected={selected} onSelect={setSelected} />
        <RawPanel s={s} />
      </aside>
      <footer className="footer">
        <img src="/brand/polisat-symbol.svg" alt="" />
        PoliSat · Escola Politécnica da USP · Hermes TT&amp;C ground segment
      </footer>
    </div>
  );
}
