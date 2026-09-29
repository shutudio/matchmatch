import * as fb from './fb.js';
import {
  GIDS, TEAMS, SIDES, TOPIC_COUNT, $, $$, esc, toast, dialog, fatal, watchRoom, roomIdFromUrl,
  pageUrl, orderedPhotos, photoNo, photoSrc, teamOf, sideOf, gidOf, teamName, groupLabel,
  isOnline, teamRound, scoreTable, timerRemaining, fmtMs,
} from './common.js';

const app = $('#app');
const roomId = roomIdFromUrl();
const TEAM_COLORS = ['var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)'];
const EMPTY = () => Array(TOPIC_COUNT).fill('');

start().catch((e) => { console.error(e); fatal(e.message || String(e)); });

async function start() {
  await fb.init();
  if (!roomId) return landing();
  await fb.syncClock(roomId);
  player();
}

/* ================= 첫 화면 (방 만들기 / 코드 입력) ================= */
function landing() {
  const hosted = JSON.parse(localStorage.getItem('mm:hosted') || '[]');
  app.innerHTML = `<div class="landing">
    <div class="logo">매치<b>?</b> 매치<b>!</b></div>
    <div class="sub">MEGA MT 사진 매칭 게임</div>
    <div class="card">
      <h3>참가자</h3>
      <div class="row"><input id="code" type="text" class="grow" maxlength="6" placeholder="방 코드 4자리" autocomplete="off" style="text-transform:uppercase">
      <button class="btn primary" id="go">입장</button></div>
      <p class="muted" style="margin:8px 0 0;font-size:13px">진행자가 보여주는 QR을 찍어도 바로 들어갈 수 있어요.</p>
    </div>
    <div class="card">
      <h3>진행자</h3>
      <button class="btn dark lg" id="create" style="width:100%">새 게임 방 만들기</button>
      ${hosted.length ? `<div class="subhead">내가 만든 방</div><div class="row">${hosted.slice(-6).reverse().map((c) =>
        `<a class="btn sm" href="${esc(pageUrl('host.html', c))}">${esc(c)}</a>`).join('')}</div>` : ''}
    </div>
  </div>`;
  const go = () => {
    const c = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) return toast('방 코드를 확인해 주세요');
    location.href = pageUrl('index.html', c);
  };
  $('#go').onclick = go;
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('#create').onclick = async () => {
    $('#create').disabled = true;
    try {
      const code = await createRoom();
      hosted.push(code);
      localStorage.setItem('mm:hosted', JSON.stringify(hosted.slice(-20)));
      location.href = pageUrl('host.html', code);
    } catch (e) {
      console.error(e);
      toast('방을 만들지 못했어요: ' + (e.message || e), 'bad');
      $('#create').disabled = false;
    }
  };
}

async function createRoom() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
    const ok = await fb.transaction(async (tx) => {
      if (await tx.get(`rooms/${code}`)) return false;
      tx.set(`rooms/${code}`, {
        hostUid: fb.uid(), createdAt: fb.SERVER_TS, roundCount: 3,
        teams: ['1팀', '2팀', '3팀', '4팀'], photoOrder: [], currentRound: 0, game: 'lobby',
        display: { view: 'lobby' }, timer: { status: 'idle', durationMs: 180000, show: true },
      });
      return true;
    });
    if (ok) return code;
  }
  throw new Error('코드 생성 실패');
}

