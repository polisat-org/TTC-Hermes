// Espelha a saída de bridge/protocol.mjs (que espelha common/telemetry.h).

// Telemetry_t do OBC (customTypes.h), 85 B. Unidades: °C, %, hPa, V, A; bateria em mV e carga em %;
// status/falha = registradores 0x0C/0x0D do MP2733.
export interface Telemetry {
  hora: number;
  minuto: number;
  segundo: number;
  dia: number;
  mes: number;
  ano: number;
  temperatura_bateria: number;
  temperatura_estrutura: number;
  umidade: number;
  pressao: number;
  deploy_antena: number;
  tensao_13v8: number;
  tensao_5v: number;
  corrente_13v8: number;
  corrente_5v: number;
  tensao_painel_solar_1: number;
  tensao_painel_solar_2: number;
  tensao_painel_solar_3: number;
  tensao_painel_solar_4: number;
  status_carregador_1: number;
  status_carregador_2: number;
  falha_carregador_1: number;
  falha_carregador_2: number;
  adc_tensao_sistema_1: number;
  adc_tensao_sistema_2: number;
  adc_tensao_ntc_1: number;
  adc_tensao_ntc_2: number;
  adc_corrente_carga_1: number;
  adc_corrente_carga_2: number;
  adc_corrente_sistema_1: number;
  adc_corrente_sistema_2: number;
  angulo_apontamento: string;
  tensao_bateria_1: number;
  tensao_bateria_2: number;
  carga_bateria_1: number;
  carga_bateria_2: number;
  taxa_carga_descarga_bateria_1: number;
  taxa_carga_descarga_bateria_2: number;
  azimuth: number | null; // angulo_apontamento em graus
}

// PlaneDown_t do OBC (28 B). NaN = campo ausente.
export interface Plane {
  icao: number;
  latitude: number;
  longitude: number;
  altitude_ft: number;
  velocity_kt: number;
  track_deg: number;
  last_pos_met_ms: number;
}

// Trailer do controle térmico (TCS) do payload, repassado pelo OBC no quadro 'H'.
export interface Thermal {
  magic: string;
  version: number;
  valid: boolean;
  age_s: number | null;
  probes_c: (number | null)[];
  duty_pct: [number, number];
  situation: [number, number];
  tcs_time_s: number;
  mission: boolean;
  planes: number;
  crc_ok: boolean;
}

export interface LinkInfo {
  mode: 'serial' | 'sim' | 'replay';
  port: string;
  connected: boolean;
  error?: string | null;
  bytesRx: number;
  bytesTx: number;
  logDir: string | null;
}

export interface ParserStats {
  frames: number;
  telemetry: number;
  payload: number;
  thermal: number;
  azimuth: number;
  ack: number;
  droppedBytes: number;
  rejected: number;
}

export type BridgeEvent =
  | { type: 'telemetry'; t: number; data: Telemetry }
  | { type: 'payload'; t: number; planes: Plane[] }
  | { type: 'thermal'; t: number; data: Thermal }
  | { type: 'azimuth'; t: number; value: number }
  | { type: 'ack'; t: number; cmd: number; status: number }
  | { type: 'cmd_sent'; t: number; cmd: number }
  | { type: 'console'; t: number; text: string };

export type BridgeMessage =
  | BridgeEvent
  | { type: 'snapshot'; link: LinkInfo; events: BridgeEvent[] }
  | { type: 'link'; link: LinkInfo }
  | { type: 'stats'; link: LinkInfo; parser: ParserStats }
  | { type: 'error'; t: number; text: string };

export const CMD_BITS = [
  { bit: 0, key: 'mission', label: 'Mission' },
  { bit: 1, key: 'deploy', label: 'Deploy' },
  { bit: 2, key: 'detumbling', label: 'Detumbling' },
  { bit: 3, key: 'pointing', label: 'Pointing' },
] as const;

export const CMD_STATUS_LABEL: Record<number, string> = { 0: 'Confirmed', 1: 'Failed', 2: 'Busy' };
