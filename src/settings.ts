// 外部サーバー設定（F-71〜F-80）
const PREFIX = 'direct-share:'; // S-08
const MAX_URLS = 5;

export type SettingKind = 'stun' | 'mqtt';
export type Settings = Record<SettingKind, string[]>;

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  mqtt: ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081', 'wss://broker.hivemq.com:8884/mqtt'],
});

const KINDS: Record<SettingKind, { label: string; prefix: string; min: number; check: (u: string) => boolean }> = {
  stun: { label: 'STUNサーバー', prefix: 'stun:', min: 0, check: (u) => /^stun:[^\s/]+$/.test(u) },
  mqtt: {
    label: 'MQTTブローカー',
    prefix: 'wss://',
    min: 1,
    check: (u) => {
      try {
        return new URL(u).protocol === 'wss:';
      } catch {
        return false;
      }
    },
  },
};

function read(kind: SettingKind): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFIX + kind) ?? 'null');
    if (Array.isArray(v) && v.every((s) => typeof s === 'string') && validate(kind, v).length === 0) return v;
  } catch {
    // 読めない場合はデフォルト
  }
  return [...DEFAULTS[kind]];
}

export function loadSettings(): Settings {
  return { stun: read('stun'), mqtt: read('mqtt') };
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function isDefaultMqtt(list: readonly string[]): boolean {
  return sameList(list, DEFAULTS.mqtt);
}

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** エラーメッセージの配列（空なら正常） */
export function validate(kind: SettingKind, list: readonly string[]): string[] {
  const { label, prefix, min, check } = KINDS[kind];
  const errors: string[] = [];
  if (list.length < min) errors.push(`${label}を${min}件以上入力してください`);
  if (list.length > MAX_URLS) errors.push(`${label}は${MAX_URLS}件までです`);
  for (const u of list) {
    if (!check(u)) errors.push(`${label}の形式が正しくありません（${prefix} で始まるURL）：${u}`);
  }
  return errors;
}

export function saveSettings(settings: Settings): string[] {
  const errors = [...validate('stun', settings.stun), ...validate('mqtt', settings.mqtt)];
  if (errors.length) return errors;
  for (const kind of ['stun', 'mqtt'] as const) {
    // デフォルトと同じなら保存しない（デフォルト値の更新に追従させる）
    if (sameList(settings[kind], DEFAULTS[kind])) localStorage.removeItem(PREFIX + kind);
    else localStorage.setItem(PREFIX + kind, JSON.stringify(settings[kind]));
  }
  return [];
}

export function resetSettings(): void {
  localStorage.removeItem(PREFIX + 'stun');
  localStorage.removeItem(PREFIX + 'mqtt');
}
