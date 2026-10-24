import './style.css';
import { formatCode, normalizeCode } from './base32.ts';
import { buildUrl, looksLikeUrl, pageUrl, parseHash, parseInput, secretToCode } from './connInfo.ts';
import { startGuest, startHost, type Controller, type GuestFailReason } from './connection.ts';
import { randomId, randomSecret } from './crypto.ts';
import { encodeQr, qrToSvg } from './qr.ts';
import { Session, type FileItem, type Item } from './session.ts';
import { DEFAULTS, isDefaultMqtt, loadSettings, parseLines, resetSettings, saveSettings } from './settings.ts';

const EXPIRY_MS = 10 * 60 * 1000; // F-06

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type ScreenName = 'wait' | 'join' | 'connecting' | 'error' | 'main';
type StatusName = 'waiting' | 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<StatusName, string> = {
  waiting: '待機中',
  connecting: '接続中',
  connected: '接続済み',
  disconnected: '切断',
};

const hasKeyboard = matchMedia('(hover: hover) and (pointer: fine)').matches;
const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const selfId = randomId();
let settings = loadSettings();
let currentScreen: ScreenName = 'wait';

function show(name: ScreenName) {
  currentScreen = name;
  for (const el of document.querySelectorAll<HTMLElement>('.screen')) el.hidden = el.id !== `screen-${name}`;
}

function setStatus(state: StatusName) {
  for (const el of document.querySelectorAll<HTMLElement>('[data-status]')) {
    el.dataset.state = state;
    el.textContent = STATUS_LABEL[state];
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('コピーできませんでした');
  }
  toast('コピーしました');
}

// ---- ホスト（待機画面） ----

let hostGen = 0;
let hostCtl: Controller | null = null;
let expiryTimer: ReturnType<typeof setInterval> | undefined;
let expiresAt = 0;
let hostJoining = false;
let hostCode = '';
let hostUrl = '';

function stopHosting() {
  hostGen++;
  hostCtl?.close();
  hostCtl = null;
  clearInterval(expiryTimer);
}

async function startHosting() {
  stopHosting();
  const gen = hostGen;
  show('wait');
  setStatus('waiting');
  hostJoining = false;
  $('joining').hidden = true;
  $('broker-error').hidden = true;

  settings = loadSettings();
  const secret = randomSecret();
  const customBrokers = !isDefaultMqtt(settings.mqtt);
  hostCode = secretToCode(secret);
  hostUrl = buildUrl(pageUrl(), secret, customBrokers ? settings.mqtt : null); // F-75
  $('code').textContent = hostCode;
  $('qr').replaceChildren(qrToSvg(encodeQr(hostUrl)));
  $('broker-note').hidden = !customBrokers; // F-76

  expiresAt = Date.now() + EXPIRY_MS;
  updateExpiry();
  expiryTimer = setInterval(updateExpiry, 1000);

  const ctl = await startHost({
    secret,
    brokers: settings.mqtt,
    stun: settings.stun,
    selfId,
    onBrokerChange: (s) => {
      $('broker-error').hidden = !(s.ready === 0 && s.failed === s.total);
    },
    onJoin: () => {
      hostJoining = true;
      setStatus('connecting');
      $('joining').hidden = false;
    },
    onConnected: (pc, dc) => {
      stopHosting();
      enterMain(pc, dc);
    },
    onFail: () => {
      toast('接続できませんでした。新しい接続情報で待機します');
      void startHosting();
    },
  });
  if (gen !== hostGen) ctl.close();
  else hostCtl = ctl;
}

