import * as fb from './fb.js';
import {
  GIDS, TEAMS, TOPIC_COUNT, PHOTO_COUNT, MAX_ROUNDS, $, $$, esc, toast, dialog, fatal, watchRoom,
  roomIdFromUrl, pageUrl, joinUrl, orderedPhotos, photoNo, photoSrc, teamOf, sideOf, gidOf,
  teamName, groupLabel, isOnline, teamRound, scoreTable, timerRemaining, fmtMs, resizeImage, qrSvg,
} from './common.js';

const app = $('#app');
const roomId = roomIdFromUrl();
const TEAM_COLORS = ['var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)'];
const ROOM = `rooms/${roomId}`;

start().catch((e) => { console.error(e); fatal(e.message || String(e)); });

async function start() {
  await fb.init();
  if (!roomId) throw new Error('주소에 방 코드(room)가 없어요.');
  await fb.syncClock(roomId);
  host();
}

function host() {
  const H = { tab: null, keys: {}, topicTimers: {}, teamTimer: null, busy: false, exposeOk: {}, uploading: '' };
  let S;
  S = watchRoom(roomId, { host: true }, () => render());

  const upd = (data) => fb.updateDoc(ROOM, data).catch((e) => { console.error(e); toast('저장하지 못했어요: ' + e.message, 'bad'); throw e; });
  const setDisplay = (patch) => upd({ display: { ...(S.room.display || {}), ...patch } });
  const cur = () => S.room.currentRound || 0;
  const curRound = () => S.rounds[cur()];
  const topicsFor = (r) => (S.setup?.[`r${r}`] || []).map((x) => x || '');
  const submittedCount = (r) => GIDS.filter((g) => S.status[r]?.[g]?.submitted).length;

  function render() {
    const room = S.room;
    if (room === undefined) return;
    if (room === null) { fatal(`방 ${roomId}을(를) 찾을 수 없어요.`); return; }
    if (room.hostUid !== fb.uid()) {
      app.innerHTML = `<div class="fatal"><h2>진행자 기기가 아니에요</h2><p>이 방은 다른 브라우저에서 만들어졌어요. 방을 만든 노트북·브라우저에서 열어 주세요.</p>
        <a class="btn" href="${esc(pageUrl('index.html', roomId))}">참가자로 입장</a></div>`;
      return;
    }
    if (!H.tab) H.tab = cur() > 0 ? 'play' : 'setup';
    if (!$('#host-shell')) shell();
    renderTop();
    if (H.tab === 'setup') renderSetup();
    if (H.tab === 'play') renderPlay();
    if (H.tab === 'score') renderScore();
  }

  function shell() {
    app.innerHTML = `<div id="host-shell">
      <div class="host-top"><div class="inner">
        <div class="logo">매치<b>?</b> 매치<b>!</b></div>
        <span class="code-pill">${esc(roomId)}</span>
        <div class="tabs"><button data-tab="setup">준비</button><button data-tab="play">진행</button><button data-tab="score">점수·답안</button></div>
        <div class="grow"></div>
        <span id="phase-tag"></span>
        <button class="btn dark" id="open-screen">빔 화면 열기 ↗</button>
      </div></div>
      <div class="host-main"><div id="tab-setup"></div><div id="tab-play"></div><div id="tab-score"></div></div>
    </div>`;
    $$('[data-tab]').forEach((b) => b.onclick = () => { H.tab = b.dataset.tab; render(); });
    $('#open-screen').onclick = () => window.open(pageUrl('screen.html', roomId), 'mm-screen', 'popup,width=1280,height=720');
  }

  function phaseText() {
    const room = S.room, r = cur(), rd = curRound();
    if (room.game === 'final') return ['게임 종료', 'blue'];
    if (!r) return ['입장 대기', ''];
    if (!rd) return [`${r}라운드 준비`, ''];
    return { selecting: [`${r}R 선택 중`, 'warn'], closed: [`${r}R 마감`, 'bad'], revealed: [`${r}R 공개`, 'ok'] }[rd.phase] || ['', ''];
  }
  function renderTop() {
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === H.tab));
    ['setup', 'play', 'score'].forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', H.tab !== t));
    const [txt, cls] = phaseText();
    $('#phase-tag').innerHTML = `<span class="tag ${cls}" style="font-size:14px;padding:4px 12px">${esc(txt)}</span>`;
  }

  /* ======================= 준비 탭 ======================= */
  function renderSetup() {
    const room = S.room, box = $('#tab-setup');
    const started = cur() > 0;
    if (!H.keys.setupShell) {
      H.keys.setupShell = true;
      box.innerHTML = `<div class="host-grid">
        <div class="host-col">
          <div class="card"><h3>기본 설정</h3>
            <div class="row" style="margin-bottom:12px"><label style="font-weight:700">라운드 수</label>
              <select id="round-count">${[3, 4, 5].map((n) => `<option value="${n}">${n}라운드${n === 3 ? ' (기본)' : ''}</option>`).join('')}</select>
              <span class="muted" style="font-size:13px">최대 5라운드 · 진행 중에도 늘릴 수 있어요</span></div>
            <div style="font-weight:700;margin-bottom:6px">팀 이름</div>
            <div class="row" id="team-names">${TEAMS.map((t) => `<span class="team-chip" style="background:${TEAM_COLORS[t - 1]}"></span><input type="text" data-team="${t}" style="width:110px" maxlength="12">`).join('')}</div>
          </div>
          <div class="card"><h3>점검</h3><ul class="checklist" id="checklist" style="margin:0;padding-left:20px"></ul></div>
          <div class="card"><h3>라운드별 주제 <span class="muted" style="font-size:13px;font-weight:600">참가자에게는 공개 전까지 전달되지 않아요</span></h3><div id="topics" style="display:flex;flex-direction:column;gap:12px"></div></div>
        </div>
        <div class="host-col">
          <div class="card"><h3>사진 <span id="photo-count" class="tag"></span></h3>
            <div class="row" id="photo-tools" style="margin-bottom:12px">
              <label class="btn primary">사진 추가<input type="file" id="photo-in" accept="image/*" multiple hidden></label>
              <button class="btn" id="sort-name">파일 이름순 정렬</button>
              <span class="muted" id="upload-state" style="font-size:13px"></span></div>
            <p class="muted" style="font-size:13px;margin:0 0 10px" id="photo-note">자동으로 가로·세로 1100px 이하 JPG로 줄여서 저장해요. 번호 순서가 모든 화면에서 똑같이 보여요.</p>
            <div class="photo-admin" id="photo-grid"></div>
            <input type="file" id="replace-in" accept="image/*" hidden>
          </div>
        </div></div>`;
      $('#round-count').onchange = async (e) => {
        const n = Number(e.target.value);
        if (n < cur()) { toast(`이미 ${cur()}라운드까지 진행했어요`, 'bad'); e.target.value = room.roundCount; return; }
        await upd({ roundCount: n });
      };
      $$('[data-team]').forEach((inp) => inp.oninput = () => {
        clearTimeout(H.teamTimer);
        H.teamTimer = setTimeout(() => {
          upd({ teams: TEAMS.map((t) => $(`[data-team="${t}"]`).value.trim() || `${t}팀`) });
        }, 500);
      });
      $('#photo-in').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
      $('#sort-name').onclick = sortByName;
      $('#replace-in').onchange = (e) => { const f = e.target.files[0]; if (f) replacePhoto(H.replacing, f); e.target.value = ''; };
    }
    $('#round-count').value = room.roundCount;
    TEAMS.forEach((t) => { const i = $(`[data-team="${t}"]`); if (document.activeElement !== i) i.value = teamName(room, t); });

    // 사진
    const photos = orderedPhotos(S);
    $('#photo-count').textContent = `${photos.length} / ${PHOTO_COUNT}`;
    $('#photo-count').className = 'tag ' + (photos.length === PHOTO_COUNT ? 'ok' : 'warn');
    $('#photo-tools').classList.toggle('hidden', started);
    $('#photo-note').textContent = started ? '게임이 시작되어 사진 세트가 고정됐어요.' : '자동으로 가로·세로 1100px 이하 JPG로 줄여서 저장해요. 번호 순서가 모든 화면에서 똑같이 보여요.';
    $('#upload-state').textContent = H.uploading;
    const pkey = photos.join(',') + started + Object.values(S.photos).map((p) => p.src.length).join(',');
    if (H.keys.photos !== pkey) {
      H.keys.photos = pkey;
      $('#photo-grid').innerHTML = photos.map((pid, i) => `<div class="pa"><div class="img" style="background-image:url('${photoSrc(S, pid)}')"><span class="no">${i + 1}</span></div>
        ${started ? '' : `<div class="ctl"><button data-mv="-1" data-p="${pid}" title="앞으로">◀</button><button data-rep="${pid}" title="교체">교체</button><button data-del="${pid}" title="삭제">✕</button><button data-mv="1" data-p="${pid}" title="뒤로">▶</button></div>`}</div>`).join('')
        || '<p class="muted">아직 사진이 없어요. 실제로 쓸 사진 30장을 올려 주세요.</p>';
      $$('[data-mv]').forEach((b) => b.onclick = () => movePhoto(b.dataset.p, Number(b.dataset.mv)));
      $$('[data-rep]').forEach((b) => b.onclick = () => { H.replacing = b.dataset.rep; $('#replace-in').click(); });
      $$('[data-del]').forEach((b) => b.onclick = () => deletePhoto(b.dataset.del));
    }

    // 주제
    const tkey = `${room.roundCount}:${cur()}`;
    if (H.keys.topics !== tkey && S.setup !== undefined) {
      H.keys.topics = tkey;
      let html = '';
      for (let r = 1; r <= room.roundCount; r++) {
        const locked = r <= cur();
        const vals = locked ? (S.rounds[r]?.topics || topicsFor(r)) : topicsFor(r);
        html += `<div class="topics-round"><h4>${r}라운드 ${locked ? '<span class="tag">공개됨 · 수정 불가</span>' : `<span class="tag" id="tsave-${r}"></span>`}</h4>
          ${Array.from({ length: TOPIC_COUNT }, (_, k) => `<div class="topic-in"><span>${k + 1}</span><input type="text" data-r="${r}" data-k="${k}" value="${esc(vals[k] || '')}" ${locked ? 'disabled' : ''} maxlength="60" placeholder="주제 ${k + 1}"></div>`).join('')}</div>`;
      }
      $('#topics').innerHTML = html;
      $$('#topics input[data-r]').forEach((inp) => inp.oninput = () => queueTopicSave(Number(inp.dataset.r)));
    }
    renderChecklist();
  }

  function renderChecklist() {
    const room = S.room;
    const photos = orderedPhotos(S).length;
    const joined = GIDS.filter((g) => S.groups[g]).length;
    const items = [[photos === PHOTO_COUNT, `사진 ${photos} / ${PHOTO_COUNT}장`]];
    for (let r = 1; r <= room.roundCount; r++) {
      const vals = r <= cur() ? (S.rounds[r]?.topics || []) : currentTopicInputs(r);
      const n = vals.filter((x) => x && x.trim()).length;
      items.push([n === TOPIC_COUNT, `${r}라운드 주제 ${n} / ${TOPIC_COUNT}`]);
    }
    items.push([joined === 8, `입장한 그룹 ${joined} / 8`]);
    $('#checklist').innerHTML = items.map(([ok, t]) => `<li>${ok ? '✅' : '⬜'} ${esc(t)}</li>`).join('');
  }
  function currentTopicInputs(r) {
    const ins = $$(`#topics input[data-r="${r}"]`);
    return ins.length ? ins.map((i) => i.value) : topicsFor(r);
  }
  function queueTopicSave(r) {
    const tag = $(`#tsave-${r}`); if (tag) { tag.textContent = '저장 중…'; tag.className = 'tag'; }
    clearTimeout(H.topicTimers[r]);
    H.topicTimers[r] = setTimeout(async () => {
      const vals = currentTopicInputs(r).map((x) => x.trim());
      try {
        await fb.setDoc(`${ROOM}/private/setup`, { [`r${r}`]: vals }, true);
        const t = $(`#tsave-${r}`); if (t) { t.textContent = '저장됨'; t.className = 'tag ok'; }
      } catch (e) {
        const t = $(`#tsave-${r}`); if (t) { t.textContent = '저장 실패'; t.className = 'tag bad'; }
      }
      renderChecklist();
    }, 600);
  }

  async function addPhotos(files) {
    const order = [...(S.room.photoOrder || [])];
    let list = files.filter((f) => f.type.startsWith('image/'));
    const space = PHOTO_COUNT - order.length;
    if (space <= 0) return toast('이미 30장이 등록돼 있어요. 교체나 삭제를 사용하세요.');
    if (list.length > space) { toast(`30장까지만 등록돼요. 앞에서부터 ${space}장만 추가할게요.`); list = list.slice(0, space); }
    list.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    for (let i = 0; i < list.length; i++) {
      H.uploading = `올리는 중 ${i + 1} / ${list.length}…`; $('#upload-state').textContent = H.uploading;
      try {
        const src = await resizeImage(list[i]);
        const pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await fb.setDoc(`${ROOM}/photos/${pid}`, { src, name: list[i].name });
        order.push(pid);
        await fb.updateDoc(ROOM, { photoOrder: order });
      } catch (e) { console.error(e); toast(`${list[i].name} 업로드 실패: ${e.message}`, 'bad'); }
    }
    H.uploading = ''; render();
    toast('사진 등록 완료', 'ok');
  }
  async function replacePhoto(pid, file) {
    try {
      const src = await resizeImage(file);
      await fb.setDoc(`${ROOM}/photos/${pid}`, { src, name: file.name });
      toast(`${photoNo(S, pid)}번 사진을 교체했어요`, 'ok');
    } catch (e) { toast('교체 실패: ' + e.message, 'bad'); }
  }
  async function deletePhoto(pid) {
    if (!(await dialog({ title: `${photoNo(S, pid)}번 사진을 삭제할까요?`, body: '뒤 번호 사진들이 한 칸씩 앞으로 당겨져요.', ok: '삭제', danger: true }))) return;
    await upd({ photoOrder: S.room.photoOrder.filter((x) => x !== pid) });
    fb.deleteDoc(`${ROOM}/photos/${pid}`).catch(() => {});
  }
  function movePhoto(pid, dir) {
    const o = [...S.room.photoOrder];
    const i = o.indexOf(pid), j = i + dir;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    upd({ photoOrder: o });
  }
  function sortByName() {
    const o = [...S.room.photoOrder].sort((a, b) => (S.photos[a]?.name || '').localeCompare(S.photos[b]?.name || '', 'ko', { numeric: true }));
    upd({ photoOrder: o });
  }

  /* ======================= 진행 탭 ======================= */
  function renderPlay() {
    const box = $('#tab-play');
    if (!H.keys.playShell) {
      H.keys.playShell = true;
      box.innerHTML = `<div class="host-grid">
        <div class="host-col">
          <div class="card" id="phase-card"></div>
          <div class="card"><h3>제출·접속 현황 <span class="muted" style="font-size:13px;font-weight:600">답안 내용은 공개 전까지 보이지 않아요</span></h3><div id="groups"></div></div>
          <div class="card"><h3>타이머 <span class="muted" style="font-size:13px;font-weight:600">0초가 돼도 자동 마감·제출·공개는 없어요</span></h3>
            <div class="row" style="justify-content:space-between">
              <div class="timer-read" id="t-read">--:--</div>
              <label class="row" style="gap:6px"><input type="checkbox" id="t-show"> 빔·휴대폰에 표시</label></div>
            <div class="row timer-inputs" style="margin-top:10px">
              <input type="number" id="t-min" min="0" max="99"> 분 <input type="number" id="t-sec" min="0" max="59"> 초
              <div class="grow"></div>
              <button class="btn primary" id="t-start">시작</button><button class="btn" id="t-pause">일시정지</button>
              <button class="btn" id="t-resume">재개</button><button class="btn" id="t-reset">초기화</button></div>
          </div>
        </div>
        <div class="host-col">
          <div class="card"><h3>빔 화면 <span class="muted" style="font-size:13px;font-weight:600">여기서 고른 화면이 빔에 나가요</span></h3>
            <div id="viewctl"></div>
            <div class="subhead">빔 미리보기</div>
            <div class="preview-wrap" id="pv"><iframe id="pv-frame" title="빔 미리보기" src="${esc(pageUrl('screen.html', roomId, { preview: '1' }))}"></iframe></div>
          </div>
          <div class="card"><h3>참가 링크</h3>
            <div class="row" style="align-items:flex-start;flex-wrap:nowrap">
              <div class="qr" id="qr"></div>
              <div class="grow" style="min-width:0"><div class="linkbox" id="join-link"></div>
                <div class="row" style="margin-top:8px"><button class="btn sm" id="copy-link">링크 복사</button></div>
                <p class="muted" style="font-size:13px">휴대폰으로 QR을 찍거나 링크로 들어와 팀·그룹을 고르면 돼요. 게임 중간에도 입장할 수 있어요.</p></div>
            </div></div>
        </div></div>`;
      const url = joinUrl(roomId);
      $('#qr').innerHTML = qrSvg(url, 4);
      $('#join-link').textContent = url;
      $('#copy-link').onclick = () => navigator.clipboard?.writeText(url).then(() => toast('링크를 복사했어요', 'ok'));
      const fit = () => { const w = $('#pv').clientWidth; $('#pv-frame').style.transform = `scale(${w / 1920})`; };
      new ResizeObserver(fit).observe($('#pv')); fit();
      bindTimer();
      setInterval(tickTimer, 250);
    }
    renderPhaseCard();
    renderGroups();
    renderViewCtl();
    syncTimerInputs();
  }

  /* ---------- 진행 단계 ---------- */
  function renderPhaseCard() {
    const room = S.room, r = cur(), rd = curRound();
    const n = r ? submittedCount(r) : 0;
    let title, desc, actions = '';
    if (room.game === 'final') {
      title = '게임 종료'; desc = '최종 순위가 빔에 표시돼요.';
      actions = `<button class="btn" data-act="show-final">최종 순위 다시 띄우기</button>`;
    } else if (!r) {
      const joined = GIDS.filter((g) => S.groups[g]).length;
      title = '입장 대기'; desc = `입장한 그룹 ${joined} / 8 · 모두 들어오면 1라운드를 시작하세요.`;
      actions = `<button class="btn primary lg" data-act="open" data-r="1">1라운드 시작 · 주제 공개</button>`;
    } else if (rd?.phase === 'selecting') {
      title = `${r}라운드 선택 중`; desc = `제출 ${n} / 8 · 모두 제출해도 자동으로 넘어가지 않아요.`;
      actions = `<button class="btn danger lg" data-act="close">제출 마감</button>`;
    } else if (rd?.phase === 'closed') {
      title = `${r}라운드 마감`; desc = `제출 ${n} / 8 · 공개 전이라면 마감을 취소하고 제출을 다시 열 수 있어요.`;
      actions = `<button class="btn" data-act="reopen">마감 취소 · 제출 다시 열기</button><button class="btn primary lg" data-act="reveal">답 공개</button>`;
    } else if (rd?.phase === 'revealed') {
      title = `${r}라운드 결과 공개 중`;
      desc = r < room.roundCount ? `다음은 ${r + 1}라운드예요.` : `마지막 라운드예요. ${room.roundCount < MAX_ROUNDS ? '라운드를 더 하려면 준비 탭에서 라운드 수를 늘리세요.' : ''}`;
      actions = r < room.roundCount
        ? `<button class="btn primary lg" data-act="open" data-r="${r + 1}">${r + 1}라운드 시작 · 주제 공개</button>`
        : `<button class="btn primary lg" data-act="final">최종 결과 발표</button>`;
    }
    const key = JSON.stringify([title, desc, actions]);
    if (H.keys.phase === key) return;
    H.keys.phase = key;
    $('#phase-card').innerHTML = `<div class="phase-banner"><div class="grow"><div class="big">${esc(title)}</div><div class="muted">${esc(desc)}</div></div></div>
      <div class="row" style="margin-top:12px">${actions}</div>`;
    $$('#phase-card [data-act]').forEach((b) => b.onclick = () => doAct(b.dataset.act, Number(b.dataset.r)));
  }

  async function doAct(act, r) {
    if (H.busy) return;
    H.busy = true;
    try {
      if (act === 'open') await openRound(r);
      if (act === 'close') await closeRound();
      if (act === 'reopen') await setPhase('selecting', '제출을 다시 열었어요');
      if (act === 'reveal') await reveal();
      if (act === 'final') {
        if (await dialog({ title: '최종 결과를 발표할까요?', body: '빔에 최종 순위가 표시되고 게임이 끝나요.', ok: '발표' })) {
          await upd({ game: 'final', display: { view: 'final' } });
        }
      }
      if (act === 'show-final') await setDisplay({ view: 'final' });
    } catch (e) { console.error(e); } finally { H.busy = false; }
  }

  async function openRound(r) {
    const photos = orderedPhotos(S).length;
    if (photos !== PHOTO_COUNT) { toast(`사진이 ${photos}장이에요. 30장을 먼저 등록해 주세요.`, 'bad'); H.tab = 'setup'; render(); return; }
    // 준비 탭에서 입력 중인 값이 있으면 먼저 저장
    const inputs = currentTopicInputs(r).map((x) => (x || '').trim());
    const topics = inputs.length === TOPIC_COUNT ? inputs : topicsFor(r);
    if (topics.filter(Boolean).length !== TOPIC_COUNT) { toast(`${r}라운드 주제 7개를 먼저 입력해 주세요.`, 'bad'); H.tab = 'setup'; render(); return; }
    const joined = GIDS.filter((g) => S.groups[g]).length;
    const ok = await dialog({
      title: `${r}라운드 주제를 공개할까요?`,
      body: `<ol style="margin:6px 0 0;padding-left:20px">${topics.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
        ${joined < 8 ? `<p style="color:var(--warn);font-weight:700">아직 ${8 - joined}그룹이 입장하지 않았어요. (중간 입장은 가능해요)</p>` : ''}`,
      ok: '공개하기',
    });
    if (!ok) return;
    await fb.setDoc(`${ROOM}/private/setup`, { [`r${r}`]: topics }, true);
    await fb.batch([
      { type: 'set', path: `${ROOM}/rounds/${r}`, data: { topics, phase: 'selecting', openedAt: fb.SERVER_TS } },
      { type: 'update', path: ROOM, data: { currentRound: r, game: 'playing', display: { view: 'topics' }, timer: { ...(S.room.timer || {}), status: 'idle' } } },
    ]);
    H.keys.topics = null;
    toast(`${r}라운드 주제를 공개했어요`, 'ok');
  }

  async function closeRound() {
    const r = cur();
    const missing = GIDS.filter((g) => !S.status[r]?.[g]?.submitted);
    const ok = await dialog({
      title: '제출을 마감할까요?',
      body: missing.length
        ? `<p><b style="color:var(--bad)">미제출 ${missing.length}그룹:</b> ${missing.map((g) => esc(groupLabel(S.room, g))).join(', ')}</p>
           <p>이대로 공개하면 미제출 그룹은 빈 답안이 되어 그 팀의 이번 라운드 점수가 0점이에요. 공개 전에는 마감을 취소할 수 있어요.</p>`
        : '8그룹 모두 제출했어요. 마감 후에는 답안을 바꿀 수 없어요.',
      ok: '마감', danger: missing.length > 0,
    });
    if (!ok) return;
    await setPhase('closed', '제출을 마감했어요');
  }

  async function setPhase(phase, msg) {
    await fb.updateDoc(`${ROOM}/rounds/${cur()}`, { phase });
    toast(msg, 'ok');
  }

  async function reveal() {
    const r = cur();
    const missing = GIDS.filter((g) => !S.status[r]?.[g]?.submitted);
    const ok = await dialog({
      title: `${r}라운드 답을 공개할까요?`,
      body: `공개 후에는 이 라운드 답안을 수정하거나 제출을 다시 열 수 없어요.${missing.length ? `<p style="color:var(--bad);font-weight:700">미제출: ${missing.map((g) => esc(groupLabel(S.room, g))).join(', ')}</p>` : ''}`,
      ok: '공개',
    });
    if (!ok) return;
    await fb.batch([
      { type: 'update', path: `${ROOM}/rounds/${r}`, data: { phase: 'revealed', revealedAt: fb.SERVER_TS } },
      { type: 'update', path: ROOM, data: { display: { view: 'team', team: 1, topic: 1 } } },
    ]);
  }

  /* ---------- 그룹 현황 ---------- */
  function renderGroups() {
    const r = cur(), rd = curRound();
    const tiles = GIDS.map((g) => {
      const grp = S.groups[g], st = S.status[r]?.[g];
      const online = isOnline(grp);
      let sub = '<span class="tag">라운드 전</span>';
      if (rd) sub = st?.submitted ? (st.editing && rd.phase === 'selecting' ? '<span class="tag ok">제출 완료 · 수정 중</span>' : '<span class="tag ok">제출 완료</span>') : '<span class="tag warn">미제출</span>';
      const conn = !grp ? '<span class="dot"></span> 미입장' : online ? '<span class="dot on"></span> 접속 중' : '<span class="dot off"></span> 연결 끊김';
      const btn = grp ? (grp.allowTransfer ? `<button class="btn sm" data-tr="${g}" data-v="0">변경 허용 취소</button>` : `<button class="btn sm ghost" data-tr="${g}" data-v="1">기기 변경 허용</button>`) : '';
      return { g, html: `<div class="gtile ${st?.submitted ? 'sub-ok' : ''}"><div class="team-bar" style="background:${TEAM_COLORS[teamOf(g) - 1]}"></div>
        <div class="name">${esc(groupLabel(S.room, g))}</div><div class="line">${conn}</div><div>${sub}</div>
        ${grp?.allowTransfer ? '<div class="line" style="color:var(--blue)">새 기기가 이어받을 수 있어요</div>' : ''}${btn}</div>` };
    });
    const n = r ? submittedCount(r) : 0;
    const html = `${rd ? `<div class="row" style="margin-bottom:10px"><span class="subcount">${n}</span><span class="muted" style="font-weight:700">/ 8 제출</span></div>` : ''}
      <div class="group-grid">${tiles.map((x) => x.html).join('')}</div>`;
    if (H.keys.groups === html) return;
    H.keys.groups = html;
    $('#groups').innerHTML = html;
    $$('[data-tr]').forEach((b) => b.onclick = async () => {
      const g = b.dataset.tr, v = b.dataset.v === '1';
      if (v && !(await dialog({ title: `${groupLabel(S.room, g)} 기기 변경을 허용할까요?`, body: '다음에 이 그룹을 선택하는 휴대폰이 그룹을 이어받아요. 저장된 선택과 제출 기록은 유지돼요. 지금 쓰던 기기는 선택 화면으로 돌아가요.', ok: '허용' }))) return;
      fb.updateDoc(`${ROOM}/groups/${g}`, { allowTransfer: v }).catch(() => toast('처리하지 못했어요', 'bad'));
    });
  }

  /* ---------- 빔 화면 제어 ---------- */
  function renderViewCtl() {
    const room = S.room, d = room.display || { view: 'lobby' }, rd = curRound();
    const revealed = rd?.phase === 'revealed';
    const nPhotos = orderedPhotos(S).length;
    const btn = (view, label, extra = {}) => `<button class="btn sm ${d.view === view ? 'on' : ''}" data-view="${view}" data-extra='${esc(JSON.stringify(extra))}'>${label}</button>`;
    let html = `<div class="subhead" style="margin-top:0">선택 중 화면</div><div class="viewbar">
      ${btn('lobby', '입장 QR')}${btn('board', '사진판 30장')}${btn('bundle', '확대 묶음')}${btn('photo', '사진 1장')}
      ${rd ? btn('topics', '주제 7개') + btn('topic', '주제 1개') : ''}</div>`;
    if (revealed || room.game === 'final') {
      html += `<div class="subhead">답 공개 화면</div><div class="viewbar">
        ${revealed ? btn('team', '팀별 전체 비교') + btn('teamTopic', '주제 확대 (두 사진)') + btn('all', '전체 팀 표') + btn('topicAll', '주제별 전체 팀') : ''}
        ${btn('scores', '점수판')}${room.game === 'final' ? btn('final', '최종 순위') : ''}</div>`;
    }
    // 세부 조절
    let sub = '';
    if (d.view === 'bundle') {
      const size = d.bundleSize || 6, pages = Math.max(1, Math.ceil(nPhotos / size)), page = Math.min(d.bundle || 0, pages - 1);
      sub = `<div class="row"><button class="btn sm" data-set='{"bundle":${Math.max(0, page - 1)}}'>◀ 이전</button>
        <b>${page + 1} / ${pages}</b><button class="btn sm" data-set='{"bundle":${Math.min(pages - 1, page + 1)}}'>다음 ▶</button>
        <span class="muted" style="margin-left:10px">한 번에</span>${[4, 6, 8, 10].map((n) => `<button class="btn sm ${size === n ? 'on' : ''}" data-set='{"bundleSize":${n},"bundle":0}'>${n}장</button>`).join('')}</div>`;
    }
    if (d.view === 'photo') {
      const p = Math.min(Math.max(1, d.photo || 1), nPhotos || 1);
      sub = `<div class="row"><button class="btn sm" data-set='{"photo":${p > 1 ? p - 1 : nPhotos}}'>◀</button>
        <input type="number" id="photo-no" min="1" max="${nPhotos}" value="${p}" style="width:70px"> 번
        <button class="btn sm" data-set='{"photo":${p < nPhotos ? p + 1 : 1}}'>▶</button></div>`;
    }
    const topicBtns = (cur) => `${Array.from({ length: TOPIC_COUNT }, (_, k) => `<button class="btn sm ${cur === k + 1 ? 'on' : ''}" data-set='{"topic":${k + 1}}'>${k + 1}</button>`).join('')}`;
    const teamBtns = (cur) => TEAMS.map((t) => `<button class="btn sm ${cur === t ? 'on' : ''}" data-set='{"team":${t}}'><span class="team-chip" style="display:inline-block;vertical-align:-1px;background:${TEAM_COLORS[t - 1]}"></span> ${esc(teamName(room, t))}</button>`).join('');
    if (d.view === 'topic') sub = `<div class="row"><span class="muted">주제</span>${topicBtns(d.topic || 1)}</div>`;
    if (d.view === 'team') sub = `<div class="row">${teamBtns(d.team || 1)}</div><p class="muted" style="font-size:13px;margin:6px 0 0">주제를 누르면 그 팀의 두 사진을 크게 볼 수 있어요: ${topicBtns(0).replace(/data-set='\{"topic":(\d)\}'/g, `data-view="teamTopic" data-extra='{"topic":$1}'`)}</p>`;
    if (d.view === 'teamTopic') {
      const k = d.topic || 1;
      sub = `<div class="row">${teamBtns(d.team || 1)}</div><div class="row" style="margin-top:6px"><button class="btn sm" data-set='{"topic":${k > 1 ? k - 1 : TOPIC_COUNT}}'>◀ 이전 주제</button>${topicBtns(k)}<button class="btn sm" data-set='{"topic":${k < TOPIC_COUNT ? k + 1 : 1}}'>다음 주제 ▶</button>
        <button class="btn sm ghost" data-view="team">← 팀별 전체로</button></div>`;
    }
    if (d.view === 'topicAll') {
      const k = d.topic || 1;
      sub = `<div class="row"><button class="btn sm" data-set='{"topic":${k > 1 ? k - 1 : TOPIC_COUNT}}'>◀</button>${topicBtns(k)}<button class="btn sm" data-set='{"topic":${k < TOPIC_COUNT ? k + 1 : 1}}'>▶</button></div>`;
    }
    if (d.view === 'all') sub = `<p class="muted" style="font-size:13px;margin:0">주제 하나를 크게 보려면: ${topicBtns(0).replace(/data-set='\{"topic":(\d)\}'/g, `data-view="topicAll" data-extra='{"topic":$1}'`)}</p>`;
    if (sub) html += `<div class="subhead">세부 조절</div>${sub}`;

    const key = html;
    if (H.keys.view === key) return;
    H.keys.view = key;
    $('#viewctl').innerHTML = html;
    $$('#viewctl [data-view]').forEach((b) => b.onclick = async () => {
      const view = b.dataset.view;
      const extra = b.dataset.extra ? JSON.parse(b.dataset.extra) : {};
      if ((view === 'all' || view === 'topicAll') && !H.exposeOk[cur()]) {
        const ok = await dialog({ title: '전체 팀 답을 공개할까요?', body: '전체 비교 화면을 띄우면 4팀 8그룹의 답이 모두 빔에 보여요.', ok: '공개하고 보기' });
        if (!ok) return;
        H.exposeOk[cur()] = true;
      }
      setDisplay({ view, ...extra });
    });
    $$('#viewctl [data-set]').forEach((b) => b.onclick = () => setDisplay(JSON.parse(b.dataset.set)));
    const pn = $('#photo-no');
    if (pn) pn.onchange = () => { const v = Math.min(Math.max(1, Number(pn.value) || 1), nPhotos); setDisplay({ photo: v }); };
  }

  /* ---------- 타이머 ---------- */
  function readInput() {
    const m = Math.max(0, Number($('#t-min').value) || 0), s = Math.min(59, Math.max(0, Number($('#t-sec').value) || 0));
    return (m * 60 + s) * 1000;
  }
  function bindTimer() {
    const T = () => S.room.timer || { status: 'idle', durationMs: 180000, show: true };
    $('#t-start').onclick = () => {
      const ms = readInput();
      if (ms <= 0) return toast('시간을 입력해 주세요');
      upd({ timer: { ...T(), status: 'running', durationMs: ms, endsAt: fb.serverNow() + ms, remainingMs: ms } });
    };
    $('#t-pause').onclick = () => { const t = T(); if (t.status === 'running') upd({ timer: { ...t, status: 'paused', remainingMs: timerRemaining(t) } }); };
    $('#t-resume').onclick = () => { const t = T(); if (t.status === 'paused') upd({ timer: { ...t, status: 'running', endsAt: fb.serverNow() + (t.remainingMs || 0) } }); };
    $('#t-reset').onclick = () => upd({ timer: { ...T(), status: 'idle', durationMs: readInput() || T().durationMs } });
    $('#t-show').onchange = (e) => upd({ timer: { ...T(), show: e.target.checked } });
  }
  function syncTimerInputs() {
    const t = S.room.timer || {};
    $('#t-show').checked = t.show !== false;
    if (!H.keys.timerInit) {
      H.keys.timerInit = true;
      const sec = Math.round((t.durationMs || 180000) / 1000);
      $('#t-min').value = Math.floor(sec / 60); $('#t-sec').value = sec % 60;
    }
    $('#t-pause').disabled = t.status !== 'running';
    $('#t-resume').disabled = t.status !== 'paused';
  }
  function tickTimer() {
    const el = $('#t-read'); if (!el || !S.room) return;
    const t = S.room.timer, rem = timerRemaining(t);
    el.textContent = rem === null ? '--:--' : fmtMs(rem) + (t.status === 'paused' ? ' ⏸' : '');
    el.style.color = rem === 0 ? 'var(--bad)' : '';
  }

  /* ======================= 점수·답안 탭 ======================= */
  function renderScore() {
    const tb = scoreTable(S);
    const room = S.room;
    const key = JSON.stringify([tb.rows, room.teams, tb.rounds.map((r) => S.answers[r]), Object.keys(S.photos).length]);
    if (H.keys.score === key) return;
    H.keys.score = key;
    let html = `<div class="card" style="margin-bottom:16px"><h3>누적 점수 <span class="muted" style="font-size:13px;font-weight:600">공개된 라운드만 합산 · 동점은 공동 순위</span></h3>
      <table class="score-table"><tr><th>팀</th>${tb.rounds.map((r) => `<th>${r}R</th>`).join('')}<th>합계</th><th>순위</th></tr>
      ${tb.rows.map((x) => `<tr><td><span class="team-chip" style="display:inline-block;vertical-align:-1px;background:${TEAM_COLORS[x.t - 1]}"></span> ${esc(x.name)}</td>
        ${x.per.map((p) => `<td>${p}</td>`).join('')}<td class="total">${x.total}</td><td>${x.rank}위</td></tr>`).join('')}</table>
      ${tb.rounds.length ? '' : '<p class="muted">아직 공개된 라운드가 없어요. 답안은 공개 후에만 여기에 표시돼요.</p>'}</div>`;
    for (const r of [...tb.rounds].reverse()) {
      const tp = S.rounds[r]?.topics || [];
      html += `<div class="card" style="margin-bottom:16px"><h3>${r}라운드 답안</h3><div style="overflow-x:auto">
        <table class="score-table" style="min-width:760px"><tr><th>그룹</th>${tp.map((t, i) => `<th style="font-size:12.5px">${i + 1}. ${esc(t)}</th>`).join('')}</tr>
        ${TEAMS.map((t) => { const res = teamRound(S, t, r); return ['A', 'B'].map((sd) => `<tr><td style="white-space:nowrap">${esc(teamName(room, t))} ${sd}${sd === 'B' ? ` <b>${res.score}점</b>` : ''}</td>
          ${res.cells.map((c) => { const pid = sd === 'A' ? c.a : c.b; return `<td style="${c.match ? 'background:var(--ok-soft)' : ''}">${pid ? `<img src="${photoSrc(S, pid)}" style="width:54px;height:54px;object-fit:cover;border-radius:6px;margin:auto"><small>${photoNo(S, pid)}번</small>` : '<span class="muted">—</span>'}</td>`; }).join('')}</tr>`).join(''); }).join('')}
        </table></div></div>`;
    }
    $('#tab-score').innerHTML = html;
  }
}
