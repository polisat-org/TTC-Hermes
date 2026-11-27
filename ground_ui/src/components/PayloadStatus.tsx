import type { State } from '../store';

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });

type Chip = { label: string; value: string; cls: 'good' | 'busy' | 'bad' | '' };

/**
 * Estado e erros do programa do payload. Só no modo Pi (--pi): sem OBC/TT&C no meio, o Pi manda
 * os próprios avisos (SDR fora do USB, decodificador caído, start falhando) para facilitar os testes.
 */
export function PayloadStatus({ s }: { s: State }) {
  if (s.link?.source !== 'pi') return null;
  const h = s.link.payload;
  const chips: Chip[] = h
    ? [
        {
          label: 'Mission',
          value: h.ativo ? 'running' : h.pedido ? 'starting…' : 'off',
          cls: h.ativo ? 'good' : h.pedido ? 'busy' : '',
        },
        { label: 'SDR (USB)', value: h.sdr_usb === null ? 'simulated' : h.sdr_usb ? 'connected' : 'NOT FOUND', cls: h.sdr_usb === false ? 'bad' : h.sdr_usb ? 'good' : '' },
        {
          label: 'ADS-B decoder',
          value: h.decodificador === null ? '—' : h.decodificador ? 'running' : 'STOPPED',
          cls: h.decodificador === false ? 'bad' : h.decodificador ? 'good' : '',
        },
        { label: 'Read errors', value: String(h.erros_json), cls: h.erros_json ? 'busy' : '' },
      ]
    : [];
  const log = [...s.deviceLog].reverse().slice(0, 100);
  const problems = s.deviceLog.filter((l) => l.level !== 'info').length;
  return (
    <section className="panel payload-status">
      <div className="row-between">
        <h2>
          Payload status {problems > 0 && <span className="count bad">{problems}</span>}
        </h2>
      </div>
      {!s.link.connected ? (
        <p className="hint warn-text">No answer from the payload ({s.link.error ?? s.link.port}).</p>
      ) : !h ? (
        <p className="hint">Waiting for the payload status…</p>
      ) : (
        <div className="status-chips">
          {chips.map((c) => (
            <div key={c.label} className="status-chip-row">
              <span className="muted">{c.label}</span>
              <span className={`state-chip ${c.cls}`}>{c.value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="scroll small console">
        {log.length === 0 && <span className="muted">No warnings or errors from the payload.</span>}
        {log.map((l, i) => (
          <div key={i} className={l.level === 'erro' ? 'bad' : l.level === 'aviso' ? 'warn' : 'muted'}>
            <span className="muted">{clock(l.t)}</span> {l.level === 'info' ? '' : l.level === 'erro' ? 'ERROR ' : 'WARNING '}
            {l.text}
          </div>
        ))}
      </div>
    </section>
  );
}
