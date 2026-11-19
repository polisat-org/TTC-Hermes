import { store, useNow, type State } from '../store';

const MISSION_MS = 10 * 60 * 1000; // HLR-ADS-05: 10 continuous minutes

const mmss = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export function linkSummary(s: State, now: number) {
  const tm = s.tm[s.tm.length - 1];
  const age = tm ? (now - tm.t) / 1000 : null;
  if (s.ws !== 'open') return { tone: 'bad', title: 'Dashboard offline', detail: 'Start the bridge (npm run bridge)' };
  if (!s.link?.connected) return { tone: 'bad', title: 'Ground station disconnected', detail: s.link?.error ?? 'Plug in the ESP32' };
  if (age === null) return { tone: 'warn', title: 'Waiting for the satellite', detail: 'Connected, no telemetry yet' };
  if (age > 5) return { tone: 'warn', title: 'Signal lost', detail: `Last data ${age.toFixed(0)} s ago` };
  return { tone: 'ok', title: 'Receiving data', detail: `Last packet ${age.toFixed(1)} s ago` };
}

export function TopBar({ s }: { s: State }) {
  const now = useNow(500);
  const elapsed = s.missionStart !== null ? now - s.missionStart : 0;
  const pct = Math.min(100, (100 * elapsed) / MISSION_MS);
  const link = linkSummary(s, now);
  const mode = s.link?.mode;

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/brand/hermes-patch.webp" alt="Hermes mission patch" className="patch" />
        <div>
          <div className="brand-title">
            HERMES <span>Ground Station</span>
          </div>
          <div className="brand-sub">
            CubeDesign 2026 · ADS-B air surveillance
            {mode === 'sim' && <span className="tag warn">SIMULATOR</span>}
            {mode === 'replay' && <span className="tag info">REPLAY</span>}
          </div>
        </div>
      </div>

      <div className="mission-clock">
        <div className="clock-row">
          <span className="clock-label">Mission time</span>
          <span className="clock">{s.missionStart === null ? '--:--' : mmss(elapsed)}</span>
          <span className="clock-total">/ 10:00</span>
          {s.missionStart === null ? (
            <button className="ghost" onClick={() => store.startMission()}>
              Start
            </button>
          ) : (
            <button className="ghost" onClick={() => store.resetMission()}>
              Reset
            </button>
          )}
        </div>
        <div className="progress" title="The rules require 10 continuous minutes of mission">
          <div className={`bar ${pct >= 100 ? 'done' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className={`link-pill ${link.tone}`}>
        <span className="pulse" />
        <div>
          <b>{link.title}</b>
          <small>{link.detail}</small>
        </div>
      </div>

      <img src="/brand/polisat-logo.svg" alt="PoliSat" className="polisat" />
    </header>
  );
}