/* ================= 플레이어 ================= */
function player() {
  const L = {
    gid: null, lostGroup: false,
    round: 0, ansUnsub: null, ans: undefined, ansPending: false,
    draft: EMPTY(), draftLoaded: false, active: 0,
    save: 'idle', saveTimer: null, submitting: false, slow: false,
    gridKey: '', view: '', sheet: null, zoom: null,
  };
  const S = watchRoom(roomId, {}, () => render());

  // 접속 표시(하트비트)
  const beat = (online = true) => {
    if (!L.gid) return;
    fb.updateDoc(`rooms/${roomId}/groups/${L.gid}`, { lastSeen: fb.SERVER_TS, online }).catch(() => {});
  };
  setInterval(() => beat(true), 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(true); });
  addEventListener('pagehide', () => beat(false));

  function myGroup() {
    return GIDS.find((g) => S.groups[g]?.ownerUid === fb.uid()) || null;
  }

  function subscribeAnswers() {
    const r = S.room?.currentRound || 0;
    if (L.gid === L._subGid && r === L.round) return;
    if (L.ansUnsub) L.ansUnsub();
    L.ansUnsub = null;
    L._subGid = L.gid; L.round = r;
    L.ans = undefined; L.draftLoaded = false; L.draft = EMPTY(); L.active = 0; L.save = 'idle';
    L.sheet = null; L.zoom = null;
    if (!L.gid || !r) return;
    L.ansUnsub = fb.onDoc(`rooms/${roomId}/rounds/${r}/answers/${L.gid}`, (d, meta) => {
      L.ans = d; L.ansPending = !!meta?.pending;
      if (!L.draftLoaded) {
        L.draft = (d?.draft?.length === TOPIC_COUNT ? d.draft : d?.submitted) || EMPTY();
        L.draft = L.draft.map((x) => x || '');
        L.draftLoaded = true;
        L.active = Math.max(0, L.draft.indexOf(''));
      }
      render();
    }, () => { L.ans = null; L.draftLoaded = true; render(); });
  }

  function render() {
    const room = S.room;
    if (room === undefined) return;
    if (room === null) { app.innerHTML = `<div class="p-msg" style="padding-top:25vh"><h2>방을 찾을 수 없어요</h2><p class="muted">방 코드(${esc(roomId)})를 다시 확인해 주세요.</p></div>`; return; }

    const prev = L.gid;
    L.gid = myGroup();
    if (prev && !L.gid) toast('이 그룹이 다른 기기로 옮겨졌어요. 그룹을 다시 선택해 주세요.', 'bad');
    if (!prev && L.gid) beat(true);
    subscribeAnswers();

    if (!L.gid) return renderPicker();
    if (room.game === 'final') return renderFinal();
    const r = room.currentRound || 0;
    const rd = S.rounds[r];
    if (!r || !rd) return renderWaiting();
    if (rd.phase === 'selecting') return renderSelect();
    if (rd.phase === 'closed') return renderClosed();
    if (rd.phase === 'revealed') return renderRevealed();
    renderWaiting();
  }

  /* ---------- 공통 헤더 ---------- */
  function head(extra = '') {
    const room = S.room, r = room.currentRound || 0;
    const t = teamOf(L.gid);
    return `<div class="p-head"><div class="top">
      <div class="who"><span class="team-chip" style="background:${TEAM_COLORS[t - 1]}"></span>${esc(groupLabel(room, L.gid))}</div>
      <div class="round">${r ? `${r} / ${room.roundCount} 라운드` : '대기 중'}</div>
      <span class="tag" id="ptimer" hidden></span>
      <div class="state">${stateTag()}</div></div>${extra}</div>`;
  }
  // 타이머 (진행자가 "화면에 표시"를 켰을 때만)
  setInterval(() => {
    const el = $('#ptimer');
    if (!el || !S.room) return;
    const tm = S.room.timer, rem = timerRemaining(tm);
    if (rem === null || !tm.show) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `⏱ ${fmtMs(rem)}${tm.status === 'paused' ? ' 일시정지' : ''}`;
    el.className = 'tag ' + (rem === 0 ? 'bad' : rem < 30000 ? 'warn' : '');
  }, 250);
  function stateTag() {
    const rd = S.rounds[S.room.currentRound || 0];
    if (!rd) return '';
    const sub = serverSubmitted();
    if (rd.phase === 'selecting') {
      if (L.submitting) return `<span class="tag blue">제출 중…</span>`;
      if (!sub) return `<span class="tag warn">미제출</span>`;
      if (isEditing()) return `<span class="tag bad">수정 중 · 재제출 필요</span>`;
      return `<span class="tag ok">제출 완료</span>`;
    }
    if (rd.phase === 'closed') return sub ? `<span class="tag ok">제출 완료 · 마감</span>` : `<span class="tag bad">미제출 · 마감</span>`;
    if (rd.phase === 'revealed') return `<span class="tag blue">결과 공개</span>`;
    return '';
  }
  // 제출은 트랜잭션으로만 기록되므로 submitted 값은 항상 서버에서 확정된 값이다.
  const serverSubmitted = () => (Array.isArray(L.ans?.submitted) ? L.ans.submitted : null);
  const isEditing = () => { const s = serverSubmitted(); return !!s && s.some((p, i) => p !== L.draft[i]); };
  const topics = () => S.rounds[S.room.currentRound]?.topics || [];

  /* ---------- 그룹 선택 ---------- */
  function renderPicker() {
    L.view = 'picker'; L.gridKey = '';
    const room = S.room;
    app.innerHTML = `<div class="p-app">
      <div class="p-head"><div class="top"><div class="who">매치? 매치! 입장</div><div class="round" style="margin-left:auto">방 ${esc(roomId)}</div></div>
      <div class="save-line">우리 팀과 그룹을 골라 주세요. 그룹당 휴대폰 한 대만 사용해요.</div></div>
      <div class="picker">${TEAMS.map((t) => `<div class="team">
        <h4><span class="team-chip" style="background:${TEAM_COLORS[t - 1]}"></span>${esc(teamName(room, t))}</h4>
        <div class="opts">${SIDES.map((sd) => {
          const gid = gidOf(t, sd), g = S.groups[gid];
          if (!g) return `<button class="gbtn" data-g="${gid}">${sd}그룹<small>선택 가능</small></button>`;
          if (g.allowTransfer) return `<button class="gbtn transfer" data-g="${gid}">${sd}그룹<small>진행자가 기기 변경 허용 · 눌러서 이어받기</small></button>`;
          return `<button class="gbtn" disabled>${sd}그룹<small>사용 중${isOnline(g) ? '' : ' (연결 끊김)'}</small></button>`;
        }).join('')}</div></div>`).join('')}
        <p class="muted" style="font-size:13px;text-align:center">이미 사용 중인 그룹으로 돌아가야 하면 진행자에게 “기기 변경 허용”을 요청하세요.</p>
      </div></div>`;
    $$('[data-g]').forEach((b) => b.onclick = () => claim(b.dataset.g));
  }

  async function claim(gid) {
    const g = S.groups[gid];
    const ok = await dialog({
      title: `${groupLabel(S.room, gid)}으로 들어갈까요?`,
      body: g?.allowTransfer ? '기존 기기 대신 이 휴대폰이 그룹을 이어받아요. 저장된 선택과 제출 기록은 그대로 유지돼요.' : '그룹 3명이 이 휴대폰 한 대로 함께 의논하고 제출해요.',
      ok: '들어가기',
    });
    if (!ok) return;
    try {
      await fb.transaction(async (tx) => {
        const p = `rooms/${roomId}/groups/${gid}`;
        const cur = await tx.get(p);
        if (!cur) tx.set(p, { ownerUid: fb.uid(), allowTransfer: false, lastSeen: fb.SERVER_TS, online: true, joinedAt: fb.SERVER_TS });
        else if (cur.ownerUid === fb.uid()) return;
        else if (cur.allowTransfer) tx.update(p, { ownerUid: fb.uid(), allowTransfer: false, lastSeen: fb.SERVER_TS, online: true });
        else throw new Error('taken');
      });
      toast(`${groupLabel(S.room, gid)}으로 입장했어요`, 'ok');
    } catch (e) {
      toast(e.message === 'taken' ? '방금 다른 기기가 이 그룹을 선택했어요.' : '입장하지 못했어요. 다시 시도해 주세요.', 'bad');
    }
  }

  /* ---------- 대기 (라운드 시작 전) ---------- */
  function renderWaiting() {
    const room = S.room;
    const lobby = !room.currentRound;
    const key = 'wait:' + (room.photoOrder || []).join(',') + Object.keys(S.photos).length + lobby;
    if (L.view === key) { $('.p-head .state').innerHTML = stateTag(); return; }
    L.view = key; L.gridKey = '';
    const photos = orderedPhotos(S);
    app.innerHTML = `<div class="p-app">${head()}
      <div class="p-body" style="padding-bottom:30px">
        <div class="p-msg"><h2>${lobby ? '곧 시작해요' : '다음 라운드를 기다려요'}</h2>
        <p class="muted">진행자가 주제 7개를 공개하면 여기서 바로 고를 수 있어요.<br>사진은 미리 둘러봐도 돼요.</p>
        ${lobby ? `<button class="btn sm ghost" id="regroup">그룹을 잘못 골랐어요</button>` : ''}</div>
        ${photos.length ? `<div class="pgrid">${photos.map((pid) => tileHtml(pid)).join('')}</div>` : ''}
      </div></div>`;
    bindTiles(false);
    const rg = $('#regroup');
    if (rg) rg.onclick = async () => {
      if (!(await dialog({ title: '그룹을 다시 고를까요?', body: '지금 그룹에서 나가고 선택 화면으로 돌아가요.', ok: '다시 고르기' }))) return;
      fb.deleteDoc(`rooms/${roomId}/groups/${L.gid}`).catch(() => toast('처리하지 못했어요', 'bad'));
    };
  }

  function tileHtml(pid) {
    return `<div class="ptile" data-p="${pid}" role="button" tabindex="0"><img src="${photoSrc(S, pid)}" alt="사진 ${photoNo(S, pid)}" loading="lazy">
      <span class="no">${photoNo(S, pid)}</span><span class="used hidden"></span>
      <button class="zoom" data-z="${pid}" aria-label="크게 보기">🔍</button></div>`;
  }
  function bindTiles(selectable) {
    $$('.ptile').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('[data-z]')) { openZoom(el.dataset.p); return; }
        if (selectable) assign(el.dataset.p); else openZoom(el.dataset.p);
      };
    });
  }

  /* ---------- 선택 ---------- */
  function renderSelect() {
    const photos = orderedPhotos(S);
    const tp = topics();
    const gridKey = `${S.room.currentRound}:${photos.join(',')}:${Object.keys(S.photos).length}`;
    if (L.view !== 'select' || L.gridKey !== gridKey) {
      L.view = 'select'; L.gridKey = gridKey;
      app.innerHTML = `<div class="p-app">
        <div id="hd"></div>
        <div class="p-body"><div class="pgrid">${photos.map((pid) => tileHtml(pid)).join('')}</div></div>
        <div class="p-foot"><div class="inner">
          <div class="grow" id="progress" style="font-size:13px"></div>
          <button class="btn primary lg" id="review">확인·제출</button></div></div>
      </div><div id="layer"></div>`;
      bindTiles(true);
      $('#review').onclick = () => { L.sheet = 'review'; renderLayer(); };
    }
    if (!L.draftLoaded) {
      $('#hd').innerHTML = head(`<div class="save-line">내 답안을 불러오는 중…</div>`);
      return;
    }
    const act = L.active;
    const saveTxt = {
      idle: '', saving: '초안 저장 중…', saved: '초안 저장됨 · 아직 제출 아님', error: '⚠️ 초안 저장 실패 — 연결을 확인하세요 (계속 고르면 다시 시도해요)',
    }[L.save];
    const editingTxt = isEditing() ? '마지막 제출본이 유지되고 있어요. 바꾼 내용은 다시 제출해야 반영돼요.' : '';
    $('#hd').innerHTML = head(`
      <div class="save-line">${esc(editingTxt || saveTxt || (serverSubmitted() ? '제출 완료 · 마감 전까지 수정할 수 있어요' : '주제 칸을 고르고 사진을 누르세요'))}${L.save === 'error' ? ' <button class="btn sm" id="retry">재시도</button>' : ''}</div>
      <div class="slots">${tp.map((_, i) => {
        const pid = L.draft[i];
        return `<button class="slot ${i === act ? 'active' : ''} ${pid ? 'filled' : ''}" data-s="${i}" aria-label="주제 ${i + 1}">
          <span class="n">${i + 1}</span><span class="thumb" style="${pid ? `background-image:url('${photoSrc(S, pid)}')` : ''}"></span></button>`;
      }).join('')}</div>
      <div class="active-topic"><span class="num">${act + 1}</span><span class="txt">${esc(tp[act] || '')}</span>
        ${L.draft[act] ? `<button class="btn sm clear" id="clear">비우기</button>` : ''}</div>`);
    $$('[data-s]').forEach((b) => b.onclick = () => { L.active = Number(b.dataset.s); render(); });
    const cl = $('#clear'); if (cl) cl.onclick = () => { L.draft[L.active] = ''; changed(); };
    const rt = $('#retry'); if (rt) rt.onclick = () => saveDraft();

    // 사진 타일 표시 갱신 (다시 만들지 않고 표시만 바꿈)
    $$('.ptile').forEach((el) => {
      const i = L.draft.indexOf(el.dataset.p);
      const u = el.querySelector('.used');
      el.classList.toggle('here', i === act);
      if (i >= 0) { u.classList.remove('hidden'); u.textContent = i === act ? `주제 ${i + 1} 선택` : `주제 ${i + 1}에 사용 중`; }
      else u.classList.add('hidden');
    });
    const filled = L.draft.filter(Boolean).length;
    $('#progress').innerHTML = `<b>${filled}</b> / 7 선택${L.slow ? '<br><span class="muted">제출 확인이 늦어지고 있어요…</span>' : ''}`;
    $('#review').disabled = L.submitting;
    renderLayer();
  }

  async function assign(pid) {
    if (S.rounds[S.room.currentRound]?.phase !== 'selecting' || !L.draftLoaded) return;
    const a = L.active;
    const at = L.draft.indexOf(pid);
    if (at === a) { toast(`이미 주제 ${a + 1}에 선택된 사진이에요`); return; }
    if (at >= 0) {
      const ok = await dialog({
        title: `이미 주제 ${at + 1}에 넣은 사진이에요`,
        body: '한 라운드에서 같은 사진은 한 번만 쓸 수 있어요. 주제 ' + (at + 1) + '에서 빼고 주제 ' + (a + 1) + '에 넣을까요?',
        ok: `주제 ${at + 1}에서 빼고 넣기`,
      });
      if (!ok) return;
      L.draft[at] = '';
    }
    L.draft[a] = pid;
    const nextEmpty = [...Array(TOPIC_COUNT).keys()].map((k) => (a + 1 + k) % TOPIC_COUNT).find((k) => !L.draft[k]);
    if (nextEmpty !== undefined) L.active = nextEmpty;
    changed();
  }

  function changed() {
    L.save = 'saving';
    clearTimeout(L.saveTimer);
    L.saveTimer = setTimeout(saveDraft, 450);
    render();
  }

  async function saveDraft() {
    const r = S.room.currentRound, gid = L.gid;
    const draft = [...L.draft];
    const sub = serverSubmitted();
    L.save = 'saving'; render();
    try {
      await fb.batch([
        { type: 'set', merge: true, path: `rooms/${roomId}/rounds/${r}/answers/${gid}`, data: { draft, draftAt: fb.SERVER_TS } },
        { type: 'set', merge: true, path: `rooms/${roomId}/rounds/${r}/status/${gid}`, data: { editing: !!sub && sub.some((p, i) => p !== draft[i]) } },
      ]);
      if (r === S.room.currentRound && gid === L.gid) L.save = 'saved';
    } catch (e) {
      console.warn(e);
      L.save = S.rounds[r]?.phase === 'selecting' ? 'error' : 'idle';
    }
    render();
  }

  async function submit() {
    const r = S.room.currentRound, gid = L.gid;
    const ans = [...L.draft];
    if (ans.some((x) => !x)) return toast('7개 칸을 모두 채워야 제출할 수 있어요');
    if (new Set(ans).size !== TOPIC_COUNT) return toast('같은 사진이 두 칸에 들어가 있어요');
    L.submitting = true; L.slow = false; render();
    const slowT = setTimeout(() => { L.slow = true; render(); }, 6000);
    try {
      clearTimeout(L.saveTimer);
      await fb.transaction(async (tx) => {
        const rd = await tx.get(`rooms/${roomId}/rounds/${r}`);
        if (!rd || rd.phase !== 'selecting') throw new Error('closed');
        tx.set(`rooms/${roomId}/rounds/${r}/answers/${gid}`, { draft: ans, submitted: ans, draftAt: fb.SERVER_TS, submittedAt: fb.SERVER_TS }, true);
        tx.set(`rooms/${roomId}/rounds/${r}/status/${gid}`, { submitted: true, editing: false, submittedAt: fb.SERVER_TS }, true);
      });
      L.save = 'idle'; L.sheet = null;
      toast('제출 완료! 마감 전까지는 수정할 수 있어요.', 'ok');
    } catch (e) {
      console.warn(e);
      if (e.message === 'closed') toast('이미 마감돼서 제출되지 않았어요.', 'bad');
      else toast('제출하지 못했어요. 답안은 그대로 있어요. 다시 눌러 주세요.', 'bad');
    } finally {
      clearTimeout(slowT);
      L.submitting = false; L.slow = false;
      render();
    }
  }

  /* ---------- 확인 시트 / 확대 보기 ---------- */
  function renderLayer() {
    const layer = $('#layer');
    if (!layer) return;
    if (L.zoom) {
      const pid = L.zoom;
      const list = orderedPhotos(S), idx = list.indexOf(pid);
      const selecting = L.view === 'select';
      const at = L.draft.indexOf(pid);
      layer.innerHTML = `<div class="viewer">
        <div class="vtop"><button class="btn sm" data-a="prev">◀</button><b style="font-size:18px">사진 ${idx + 1}</b><button class="btn sm" data-a="next">▶</button></div>
        <div class="vimg"><img src="${photoSrc(S, pid)}" alt=""></div>
        <div class="vbot"><button class="btn lg" data-a="close">닫기</button>
        ${selecting ? (at === L.active ? `<button class="btn lg" disabled>주제 ${L.active + 1}에 선택됨</button>` :
          `<button class="btn primary lg" data-a="put">주제 ${L.active + 1}에 넣기</button>`) : ''}</div></div>`;
      layer.querySelector('.viewer').onclick = (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'close') { L.zoom = null; renderLayer(); }
        if (a === 'prev') { L.zoom = list[(idx - 1 + list.length) % list.length]; renderLayer(); }
        if (a === 'next') { L.zoom = list[(idx + 1) % list.length]; renderLayer(); }
        if (a === 'put') { L.zoom = null; renderLayer(); assign(pid); }
      };
      return;
    }
    if (L.sheet === 'review' && L.view === 'select') {
      const tp = topics();
      const complete = L.draft.every(Boolean) && new Set(L.draft).size === TOPIC_COUNT;
      const editing = isEditing();
      layer.innerHTML = `<div class="viewer" style="background:var(--bg)">
        <div class="vtop" style="color:var(--ink)"><b style="font-size:18px">우리 그룹 답안 확인</b><button class="btn sm" data-a="close">닫기</button></div>
        <div style="flex:1;overflow:auto;padding:0 14px 14px"><div class="review">${tp.map((t, i) => {
          const pid = L.draft[i];
          return `<div class="ri" data-i="${i}"><div class="im" style="${pid ? `background-image:url('${photoSrc(S, pid)}')` : ''}">${pid ? '' : '비어 있음'}</div>
          <div class="tt"><small>주제 ${i + 1}${pid ? ` · 사진 ${photoNo(S, pid)}` : ''}</small>${esc(t)}</div></div>`;
        }).join('')}</div>
        ${editing ? `<p class="muted" style="font-size:13px">지금 제출하면 마지막 제출본이 이 답안으로 바뀌어요.</p>` : ''}</div>
        <div class="vbot" style="background:#fff;border-top:1px solid var(--line)">
          <button class="btn primary lg" data-a="submit" ${complete && !L.submitting ? '' : 'disabled'}>${L.submitting ? '제출 중…' : complete ? (serverSubmitted() ? '다시 제출하기' : '제출하기') : `${L.draft.filter(Boolean).length} / 7 — 모두 채워야 제출 가능`}</button></div></div>`;
      layer.querySelector('.viewer').onclick = (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        const row = e.target.closest('[data-i]');
        if (a === 'close') { L.sheet = null; renderLayer(); }
        else if (a === 'submit') submit();
        else if (row) { L.active = Number(row.dataset.i); L.sheet = null; render(); }
      };
      return;
    }
    layer.innerHTML = '';
  }
  function openZoom(pid) {
    L.zoom = pid;
    if (!$('#layer')) app.insertAdjacentHTML('beforeend', '<div id="layer"></div>');
    renderLayer();
  }

  /* ---------- 마감 / 공개 / 최종 ---------- */
  function renderClosed() {
    L.view = 'closed'; L.gridKey = '';
    const sub = serverSubmitted();
    const tp = topics();
    app.innerHTML = `<div class="p-app">${head()}<div class="p-body" style="padding-bottom:30px">
      <div class="p-msg"><h2>제출이 마감됐어요</h2><p class="muted">${sub ? '아래 답안이 최종 제출본이에요. 진행자가 곧 답을 공개해요.' : '이번 라운드는 제출하지 못했어요. 진행자가 제출을 다시 열면 이어서 할 수 있어요.'}</p></div>
      ${sub ? `<div class="review">${tp.map((t, i) => `<div class="ri"><div class="im" style="background-image:url('${photoSrc(S, sub[i])}')"></div>
        <div class="tt"><small>주제 ${i + 1} · 사진 ${photoNo(S, sub[i])}</small>${esc(t)}</div></div>`).join('')}</div>` : ''}
    </div></div><div id="layer"></div>`;
  }

  function renderRevealed() {
    const r = S.room.currentRound, t = teamOf(L.gid);
    const res = teamRound(S, t, r);
    const tp = topics();
    const table = scoreTable(S);
    const key = 'rev:' + r + JSON.stringify(res) + JSON.stringify(table.rows.map((x) => x.total)) + Object.keys(S.photos).length;
    if (L.view === key) return;
    L.view = key; L.gridKey = '';
    app.innerHTML = `<div class="p-app">${head()}<div class="p-body" style="padding-bottom:30px">
      <div class="p-msg" style="padding:14px 0"><h2>${esc(teamName(S.room, t))} 이번 라운드 ${res.score}점</h2>
      <p class="muted">같은 주제에 같은 사진을 고른 칸만 1점이에요.</p></div>
      <div class="cmp">${tp.map((tt, i) => {
        const c = res.cells[i];
        return `<div class="cmp-row ${c.match ? 'match' : ''}"><div class="tt"><b style="color:var(--accent)">${i + 1}</b> ${esc(tt)} ${c.match ? '<span class="tag ok">+1</span>' : ''}</div>
        <div class="pair"><div style="${c.a ? `background-image:url('${photoSrc(S, c.a)}')` : ''}"><span>A</span></div>
        <div style="${c.b ? `background-image:url('${photoSrc(S, c.b)}')` : ''}"><span>B</span></div></div></div>`;
      }).join('')}</div>
      ${scoreCard(table)}
      <p class="muted" style="text-align:center;font-size:13px;margin-top:14px">${r < S.room.roundCount ? '진행자가 다음 라운드를 시작하면 자동으로 넘어가요.' : '곧 최종 결과가 발표돼요.'}</p>
    </div></div><div id="layer"></div>`;
  }

  function scoreCard(table) {
    return `<div class="card" style="margin-top:14px"><h3>누적 점수</h3>
      <table class="score-table"><tr><th>순위</th><th>팀</th>${table.rounds.map((r) => `<th>R${r}</th>`).join('')}<th>합계</th></tr>
      ${table.sorted.map((x) => `<tr style="${x.t === teamOf(L.gid) ? 'background:#fff7f4' : ''}"><td>${x.rank}위</td><td style="text-align:left"><span class="team-chip" style="display:inline-block;vertical-align:middle;background:${TEAM_COLORS[x.t - 1]}"></span> ${esc(x.name)}</td>
      ${x.per.map((p) => `<td>${p}</td>`).join('')}<td class="total">${x.total}</td></tr>`).join('')}</table></div>`;
  }

  function renderFinal() {
    const table = scoreTable(S);
    const key = 'final:' + JSON.stringify(table.rows);
    if (L.view === key) return;
    L.view = key; L.gridKey = '';
    const me = table.rows.find((x) => x.t === teamOf(L.gid));
    app.innerHTML = `<div class="p-app">${head()}<div class="p-body" style="padding-bottom:30px">
      <div class="p-msg"><h2>🎉 게임 종료</h2><p class="muted">${esc(me.name)} 최종 ${me.total}점 · ${me.rank}위${table.sorted.filter((x) => x.rank === me.rank).length > 1 ? ' (공동)' : ''}</p></div>
      ${scoreCard(table)}</div></div>`;
  }
}
