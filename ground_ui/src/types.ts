// Espelha a saída de bridge/protocol.mjs (que espelha common/telemetry.h).

export interface Telemetry {
  timestamp_ms: number;
  uptime_ms: number;
  mode: number;
  flags: number;
  error_count: number;
  battery_voltage: number;
  battery_current: number;
  temperature: number;
  gyro: [number, number, number];
  accel: [number, number, number];
  mag: [number, number, number];
  latitude: number;
  longitude: number;
  altitude: number;
  deploy_state: number;
  detumbling_state: number;
  pointing_state: number;
  mission_state: number;
  command_count: number;
  telemetry_count: number;
  packet_count: number;
  reserved: number[];
  azimuth_str: string | null;
}

export interface Plane {
  id: number;
  type: number;
  flags: number;
  latitude: number;
  longitude: number;
  confidence: number;
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
  ack: number;
  droppedBytes: number;
  rejected: number;
}

export type BridgeEvent =
  | { type: 'telemetry'; t: number; data: Telemetry }
  | { type: 'payload'; t: number; planes: Plane[] }
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
