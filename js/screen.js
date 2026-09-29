import * as fb from './fb.js';
import {
  GIDS, TEAMS, TOPIC_COUNT, $, esc, fatal, watchRoom, roomIdFromUrl, joinUrl, qs,
  orderedPhotos, photoNo, photoSrc, gidOf, teamName, teamOf, sideOf, groupLabel,
  teamRound, scoreTable, timerRemaining, fmtMs, qrSvg,
} from './common.js';

const app = $('#app');
const roomId = roomIdFromUrl();
const TEAM_COLORS = ['var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)'];
if (qs.has('preview')) document.body.classList.add('preview');

start().catch((e) => { console.error(e); fatal(e.message || String(e)); });

async function start() {
  await fb.init();
  if (!roomId) throw new Error('주소에 방 코드(room)가 없어요.');
  await fb.syncClock(roomId);
  let lastKey = '';
  const S = watchRoom(roomId, {}, () => {
    const out = render(S);
    if (out.key === lastKey) { renderHeadOnly(S); return; }
    lastKey = out.key;
    app.innerHTML = out.html;
    renderHeadOnly(S);
    const fs = $('#fs');
    if (fs) fs.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  });
  setInterval(() => tickTimer(S), 250);
}

function tickTimer(S) {
  const el = $('#stimer');
  if (!el || !S.room) return;
  const tm = S.room.timer, rem = timerRemaining(tm);
  if (rem === null || !tm.show) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = fmtMs(rem);
  el.className = 'timer' + (rem === 0 ? ' zero' : '') + (tm.status === 'paused' ? ' paused' : '');
}

function renderHeadOnly(S) {
  const el = $('#subm');
  if (!el || !S.room) return;
  const r = S.room.currentRound, rd = S.rounds[r];
  if (rd && (rd.phase === 'selecting' || rd.phase === 'closed')) {
    const n = GIDS.filter((g) => S.status[r]?.[g]?.submitted).length;
    el.textContent = `제출 ${n} / 8${rd.phase === 'closed' ? ' · 마감' : ''}`;
  } else el.textContent = '';
  tickTimer(S);
}

