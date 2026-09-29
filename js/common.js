import * as fb from './fb.js';
import qrcode from './vendor/qrcode.mjs';

export const TEAMS = [1, 2, 3, 4];
export const SIDES = ['A', 'B'];
export const GIDS = ['T1A', 'T1B', 'T2A', 'T2B', 'T3A', 'T3B', 'T4A', 'T4B'];
export const PHOTO_COUNT = 30;
export const TOPIC_COUNT = 7;
export const MAX_ROUNDS = 5;
export const ONLINE_MS = 45000;

export const qs = new URLSearchParams(location.search);
export const roomIdFromUrl = () => (qs.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 테스트 모드 파라미터(mock, mockuid)를 다른 페이지 링크에도 이어 붙인다.
export function pageUrl(page, roomId, extra = {}) {
  const u = new URL(page, location.href);
  if (roomId) u.searchParams.set('room', roomId);
  if (fb.isMock) u.searchParams.set('mock', '1');
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
export function joinUrl(roomId) {
  const u = new URL('index.html', location.href);
  u.search = '';
  u.searchParams.set('room', roomId);
  if (fb.isMock) u.searchParams.set('mock', '1');
  return u.toString();
}

export const teamOf = (gid) => Number(gid[1]);
export const sideOf = (gid) => gid[2];
export const gidOf = (t, s) => `T${t}${s}`;
export const teamName = (room, t) => (room?.teams?.[t - 1] || `${t}팀`);
export const groupLabel = (room, gid) => `${teamName(room, teamOf(gid))} ${sideOf(gid)}그룹`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function isOnline(g) {
  return !!g && g.online !== false && typeof g.lastSeen === 'number' && fb.serverNow() - g.lastSeen < ONLINE_MS;
}

/* ---------- 방 상태 구독 ---------- */
export function watchRoom(roomId, { host = false } = {}, onChange) {
  const s = {
    roomId, room: undefined, photos: {}, groups: {}, rounds: {}, status: {}, answers: {}, setup: undefined,
    errors: [],
  };
  let queued = false;
  const emit = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; onChange(s); }); };
  const base = `rooms/${roomId}`;
  const answerSubs = new Set();

  fb.onDoc(base, (d) => { s.room = d; emit(); }, (e) => { s.errors.push(e); emit(); });
  fb.onCol(`${base}/photos`, (list) => { s.photos = Object.fromEntries(list.map((x) => [x.id, x.data])); emit(); });
  fb.onCol(`${base}/groups`, (list) => { s.groups = Object.fromEntries(list.map((x) => [x.id, x.data])); emit(); });
  if (host) fb.onDoc(`${base}/private/setup`, (d) => { s.setup = d; emit(); });

  for (let r = 1; r <= MAX_ROUNDS; r++) {
    s.status[r] = {};
    fb.onDoc(`${base}/rounds/${r}`, (d) => {
      s.rounds[r] = d;
      if (d && d.phase === 'revealed' && !answerSubs.has(r)) {
        answerSubs.add(r);
        s.answers[r] = {};
        for (const gid of GIDS) {
          fb.onDoc(`${base}/rounds/${r}/answers/${gid}`, (a) => { s.answers[r][gid] = a; emit(); });
        }
      }
      emit();
    });
    fb.onCol(`${base}/rounds/${r}/status`, (list) => { s.status[r] = Object.fromEntries(list.map((x) => [x.id, x.data])); emit(); });
  }
  // 접속 표시가 시간에 따라 바뀌므로 주기적으로 다시 그림
  setInterval(emit, 5000);
  return s;
}

export const orderedPhotos = (s) => (s.room?.photoOrder || []).filter((id) => s.photos[id]);
export const photoNo = (s, pid) => (s.room?.photoOrder || []).indexOf(pid) + 1;
// data URL을 한 번만 Blob URL로 바꿔 두고 재사용한다 (다시 그릴 때 큰 문자열을 매번 파싱하지 않도록).
const urlCache = new Map();
export function photoSrc(s, pid) {
  const p = s.photos[pid];
  if (!p || !p.src) return '';
  const key = p.src.length + ':' + p.src.slice(-24);
  const c = urlCache.get(pid);
  if (c && c.key === key) return c.url;
  try {
    const [head, b64] = p.src.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    urlCache.set(pid, { key, url });
    return url;
  } catch { return p.src; }
}

/* ---------- 채점 ---------- */
// 같은 팀 A·B그룹이 같은 주제 칸에 같은 사진을 제출했을 때만 1점. 미제출/빈칸은 0점.
export function teamRound(s, t, r) {
  const A = s.answers[r]?.[gidOf(t, 'A')]?.submitted || null;
  const B = s.answers[r]?.[gidOf(t, 'B')]?.submitted || null;
  const cells = [];
  let score = 0;
  for (let k = 0; k < TOPIC_COUNT; k++) {
    const a = A?.[k] || '';
    const b = B?.[k] || '';
    const match = !!a && !!b && a === b;
    if (match) score++;
    cells.push({ a, b, match });
  }
  return { score, cells, aSubmitted: !!A, bSubmitted: !!B };
}
export const revealedRounds = (s) => {
  const out = [];
  for (let r = 1; r <= (s.room?.roundCount || 0); r++) if (s.rounds[r]?.phase === 'revealed') out.push(r);
  return out;
};
export function scoreTable(s) {
  const rounds = revealedRounds(s);
  const rows = TEAMS.map((t) => {
    const per = rounds.map((r) => teamRound(s, t, r).score);
    return { t, name: teamName(s.room, t), per, total: per.reduce((a, b) => a + b, 0) };
  });
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  sorted.forEach((row, i) => { row.rank = i > 0 && row.total === sorted[i - 1].total ? sorted[i - 1].rank : i + 1; });
  return { rounds, rows, sorted };
}

/* ---------- 타이머 ---------- */
export function timerRemaining(timer) {
  if (!timer || timer.status === 'idle') return null;
  if (timer.status === 'paused') return Math.max(0, timer.remainingMs || 0);
  return Math.max(0, (timer.endsAt || 0) - fb.serverNow());
}
export function fmtMs(ms) {
  const sec = Math.ceil(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------- 이미지 ---------- */
export function resizeImage(file, max = 1100) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.82, out = c.toDataURL('image/jpeg', q);
      while (out.length > 600000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했어요: ' + file.name)); };
    img.src = url;
  });
}

export function qrSvg(text, cell = 6) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

/* ---------- UI 도우미 ---------- */
export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export function dialog({ title = '', body = '', ok = '확인', cancel = '취소', danger = false, extra = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      ${title ? `<h3>${esc(title)}</h3>` : ''}
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        ${cancel ? `<button class="btn ghost" data-v="cancel">${esc(cancel)}</button>` : ''}
        ${extra ? `<button class="btn" data-v="extra">${esc(extra)}</button>` : ''}
        <button class="btn ${danger ? 'danger' : 'primary'}" data-v="ok">${esc(ok)}</button>
      </div></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (!v && e.target !== wrap) return;
      wrap.remove();
      resolve(v === 'ok' ? true : v === 'extra' ? 'extra' : false);
    });
  });
}

export function fatal(msg) {
  document.body.innerHTML = `<div class="fatal"><h2>문제가 생겼어요</h2><p>${esc(msg)}</p>
    <button class="btn primary" onclick="location.reload()">새로고침</button></div>`;
}
