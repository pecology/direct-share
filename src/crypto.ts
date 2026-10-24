// シグナリング用の暗号（S-01, S-02, S-10）
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SECRET_BYTES = 10; // 80ビット

export interface Room {
  topic: string;
  key: CryptoKey;
}

export function randomSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

export function randomId(bytes = 8): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 秘密値からトピック名（SHA-256）と暗号鍵（HKDF → AES-GCM）を導出する */
export async function deriveRoom(secret: Uint8Array<ArrayBuffer>): Promise<Room> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', concat(enc.encode('direct-share/topic/v1:'), secret)),
  );
  const topic = `direct-share/${toHex(digest.slice(0, 16))}`;

  const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('direct-share/v1'), info: enc.encode('signaling-key') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { topic, key };
}

export async function encryptMessage(room: Room, obj: object): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(room.topic) },
    room.key,
    enc.encode(JSON.stringify(obj)),
  );
  return concat(iv, new Uint8Array(ct));
}

/** 復号・改ざん検知に失敗した場合は null */
export async function decryptMessage(room: Room, bytes: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown> | null> {
  if (bytes.length < 13) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(room.topic) },
      room.key,
      bytes.slice(12),
    );
    const obj: unknown = JSON.parse(dec.decode(pt));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