function render(S) {
  const room = S.room;
  if (room === undefined) return { key: 'loading', html: '<div class="loading">불러오는 중…</div>' };
  if (room === null) return { key: 'none', html: `<div class="scr"><div class="scr-msg"><div><h2>방을 찾을 수 없어요</h2><p>${esc(roomId)}</p></div></div></div>` };

  const d = room.display || { view: 'lobby' };
  const r = room.currentRound || 0;
  const rd = S.rounds[r];
  const revealed = rd?.phase === 'revealed';
  const tp = rd?.topics || [];
  const photos = orderedPhotos(S);
  const answersKey = revealed ? JSON.stringify(GIDS.map((g) => S.answers[r]?.[g]?.submitted || null)) : '';
  const joinedKey = GIDS.map((g) => (S.groups[g] ? 1 : 0)).join('');
  const key = JSON.stringify([d, r, rd?.phase, tp, photos, Object.keys(S.photos).length, answersKey,
    d.view === 'lobby' ? joinedKey : '', room.teams, room.game, room.roundCount,
    (d.view === 'scores' || d.view === 'final') ? scoreTable(S).rows : '']);

  const head = `<div class="scr-head"><div class="logo">매치<b style="color:var(--accent)">?</b> 매치<b style="color:var(--accent)">!</b></div>
    ${r ? `<div class="rnd">${r} / ${room.roundCount} 라운드</div>` : ''}<div class="subm" id="subm"></div>
    <div class="timer" id="stimer" hidden></div></div>`;
  const wrap = (body) => `<div class="scr">${head}<div class="scr-body">${body}</div></div><button class="fs-btn" id="fs">전체화면</button>`;
  const needReveal = () => wrap(`<div class="scr-msg"><div><h2>답 공개 전</h2><p>진행자가 답을 공개하면 비교 화면이 나와요.</p></div></div>`);
  const img = (pid) => (pid ? `<img src="${photoSrc(S, pid)}" alt="">` : '');
  const chip = (t) => `<span class="chip" style="background:${TEAM_COLORS[t - 1]}"></span>`;

  let body;
  switch (d.view) {
    case 'board': {
      body = `<div class="board" style="grid-template-columns:repeat(6,minmax(0,1fr));grid-template-rows:repeat(5,minmax(0,1fr))">
        ${photos.map((pid, i) => `<div class="btile">${img(pid)}<span class="no">${i + 1}</span></div>`).join('')}</div>`;
      break;
    }
    case 'bundle': {
      const size = d.bundleSize || 6;
      const pages = Math.max(1, Math.ceil(photos.length / size));
      const page = Math.min(Math.max(0, d.bundle || 0), pages - 1);
      const sub = photos.slice(page * size, page * size + size);
      const cols = { 4: 4, 6: 3, 8: 4, 10: 5 }[size] || 3;
      const rows = Math.ceil(size / cols);
      body = `<div class="scr-title">사진 ${page * size + 1}–${page * size + sub.length} <span style="font-size:2.6vh;color:#9ea1b3;font-weight:700">(${page + 1}/${pages})</span></div>
        <div class="board" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(0,1fr));gap:1.4vh">
        ${sub.map((pid) => `<div class="btile big contain">${img(pid)}<span class="no">${photoNo(S, pid)}</span></div>`).join('')}</div>`;
      break;
    }
    case 'photo': {
      const i = Math.min(Math.max(1, d.photo || 1), photos.length || 1);
      const pid = photos[i - 1];
      body = pid ? `<div class="single">${img(pid)}<span class="no">${i}</span></div>` : '';
      break;
    }
    case 'topics': {
      if (!tp.length) { body = `<div class="scr-msg"><div><h2>곧 주제가 공개돼요</h2></div></div>`; break; }
      body = `<div class="topics-board">${tp.map((t, i) => `<div class="tb"><span class="num">${i + 1}</span><span class="txt">${esc(t)}</span></div>`).join('')}
        <div class="tb" style="background:transparent;border:.3vh dashed #3a3d4c"><span class="txt" style="font-size:3vh;color:#9ea1b3">주제마다 서로 다른 사진 1장씩<br>같은 팀 A·B가 같은 사진이면 +1</span></div></div>`;
      break;
    }
    case 'topic': {
      const k = Math.min(Math.max(1, d.topic || 1), TOPIC_COUNT);
      body = tp.length ? `<div class="topic-one"><div><div class="num">${k}</div><div class="txt">${esc(tp[k - 1])}</div></div></div>` : '';
      break;
    }
    case 'team': {
      if (!revealed) return { key, html: needReveal() };
      const t = d.team || 1;
      const res = teamRound(S, t, r);
      body = `<div class="scr-title">${chip(t)} ${esc(teamName(room, t))} <span style="font-size:3vh;color:#9ea1b3">A그룹 vs B그룹</span><span class="team-score">${res.score}점</span></div>
        <div class="team-cmp" style="grid-template-columns:repeat(7,minmax(0,1fr))">${tp.map((tt, i) => {
          const c = res.cells[i];
          return `<div class="tc ${c.match ? 'match' : ''}"><div class="tt"><span class="num">${i + 1}</span><span>${esc(tt)}</span></div>
            <div class="pair" style="grid-template-rows:1fr 1fr">
              <div class="ph">${c.a ? img(c.a) : '<div class="empty">미제출</div>'}<span class="lab">A</span></div>
              <div class="ph">${c.b ? img(c.b) : '<div class="empty">미제출</div>'}<span class="lab">B</span></div></div>
            <div class="res">${c.match ? '일치 +1' : '0'}</div></div>`;
        }).join('')}</div>`;
      break;
    }
    case 'teamTopic': {
      if (!revealed) return { key, html: needReveal() };
      const t = d.team || 1, k = Math.min(Math.max(1, d.topic || 1), TOPIC_COUNT);
      const c = teamRound(S, t, r).cells[k - 1];
      body = `<div class="scr-title">${chip(t)} ${esc(teamName(room, t))} · <span style="color:var(--accent)">${k}</span> ${esc(tp[k - 1])}</div>
        <div class="zoom2">
          <div class="side"><div class="lab">A그룹${c.a ? ` · 사진 ${photoNo(S, c.a)}` : ''}</div><div class="img">${c.a ? img(c.a) : '<span style="font-size:4vh;color:#6c6f80">미제출</span>'}</div></div>
          <div class="mid ${c.match ? 'match' : 'miss'}">${c.match ? '일치!<small>+1점</small>' : '불일치<small>0점</small>'}</div>
          <div class="side"><div class="lab">B그룹${c.b ? ` · 사진 ${photoNo(S, c.b)}` : ''}</div><div class="img">${c.b ? img(c.b) : '<span style="font-size:4vh;color:#6c6f80">미제출</span>'}</div></div>
        </div>`;
      break;
    }
    case 'all': {
      if (!revealed) return { key, html: needReveal() };
      let cells = `<div></div>${tp.map((t, i) => `<div class="h"><span><span class="num">${i + 1}</span>${esc(t)}</span></div>`).join('')}`;
      TEAMS.forEach((t) => {
        const res = teamRound(S, t, r);
        ['A', 'B'].forEach((sd) => {
          cells += `<div class="gname">${chip(t)}${esc(teamName(room, t))} ${sd}${sd === 'B' ? ` <span style="color:#9ea1b3;font-size:2.2vh">${res.score}점</span>` : ''}</div>`;
          res.cells.forEach((c) => { const pid = sd === 'A' ? c.a : c.b; cells += `<div class="cell ${c.match ? 'match' : ''}">${img(pid)}</div>`; });
        });
      });
      body = `<div class="alltbl" style="grid-template-rows:auto repeat(8,minmax(0,1fr))">${cells}</div>`;
      break;
    }
    case 'topicAll': {
      if (!revealed) return { key, html: needReveal() };
      const k = Math.min(Math.max(1, d.topic || 1), TOPIC_COUNT);
      body = `<div class="scr-title"><span style="color:var(--accent)">${k}</span> ${esc(tp[k - 1])} <span style="font-size:3vh;color:#9ea1b3">— 전체 팀</span></div>
        <div class="topicall">${TEAMS.map((t) => {
          const c = teamRound(S, t, r).cells[k - 1];
          return `<div class="team ${c.match ? 'match' : ''}"><div class="tn">${chip(t)}${esc(teamName(room, t))}<span class="pt">${c.match ? '+1' : '0'}</span></div>
            <div class="ph">${img(c.a)}<span class="lab">A</span></div><div class="ph">${img(c.b)}<span class="lab">B</span></div></div>`;
        }).join('')}</div>`;
      break;
    }
    case 'scores':
    case 'final': {
      const tb = scoreTable(S);
      const fin = d.view === 'final';
      body = `<div class="scr-title" style="justify-content:center;font-size:${fin ? 7 : 5}vh">${fin ? '🏆 최종 순위' : '점수판'}</div>
        <div class="scores">${tb.sorted.map((x) => `<div class="sr ${fin && x.rank === 1 ? 'first' : ''}">
          <div class="rk">${x.rank}</div>
          <div><div class="nm">${chip(x.t)}${esc(x.name)}</div><div class="per">${tb.rounds.map((rr, i) => `R${rr} ${x.per[i]}점`).join(' · ') || '아직 공개된 라운드가 없어요'}</div></div>
          <div class="tot">${x.total}</div></div>`).join('')}</div>`;
      break;
    }
    case 'lobby':
    default: {
      const url = joinUrl(roomId);
      body = `<div class="lobby"><div class="qrbig">${qrSvg(url)}</div><div>
        <h1>매치<b>?</b> 매치<b>!</b></h1>
        <div class="url">${esc(url.replace(/^https?:\/\//, ''))}</div>
        <div class="joined">${GIDS.map((g) => `<div class="jg ${S.groups[g] ? 'in' : ''}">${esc(teamName(room, teamOf(g)))} ${sideOf(g)}</div>`).join('')}</div>
      </div></div>`;
    }
  }
  return { key, html: wrap(body) };
}
