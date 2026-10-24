// Crockford's Base32（I, L, O, U を除く32文字）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_LENGTH = 16; // 80ビット

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** 正規化済みの文字列をバイト列に戻す。不正な文字があれば null */
export function decodeBase32(str: string): Uint8Array<ArrayBuffer> | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 手入力のゆれを吸収する（F-15） */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.・ー－‐]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 正規化後の文字列のうち、使えない文字の一覧 */
export function invalidChars(normalized: string): string[] {
  return [...new Set([...normalized].filter((ch) => !ALPHABET.includes(ch)))];
}

export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? '';
}
