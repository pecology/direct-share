// 接続コード・接続用URLの組み立てと解釈（6.1）
import { CODE_LENGTH, decodeBase32, encodeBase32, formatCode, invalidChars, normalizeCode } from './base32.ts';
import { validate } from './settings.ts';

export type ParseResult =
  | { secret: Uint8Array<ArrayBuffer>; brokers: string[] | null; error?: undefined }
  | { error: string };

export function secretToCode(secret: Uint8Array): string {
  return formatCode(encodeBase32(secret));
}

export function pageUrl(): string {
  return location.origin + location.pathname;
}

/** brokers が null ならブローカー設定を含めない */
export function buildUrl(base: string, secret: Uint8Array, brokers: readonly string[] | null): string {
  let hash = secretToCode(secret);
  if (brokers) hash += '&b=' + brokers.map(encodeURIComponent).join(',');
  return `${base}#${hash}`;
}

/** URLの # 以降の文字列を解釈する */
export function parseHash(hash: string): ParseResult {
  try {
    const [codePart, ...params] = hash.replace(/^#/, '').split('&');
    const result = parseCode(decodeURIComponent(codePart));
    if (result.error !== undefined) return result;
    let brokers: string[] | null = null;
    for (const p of params) {
      if (!p.startsWith('b=')) continue;
      const list = p.slice(2).split(',').filter(Boolean).map(decodeURIComponent);
      if (validate('mqtt', list).length) return { error: 'URL内のブローカー設定が正しくありません' };
      brokers = list;
    }
    return { secret: result.secret, brokers };
  } catch {
    return { error: 'URLの形式が正しくありません' };
  }
}

export function parseCode(input: string): ParseResult {
  const code = normalizeCode(input);
  const bad = invalidChars(code);
  if (bad.length) return { error: `使えない文字が含まれています：${bad.join(' ')}` };
  if (code.length !== CODE_LENGTH) return { error: `接続コードは${CODE_LENGTH}文字です（入力：${code.length}文字）` };
  const secret = decodeBase32(code);
  if (!secret) return { error: '接続コードが正しくありません' };
  return { secret, brokers: null };
}

/** 参加画面の入力欄の値（接続コードまたは接続用URL）を解釈する（F-14） */
export function parseInput(input: string): ParseResult {
  const text = input.trim();
  if (!text) return { error: '接続コードまたはURLを入力してください' };
  const hashIndex = text.indexOf('#');
  if (hashIndex >= 0) return parseHash(text.slice(hashIndex + 1));
  if (/^https?:\/\//i.test(text)) return { error: 'URLに接続情報（# 以降）が含まれていません' };
  return parseCode(text);
}

export function looksLikeUrl(text: string): boolean {
  return /[:/#]/.test(text);
}
