'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SUIT_NAME = { sand: '샌드', blood: '블러드' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
  };

  let ws = null;
  let state = null;
  let reconnectDelay = 500;
  let dismissedResultRound = null;

  // ---------- 연결 ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 500;
      const token = store.get('sabacc.token');
      const room = store.get('sabacc.room');
      if (token && room) sendMsg({ type: 'join', room, token });
    };
    ws.onmessage = (ev) => handle(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (ev.code === 4000) return; // 다른 탭에서 접속
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
  }

  function sendMsg(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else toast('서버에 연결 중입니다…');
  }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        store.set('sabacc.token', msg.token);
        store.set('sabacc.room', msg.room);
        history.replaceState(null, '', `?room=${msg.room}`);
        break;
      case 'state':
        state = msg;
        render();
        break;
      case 'left':
        store.del('sabacc.token'); store.del('sabacc.room');
        state = null;
        history.replaceState(null, '', location.pathname);
        show('home');
        $('roomBadge').classList.add('hidden');
        break;
      case 'chat':
        addChat(msg);
        break;
      case 'error':
        toast(msg.message);
        if (/존재하지 않는 방/.test(msg.message)) { store.del('sabacc.token'); store.del('sabacc.room'); }
        break;
      default: break;
    }
  }

  // ---------- 화면 전환 ----------
  function show(id) {
    for (const s of ['home', 'lobby', 'table']) $(s).classList.toggle('hidden', s !== id);
  }

  function render() {
    const g = state.game;
    $('roomBadge').textContent = `ROOM ${state.room}`;
    $('roomBadge').classList.remove('hidden');
    if (g.phase === 'lobby') { renderLobby(); show('lobby'); $('resultModal').classList.add('hidden'); return; }
    show('table');
    renderTable();
    renderResult();
  }

  function renderLobby() {
    const g = state.game;
    $('lobbyCode').textContent = state.room;
    $('lobbyPlayers').innerHTML = g.players.map((p) => `
      <li>${avatar(p.name)}<span>${esc(p.name)}</span>
        ${p.id === state.hostId ? '<em class="tag">방장</em>' : ''}
        ${p.id === state.you ? '<em class="tag me-tag">나</em>' : ''}
        ${state.connected.includes(p.id) ? '' : '<em class="tag off">오프라인</em>'}
      </li>`).join('');
    const n = g.players.length;
    const isHost = state.hostId === state.you;
    $('startBtn').classList.toggle('hidden', !isHost);
    $('startBtn').disabled = n < state.minPlayers;
    $('lobbyHint').textContent = n < state.minPlayers
      ? `${state.minPlayers - n}명 더 필요합니다 (${n}/${state.maxPlayers}). 시작 칩 ${g.startChips}개.`
      : isHost ? `${n}명 준비 완료. 시작하세요! (최대 ${state.maxPlayers}명)` : '방장이 시작하기를 기다리는 중…';
  }

  function renderTable() {
    const g = state.game;
    const me = g.players.find((p) => p.id === state.you);
    const myTurn = g.currentPlayerId === state.you;

    // 상태 표시
    let status;
    if (g.phase === 'turn') {
      const cur = g.players.find((p) => p.id === g.currentPlayerId);
      status = `${g.round}라운드 · 턴 ${g.turn}/${g.turnsPerRound} · ${myTurn ? '<b class="hl">당신의 차례</b>' : `${esc(cur.name)}의 차례`}`;
    } else if (g.phase === 'impostor') status = `${g.round}라운드 · 공개 — 임포스터 주사위 선택 중`;
    else if (g.phase === 'roundEnd') status = `${g.round}라운드 종료`;
    else status = '게임 종료';
    $('status').innerHTML = status + timerHtml();

    // 상대
    const order = rotateToMe(g.players);
    $('opponents').innerHTML = order.filter((p) => p.id !== state.you).map((p) => {
      const turn = p.id === g.currentPlayerId;
      const off = !state.connected.includes(p.id);
      const hand = p.hand
        ? `${cardHtml(p.hand.sand, p.impostor.sand, 'sm')}${cardHtml(p.hand.blood, p.impostor.blood, 'sm')}`
        : p.hasHand ? `${backHtml('sand', 'sm')}${backHtml('blood', 'sm')}` : '';
      const pending = p.pending ? `<div class="drawing">${SUIT_NAME[p.pending.suit]} 카드 고민 중…</div>` : '';
      return `<div class="opp ${turn ? 'turn' : ''} ${p.eliminated ? 'out' : ''}">
        <div class="opp-head">${avatar(p.name)}<span class="nm">${esc(p.name)}</span>${p.id === g.dealerId ? '<em class="tag">딜러</em>' : ''}${off ? '<em class="tag off">오프라인</em>' : ''}</div>
        <div class="opp-hand">${p.eliminated ? '<span class="muted">탈락</span>' : hand}</div>
        ${pending}
        <div class="chips">${chipsHtml(p.chips)} <span>${p.chips}</span>${p.invested ? `<span class="inv">+${p.invested} 베팅</span>` : ''}</div>
      </div>`;
    }).join('');

    // 더미
    $('sandDeckCount').textContent = `${g.decks.sand}장`;
    $('bloodDeckCount').textContent = `${g.decks.blood}장`;
    $('sandDiscard').innerHTML = g.discardTop.sand ? cardHtml(g.discardTop.sand) : '<span class="pile-label">비어 있음</span>';
    $('bloodDiscard').innerHTML = g.discardTop.blood ? cardHtml(g.discardTop.blood) : '<span class="pile-label">비어 있음</span>';
    const pot = g.players.reduce((a, p) => a + p.invested, 0);
    $('pot').innerHTML = `<div class="pot-label">팟</div><div class="pot-val">${pot}</div>`;
    const canDraw = myTurn && me && !me.pending && me.chips > 0;
    document.querySelectorAll('.pile').forEach((el) => {
      const empty = el.dataset.from === 'discard' ? !g.discardTop[el.dataset.suit] : false;
      el.disabled = !canDraw || empty;
      el.classList.toggle('active', canDraw && !empty);
    });

    // 내 정보
    if (!me) return;
    $('myInfo').innerHTML = `${avatar(me.name)}<b>${esc(me.name)}</b>
      <span class="chips">${chipsHtml(me.chips)} ${me.chips}칩</span>
      ${me.invested ? `<span class="inv">이번 라운드 베팅 ${me.invested}</span>` : ''}
      ${me.eliminated ? '<em class="tag off">탈락 — 관전 중</em>' : ''}
      ${me.hand && !me.eliminated ? `<span class="hint">${handHint(me)}</span>` : ''}`;

    // 내 손패
    if (me.hand && !me.eliminated) {
      if (me.pending) {
        const s = me.pending.suit;
        const other = s === 'sand' ? 'blood' : 'sand';
        $('myHand').innerHTML = `
          <div class="keep-choice">
            <button class="keep" data-keep="hand">${cardHtml(me.hand[s])}<span>이 카드 유지</span></button>
            <button class="keep" data-keep="drawn">${cardHtml(me.pending, null, 'new')}<span>새 카드로 교체</span></button>
          </div>
          <div class="fixed">${cardHtml(me.hand[other])}</div>`;
      } else {
        $('myHand').innerHTML = `${cardHtml(me.hand.sand, me.impostor.sand)}${cardHtml(me.hand.blood, me.impostor.blood)}`;
      }
    } else {
      $('myHand').innerHTML = '';
    }

    // 행동 버튼
    let actions = '';
    if (g.phase === 'turn' && myTurn) {
      if (me.pending) actions = '<p class="muted">남길 카드를 선택하세요. 나머지는 버림 더미로 갑니다.</p>';
      else actions = `<button id="standBtn" class="primary">스탠드 (패스)</button>
        <p class="muted">${me.chips > 0 ? '또는 위의 덱/버림 더미를 눌러 1칩으로 드로우' : '칩이 없어 스탠드만 가능합니다.'}</p>`;
    } else if (g.phase === 'impostor') {
      for (const s of ['sand', 'blood']) {
        const imp = me.impostor && me.impostor[s];
        if (imp && imp.value == null) {
          actions += `<div class="dice-choice"><span>${SUIT_NAME[s]} 임포스터 값 선택:</span>
            ${imp.dice.map((d, i) => `<button class="die" data-suit="${s}" data-die="${i}">${dieFace(d)}<b>${d}</b></button>`).join('')}</div>`;
        }
      }
      if (!actions) actions = '<p class="muted">다른 플레이어의 주사위 선택을 기다리는 중…</p>';
    } else if (g.phase === 'roundEnd' || g.phase === 'gameOver') {
      actions = `${g.phase === 'roundEnd' ? '<button id="nextRoundBarBtn" class="primary">다음 라운드</button>' : ''}
        <button id="showResultBtn" class="ghost">결과 보기</button>`;
    }
    $('actions').innerHTML = actions;

    // 로그
    $('log').innerHTML = g.log.map((l) => `<li>${esc(l)}</li>`).join('');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function renderResult() {
    const g = state.game;
    const r = g.lastResult;
    const open = (g.phase === 'roundEnd' || g.phase === 'gameOver') && r && dismissedResultRound !== `${g.round}-${g.phase}`;
    $('resultModal').classList.toggle('hidden', !open);
    if (!open) return;
    const winner = g.players.find((p) => p.id === g.winnerId);
    $('resultTitle').textContent = g.phase === 'gameOver'
      ? `🏆 최종 승자: ${winner ? winner.name : '없음'}`
      : `${r.round}라운드 결과`;
    $('resultRows').innerHTML = r.rows.map((row) => `
      <tr class="${row.winner ? 'win' : ''}">
        <td>${esc(row.name)}${row.id === state.you ? ' (나)' : ''}</td>
        <td><div class="mini">${cardHtml(row.hand.sand, row.impostor.sand, 'xs')}${cardHtml(row.hand.blood, row.impostor.blood, 'xs')}</div><small>${esc(row.evaluation.label)}</small></td>
        <td>${row.winner ? `승리${row.refund ? ` · ${row.refund}칩 회수` : ''}` : `패배 · 베팅 ${row.lostInvested} 손실 · 벌금 ${row.penalty}`}</td>
        <td>${row.chips}${row.chips === 0 ? ' <em class="tag off">탈락</em>' : ''}</td>
      </tr>`).join('');
    const isHost = state.hostId === state.you;
    let btns = '';
    if (g.phase === 'roundEnd') btns = '<button id="nextRoundBtn" class="primary">다음 라운드</button>';
    else if (isHost) btns = '<button id="rematchBtn" class="primary">다시 하기</button><button id="leaveBtn2" class="ghost">나가기</button>';
    else btns = '<span class="muted">방장이 재경기를 시작할 수 있습니다.</span><button id="leaveBtn2" class="ghost">나가기</button>';
    btns += '<button id="closeResultBtn" class="ghost">테이블 보기</button>';
    $('resultActions').innerHTML = btns;
  }

  // ---------- 보조 렌더 ----------
  function cardHtml(card, imp, size = '') {
    if (!card) return '';
    let face;
    if (card.kind === 'number') face = `<span class="val">${card.value}</span>${pips(card.value)}`;
    else if (card.kind === 'sylop') face = '<span class="val sym">◎</span><span class="kind">사일롭</span>';
    else {
      const v = imp && imp.value != null ? `<span class="imp-val">= ${imp.value}</span>` : '';
      face = `<span class="val sym">Ψ</span><span class="kind">임포스터</span>${v}`;
    }
    return `<div class="card ${card.suit} ${card.kind} ${size}">${face}</div>`;
  }
  function backHtml(suit, size = '') { return `<div class="card back ${suit} ${size}"></div>`; }
  function pips(n) { return `<span class="pips">${'<i></i>'.repeat(n)}</span>`; }
  function dieFace(n) { return ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n]; }
  function chipsHtml(n) { return `<span class="chip-stack">${'<i></i>'.repeat(Math.min(n, 10))}</span>`; }
  function avatar(name) {
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<span class="avatar" style="--h:${h}">${esc([...name][0] || '?')}</span>`;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function rotateToMe(players) {
    const i = players.findIndex((p) => p.id === state.you);
    return i < 0 ? players : [...players.slice(i + 1), ...players.slice(0, i + 1)];
  }
  function handHint(me) {
    const { sand, blood } = me.hand;
    if (sand.kind === 'sylop' && blood.kind === 'sylop') return '퓨어 사박!';
    if (sand.kind === 'sylop' || blood.kind === 'sylop') return '사일롭 사박 확정';
    if (sand.kind === 'impostor' || blood.kind === 'impostor') return '임포스터: 공개 시 주사위로 결정';
    const d = Math.abs(sand.value - blood.value);
    return d === 0 ? `사박 (${sand.value}/${blood.value})` : `현재 차이 ${d}`;
  }
  function timerHtml() {
    if (!state.deadline) return '';
    const s = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    return ` <span class="timer" data-deadline="${state.deadline}">⏱ ${s}s</span>`;
  }
  setInterval(() => {
    const t = document.querySelector('.timer');
    if (t) t.textContent = `⏱ ${Math.max(0, Math.ceil((Number(t.dataset.deadline) - Date.now()) / 1000))}s`;
  }, 500);

  function addChat({ name, text }) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(name)}</b> ${esc(text)}`;
    $('chat').appendChild(li);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2600);
  }

  // ---------- 입력 ----------
  $('nameInput').value = store.get('sabacc.name') || '';
  const qsRoom = new URLSearchParams(location.search).get('room');
  if (qsRoom) $('codeInput').value = qsRoom.toUpperCase();

  function getName() {
    const n = $('nameInput').value.trim();
    if (!n) { toast('닉네임을 입력하세요.'); $('nameInput').focus(); return null; }
    store.set('sabacc.name', n);
    return n;
  }

  $('createBtn').onclick = () => {
    const name = getName(); if (!name) return;
    sendMsg({ type: 'create', name, startChips: Number($('chipsInput').value) });
  };
  $('joinBtn').onclick = () => {
    const name = getName(); if (!name) return;
    const room = $('codeInput').value.trim().toUpperCase();
    if (room.length !== 4) { toast('4자리 방 코드를 입력하세요.'); return; }
    sendMsg({ type: 'join', room, name });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('startBtn').onclick = () => sendMsg({ type: 'start' });
  $('leaveBtn').onclick = () => sendMsg({ type: 'leave' });
  $('copyLinkBtn').onclick = async () => {
    const link = `${location.origin}${location.pathname}?room=${state.room}`;
    try { await navigator.clipboard.writeText(link); toast('초대 링크를 복사했습니다.'); } catch { toast(link); }
  };
  $('rulesBtn').onclick = () => $('rulesModal').classList.remove('hidden');
  $('rulesModal').addEventListener('click', (e) => {
    if (e.target === $('rulesModal') || e.target.dataset.close != null) $('rulesModal').classList.add('hidden');
  });

  document.querySelectorAll('.pile').forEach((el) => {
    el.onclick = () => sendMsg({ type: 'draw', suit: el.dataset.suit, from: el.dataset.from });
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'standBtn') sendMsg({ type: 'stand' });
    else if (t.dataset.keep) sendMsg({ type: 'keep', which: t.dataset.keep });
    else if (t.classList.contains('die')) sendMsg({ type: 'impostor', suit: t.dataset.suit, die: Number(t.dataset.die) });
    else if (t.id === 'nextRoundBtn' || t.id === 'nextRoundBarBtn') sendMsg({ type: 'nextRound' });
    else if (t.id === 'rematchBtn') sendMsg({ type: 'rematch' });
    else if (t.id === 'leaveBtn2') sendMsg({ type: 'leave' });
    else if (t.id === 'showResultBtn') { dismissedResultRound = null; renderResult(); }
    else if (t.id === 'closeResultBtn') {
      dismissedResultRound = `${state.game.round}-${state.game.phase}`;
      $('resultModal').classList.add('hidden');
    }
  });

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (text) sendMsg({ type: 'chat', text });
    $('chatInput').value = '';
  };

  connect();
})();