function updateExpiry() {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0 && !hostJoining) {
    void startHosting(); // 期限切れで自動更新
    return;
  }
  const sec = Math.max(0, Math.ceil(remaining / 1000));
  $('expiry').textContent = `残り ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

$('copy-code').addEventListener('click', () => void copyText(hostCode));
$('copy-url').addEventListener('click', () => void copyText(hostUrl));
$('refresh').addEventListener('click', () => void startHosting());
$('go-join').addEventListener('click', () => showJoin());

// ---- ゲスト（参加・接続中・エラー画面） ----

interface GuestInfo {
  secret: Uint8Array<ArrayBuffer>;
  brokers: string[] | null;
}

let guestGen = 0;
let guestCtl: Controller | null = null;
let lastGuest: GuestInfo | null = null;

function stopGuesting() {
  guestGen++;
  guestCtl?.close();
  guestCtl = null;
}

function showJoin() {
  stopHosting();
  stopGuesting();
  show('join');
  $('join-error').textContent = '';
  if (hasKeyboard) $('join-input').focus();
}

async function startGuesting(info: GuestInfo) {
  stopHosting();
  stopGuesting();
  const gen = guestGen;
  lastGuest = info;
  show('connecting');
  setStatus('connecting');
  // URLにブローカー設定があればこの接続に限りそれを使う（F-75）
  const ctl = await startGuest({
    secret: info.secret,
    brokers: info.brokers ?? settings.mqtt,
    stun: settings.stun,
    selfId,
    onConnected: (pc, dc) => {
      guestCtl = null;
      enterMain(pc, dc);
    },
    onFail: (reason) => {
      guestCtl = null;
      showError(reason, info.brokers !== null);
    },
  });
  if (gen !== guestGen) ctl.close();
  else guestCtl = ctl;
}

const ERRORS: Record<GuestFailReason, { reason: string; hints: string[] }> = {
  broker: {
    reason: 'MQTTブローカーに接続できませんでした。',
    hints: ['ネットワークに接続されているか確認する', '設定でMQTTブローカーを変更する'],
  },
  nohost: {
    reason: '相手からの応答がありません。',
    hints: [
      '相手の待機画面が開いたままか確認する',
      '接続コードが期限切れ・使用済みでないか確認する（相手の画面で「更新」して再入力）',
      'コード入力の場合、相手とMQTTブローカーの設定を揃える',
    ],
  },
  p2p: {
    reason: '端末間の直接通信を確立できませんでした。',
    hints: [
      '両方の端末を同じWi-Fiに接続して試す',
      'モバイル回線や社内ネットワークでは接続できない場合がある（TURN非対応）',
      '設定でSTUNサーバーを確認する',
    ],
  },
};

function showError(reason: GuestFailReason, fromUrl: boolean) {
  show('error');
  setStatus('disconnected');
  const info = ERRORS[reason];
  $('error-reason').textContent = info.reason;
  const hints = reason === 'nohost' && fromUrl ? info.hints.filter((h) => !h.startsWith('コード入力')) : info.hints;
  $('error-hints').replaceChildren(
    ...hints.map((h) => {
      const li = document.createElement('li');
      li.textContent = h;
      return li;
    }),
  );
}

const joinInput = $<HTMLInputElement>('join-input');

// 入力中に自動でハイフン区切りに整形する
joinInput.addEventListener('input', () => {
  const v = joinInput.value;
  $('join-error').textContent = '';
  if (looksLikeUrl(v) || joinInput.selectionStart !== v.length) return;
  const formatted = formatCode(normalizeCode(v));
  if (formatted !== v) joinInput.value = formatted;
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const result = parseInput(joinInput.value);
  if (result.error !== undefined) {
    $('join-error').textContent = result.error;
    return;
  }
  void startGuesting(result);
});

$('join-back').addEventListener('click', () => void startHosting());
$('connecting-cancel').addEventListener('click', () => {
  stopGuesting();
  showJoin();
});
$('retry').addEventListener('click', () => {
  if (lastGuest) void startGuesting(lastGuest);
});
$('reinput').addEventListener('click', () => showJoin());

// ---- メイン画面 ----

let session: Session | null = null;
const historyEl = $<HTMLOListElement>('history');
const textInput = $<HTMLTextAreaElement>('text-input');
const fileInput = $<HTMLInputElement>('file-input');

function enterMain(pc: RTCPeerConnection, dc: RTCDataChannel) {
  show('main');
  setStatus('connected');
  historyEl.replaceChildren();
  textInput.value = '';
  resizeTextInput();
  session = new Session(pc, dc, {
    onItem: renderItem,
    onNotice: toast,
    onBusyChange: setBusy,
    onClose: (reason) => {
      session = null;
      historyEl.replaceChildren(); // F-64
      toast(reason === 'local' ? '切断しました' : '相手が切断しました');
      void startHosting(); // F-62
    },
  });
  addSystem('接続しました');
  if (!hasKeyboard) addSystem('別のアプリに切り替えたり画面を消したりすると、切断されることがあります');
  if (hasKeyboard) textInput.focus();
}

function addSystem(text: string) {
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  historyEl.append(li);
  scrollToBottom();
}

function scrollToBottom() {
  historyEl.scrollTop = historyEl.scrollHeight;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, className?: string) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

/** URLをリンクにしたテキストノード列（F-33） */
function linkify(text: string): Node[] {
  const nodes: Node[] = [];
  const re = /https?:\/\/[^\s<>"'「」（）]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:!?)\]}、。]+$/, '');
    const start = m.index;
    if (start > last) nodes.push(document.createTextNode(text.slice(last, start)));
    const a = el('a', undefined, url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nodes.push(a);
    last = start + url.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function renderItem(item: Item) {
  let li = historyEl.querySelector<HTMLLIElement>(`li[data-id="${item.id}"]`);
  const isNew = !li;
  const nearBottom = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 80;

  if (li && item.kind === 'file' && li.dataset.status === item.status) {
    // 進捗だけの更新
    updateProgress(li, item);
    return;
  }
  if (!li) {
    li = el('li', `msg${item.mine ? ' mine' : ''}`);
    li.dataset.id = item.id;
    historyEl.append(li);
  }

  if (item.kind === 'text') {
    const bubble = el('div', 'bubble');
    bubble.append(...linkify(item.body));
    const meta = el('div', 'meta');
    meta.append(el('span', undefined, formatTime(item.ts)), button('コピー', () => void copyText(item.body)));
    li.replaceChildren(bubble, meta);
  } else {
    li.dataset.status = item.status;
    li.replaceChildren(...renderFile(item));
    updateProgress(li, item);
  }
  if (isNew || nearBottom) scrollToBottom();
}

const FILE_STATUS_LABEL: Record<FileItem['status'], string> = {
  queued: '送信待ち',
  sending: '送信中',
  sent: '送信済み',
  receiving: '受信中',
  received: '受信済み',
  released: '破棄済み',
  cancelled: 'キャンセルしました',
  rejected: '受信できませんでした',
  failed: '失敗しました',
};

function renderFile(item: FileItem): HTMLElement[] {
  const bubble = el('div', 'bubble file');
  const sub = el('div', 'file-sub');
  sub.dataset.role = 'sub';
  bubble.append(el('div', 'file-name', item.name), sub);
  if (item.status === 'queued' || item.status === 'sending' || item.status === 'receiving') {
    const bar = el('div', 'progress');
    bar.append(el('span'));
    bubble.append(bar);
  }

  const meta = el('div', 'meta');
  meta.append(el('span', undefined, formatTime(item.ts)));
  switch (item.status) {
    case 'queued':
    case 'sending':
    case 'receiving':
      meta.append(button('キャンセル', () => session?.cancel(item.id), 'danger'));
      break;
    case 'received':
      if (item.saved) meta.append(el('span', undefined, '保存済み'));
      meta.append(
        button('保存', () => void saveFile(item)),
        button('破棄', () => session?.release(item.id), 'danger'),
      );
      break;
  }
  return [bubble, meta];
}

function updateProgress(li: HTMLElement, item: FileItem) {
  const sub = li.querySelector<HTMLElement>('[data-role="sub"]');
  const active = item.status === 'sending' || item.status === 'receiving';
  const pct = item.size ? Math.floor((item.transferred / item.size) * 100) : active ? 0 : 100;
  if (sub) {
    sub.textContent = `${formatSize(item.size)}・${FILE_STATUS_LABEL[item.status]}${active ? ` ${pct}%` : ''}`;
  }
  const bar = li.querySelector<HTMLElement>('.progress > span');
  if (bar) bar.style.width = `${active ? pct : 0}%`;
}

async function saveFile(item: FileItem) {
  if (!item.blob) return;
  const file = new File([item.blob], item.name, { type: item.blob.type });
  // iOS は共有シート経由の方が保存しやすい（R-08）
  if (isIos && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      session?.markSaved(item.id);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = el('a');
  a.href = url;
  a.download = item.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  session?.markSaved(item.id);
}

function resizeTextInput() {
  textInput.style.height = 'auto';
  textInput.style.height = `${textInput.scrollHeight + 2}px`;
}

function sendTextInput() {
  if (!session) return;
  const text = textInput.value;
  if (!text.trim()) return;
  const error = session.sendText(text);
  if (error) return toast(error);
  textInput.value = '';
  resizeTextInput();
}

textInput.addEventListener('input', resizeTextInput);
textInput.addEventListener('keydown', (e) => {
  // 物理キーボードがあれば Enter で送信、Shift+Enter で改行
  if (hasKeyboard && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendTextInput();
  }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendTextInput();
  if (hasKeyboard) textInput.focus();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) session?.sendFiles([...fileInput.files]);
  fileInput.value = '';
});
$('disconnect').addEventListener('click', () => session?.close());

// ドラッグ＆ドロップ（F-42）
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!session && !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer?.files.length) session?.sendFiles([...e.dataTransfer.files]);
});

// ---- スリープ防止（U-06） ----

let busy = false;
let wakeLock: WakeLockSentinel | null = null;
let wakeLockWarned = false;

function warnWakeLock() {
  if (wakeLockWarned) return;
  wakeLockWarned = true;
  toast('この端末では画面のスリープ防止が使えません。転送中は画面を消さないでください');
}

async function setBusy(value: boolean) {
  busy = value;
  if (!busy) {
    const lock = wakeLock;
    wakeLock = null;
    await lock?.release().catch(() => {});
    return;
  }
  if (wakeLock) return;
  if (!('wakeLock' in navigator)) return warnWakeLock();
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!busy) return void lock.release();
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    warnWakeLock();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && busy && !wakeLock) void setBusy(true);
});

// ---- ページを閉じる・リロード（F-65） ----

window.addEventListener('beforeunload', (e) => {
  if (!session) return;
  e.preventDefault();
  e.returnValue = '';
});
window.addEventListener('pagehide', () => session?.close());

// ---- 設定（8.7） ----

const settingsDialog = $<HTMLDialogElement>('settings');
const setStun = $<HTMLTextAreaElement>('set-stun');
const setMqtt = $<HTMLTextAreaElement>('set-mqtt');

function fillSettings(s: { stun: readonly string[]; mqtt: readonly string[] }) {
  setStun.value = s.stun.join('\n');
  setMqtt.value = s.mqtt.join('\n');
  $('settings-errors').replaceChildren();
}

function applySettingsChange() {
  settings = loadSettings();
  settingsDialog.close();
  if (currentScreen === 'wait' && !hostJoining) void startHosting();
}

for (const b of document.querySelectorAll('[data-open-settings]')) {
  b.addEventListener('click', () => {
    fillSettings(loadSettings());
    settingsDialog.showModal();
  });
}
$('settings-save').addEventListener('click', () => {
  const errors = saveSettings({ stun: parseLines(setStun.value), mqtt: parseLines(setMqtt.value) });
  if (errors.length) {
    $('settings-errors').replaceChildren(...errors.map((msg) => el('li', undefined, msg)));
    return;
  }
  toast('設定を保存しました');
  applySettingsChange();
});
$('settings-reset').addEventListener('click', () => {
  resetSettings();
  fillSettings(DEFAULTS);
  toast('デフォルトの設定に戻しました');
  applySettingsChange();
});
$('settings-close').addEventListener('click', () => settingsDialog.close());

// ---- 起動 ----

/** URLの # 以降に接続情報があればゲストとして接続する（F-11） */
function handleHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  history.replaceState(null, '', location.pathname + location.search); // S-07
  if (session) {
    toast('接続中のため、新しい接続情報は無視しました');
    return true;
  }
  const result = parseHash(hash);
  if (result.error !== undefined) {
    toast(result.error);
    return false;
  }
  void startGuesting(result);
  return true;
}

window.addEventListener('hashchange', () => void handleHash());
if (!handleHash()) void startHosting();
