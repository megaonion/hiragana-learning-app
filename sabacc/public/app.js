'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
  };
  const DRAW_LABEL = {
    buyDraw: ['Buy Draw', '덱에서 1장 추가'],
    buyFaceUp: ['Buy Face-Up', '공개 카드 추가'],
    swapDraw: ['SWAP Draw', '덱에서 받고 1장 버림'],
    swapFaceUp: ['SWAP Face-Up', '공개 카드와 교체'],
    stand: ['Stand', '패스'],
  };
  const DIE = { circle: '●', square: '■', triangle: '▲', diamond: '◆', star: '✦', sylop: '⊕' };

  let ws = null;
  let state = null;
  let reconnectDelay = 500;
  let dismissedResult = null;
  let mode = null; // 'swapFaceUp' 선택 중

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
        if (state.game.currentPlayerId !== state.you || state.game.phase !== 'draw') mode = null;
        render();
        break;
      case 'left':
        store.del('sabacc.token'); store.del('sabacc.room');
        state = null;
        history.replaceState(null, '', location.pathname);
        show('home');
        $('roomBadge').classList.add('hidden');
        $('resultModal').classList.add('hidden');
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

  // ---------- 화면 ----------
  function show(id) {
    for (const s of ['home', 'lobby', 'table']) $(s).classList.toggle('hidden', s !== id);
  }

  function render() {
    const g = state.game;
    $('roomBadge').textContent = `ROOM ${state.room}`;
    $('roomBadge').classList.remove('hidden');
    fillRuleNumbers(g.rules);
    if (g.phase === 'lobby') { renderLobby(); show('lobby'); $('resultModal').classList.add('hidden'); return; }
    show('table');
    renderTable();
    renderResult();
  }

  function fillRuleNumbers(r) {
    const map = { anteHand: r.anteHand, anteSabacc: r.anteSabacc, maxHand: r.maxHand, buyDraw: r.drawCosts.buyDraw, buyFaceUp: r.drawCosts.buyFaceUp };
    document.querySelectorAll('[data-r]').forEach((el) => { el.textContent = map[el.dataset.r]; });
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
      ? `${state.minPlayers - n}명 더 필요합니다 (${n}/${state.maxPlayers}). 시작 크레딧 ${g.startCredits}.`
      : isHost ? `${n}명 준비 완료. 시작하세요! (최대 ${state.maxPlayers}명)` : '방장이 시작하기를 기다리는 중…';
  }

  function renderTable() {
    const g = state.game;
    const me = g.players.find((p) => p.id === state.you);
    const myTurn = g.currentPlayerId === state.you;
    const cur = g.players.find((p) => p.id === g.currentPlayerId);

    // 상태·단계
    const phaseName = { draw: '드로우', betting: '베팅', handEnd: '핸드 종료', gameOver: '게임 종료' }[g.phase];
    let status = `${g.handNo}번째 핸드 · ${g.round}/${g.roundsPerHand}라운드 · ${phaseName}`;
    if (cur) status += ` · ${myTurn ? '<b class="hl">당신의 차례</b>' : `${esc(cur.name)}의 차례`}`;
    $('status').innerHTML = status + timerHtml();
    const steps = ['draw', 'betting', 'spike'];
    const activeStep = g.phase === 'draw' ? 0 : g.phase === 'betting' ? 1 : -1;
    $('phases').innerHTML = steps.map((s, i) => `<span class="${i === activeStep ? 'on' : ''}">${i + 1}. ${['드로우', '베팅', '스파이크'][i]}</span>`).join('');

    // 상대
    $('opponents').innerHTML = rotateToMe(g.players).filter((p) => p.id !== state.you).map((p) => {
      const turn = p.id === g.currentPlayerId;
      const off = !state.connected.includes(p.id);
      let body;
      if (p.eliminated) body = '<span class="muted">탈락</span>';
      else if (p.folded) body = '<span class="muted">폴드</span>';
      else body = Array.from({ length: p.cardCount }, () => backHtml('sm')).join('') + (p.pending ? backHtml('sm pending') : '');
      return `<div class="opp ${turn ? 'turn' : ''} ${p.eliminated || p.folded ? 'out' : ''}">
        <div class="opp-head">${avatar(p.name)}<span class="nm">${esc(p.name)}</span>${p.id === g.dealerId ? '<em class="tag">딜러</em>' : ''}${off ? '<em class="tag off">오프라인</em>' : ''}</div>
        <div class="opp-hand">${body}</div>
        <div class="credits">${coins(p.credits)}<b>${p.credits}</b>${p.roundBet ? `<span class="inv">베팅 ${p.roundBet}</span>` : ''}</div>
      </div>`;
    }).join('');

    // 중앙
    $('deckPile').innerHTML = `${backHtml()}<span class="count">${g.deckCount}</span>`;
    $('faceUpPile').innerHTML = g.faceUp ? cardHtml(g.faceUp) : '<div class="card empty"></div>';
    $('handPot').innerHTML = `${coins(g.pots.hand)}<b>${g.pots.hand}</b>`;
    $('sabaccPot').innerHTML = `${coins(g.pots.sabacc)}<b>${g.pots.sabacc}</b>`;
    if (g.lastDice) {
      $('dice').innerHTML = g.lastDice.faces.map((f) => `<span class="die ${g.lastDice.shift ? 'match' : ''}">${DIE[f]}</span>`).join('');
      $('diceCap').textContent = g.lastDice.shift ? `${g.lastDice.round}R 사박 시프트!` : `${g.lastDice.round}R 결과`;
    } else {
      $('dice').innerHTML = '<span class="die idle">?</span><span class="die idle">?</span>';
      $('diceCap').textContent = '스파이크 주사위';
    }

    if (!me) return;
    // 내 정보
    const ev = me.evaluation;
    $('myInfo').innerHTML = `${avatar(me.name)}<b>${esc(me.name)}</b>
      <span class="credits">${coins(me.credits)}<b>${me.credits}</b> 크레딧</span>
      ${me.roundBet ? `<span class="inv">이번 라운드 베팅 ${me.roundBet}</span>` : ''}
      ${me.eliminated ? '<em class="tag off">탈락 — 관전 중</em>' : ''}
      ${me.folded ? '<em class="tag off">폴드</em>' : ''}
      ${ev && !me.eliminated ? `<span class="hint">합계 ${ev.total > 0 ? '+' : ''}${ev.total} · ${esc(ev.name)}</span>` : ''}`;

    // 내 손패
    const selectable = myTurn && g.phase === 'draw' && (mode === 'swapFaceUp' || me.pending);
    let handHtml = (me.hand || []).map((c) => (selectable
      ? `<button class="pick" data-card="${c.id}">${cardHtml(c)}</button>`
      : cardHtml(c))).join('');
    if (me.pending) {
      handHtml += `<div class="pending-wrap"><span class="new-tag">새 카드</span><button class="pick" data-card="${me.pending.id}">${cardHtml(me.pending, 'new')}</button></div>`;
    }
    $('myHand').innerHTML = me.eliminated ? '' : handHtml;

    // 행동
    let actions = '';
    if (myTurn && g.phase === 'draw') {
      if (me.pending) actions = '<p class="muted">버릴 카드를 한 장 누르세요 (새 카드 포함).</p>';
      else if (mode === 'swapFaceUp') actions = '<p class="muted">공개 카드와 바꿀 손패를 누르세요.</p><button data-act="cancelMode" class="ghost">취소</button>';
      else {
        const c = g.rules.drawCosts;
        const full = me.hand.length >= g.rules.maxHand;
        const btn = (a, disabled) => `<button class="draw-btn" data-draw="${a}" ${disabled ? 'disabled' : ''}>
            <b>${DRAW_LABEL[a][0]}</b><small>${DRAW_LABEL[a][1]}${c[a] ? ` · ${c[a]}크레딧` : ''}</small></button>`;
        actions = `<div class="draw-grid">
          ${btn('buyDraw', full || me.credits < c.buyDraw)}
          ${btn('buyFaceUp', full || !g.faceUp || me.credits < c.buyFaceUp)}
          ${btn('swapDraw', me.credits < c.swapDraw)}
          ${btn('swapFaceUp', !g.faceUp || me.credits < c.swapFaceUp)}
          ${btn('stand', false)}
        </div>`;
      }
    } else if (myTurn && g.phase === 'betting') {
      const b = g.betting;
      const owe = b.current - me.roundBet;
      const min = b.current + 1;
      const canRaise = min <= b.cap;
      const input = canRaise ? `<input id="betAmount" type="number" min="${min}" max="${b.cap}" value="${min}" />` : '';
      if (owe <= 0) {
        actions = `<div class="bet-row">
          <button data-bet="check">체크</button>
          ${canRaise ? `${input}<button data-bet="bet" class="primary">베팅</button>` : ''}
          <button data-bet="fold" class="ghost">폴드</button></div>`;
      } else {
        actions = `<div class="bet-row">
          <button data-bet="call" class="primary">콜 (${owe})</button>
          ${canRaise ? `${input}<button data-bet="raise">레이즈</button>` : ''}
          <button data-bet="fold" class="ghost">폴드</button></div>`;
      }
      actions += `<p class="muted">현재 베팅 ${b.current} · 이번 라운드 한도 ${b.cap}</p>`;
    } else if (g.phase === 'handEnd') {
      actions = '<button data-act="nextHand" class="primary">다음 핸드</button><button data-act="showResult" class="ghost">결과 보기</button>';
    } else if (g.phase === 'gameOver') {
      actions = '<button data-act="showResult" class="ghost">결과 보기</button>';
    }
    $('actions').innerHTML = actions;

    $('log').innerHTML = g.log.map((l) => `<li>${esc(l)}</li>`).join('');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function renderResult() {
    const g = state.game;
    const r = g.lastResult;
    const tag = `${g.handNo}-${g.phase}`;
    const open = (g.phase === 'handEnd' || g.phase === 'gameOver') && r && dismissedResult !== tag;
    $('resultModal').classList.toggle('hidden', !open);
    if (!open) return;
    const winner = g.players.find((p) => p.id === g.winnerId);
    $('resultTitle').textContent = g.phase === 'gameOver' ? `🏆 최종 승자: ${winner ? winner.name : '없음'}` : `${r.handNo}번째 핸드 결과`;
    $('resultSub').textContent = r.byFold
      ? `나머지 전원 폴드 — 핸드 팟 ${r.handPot} 획득, 사박 팟 ${r.carried} 이월`
      : `핸드 팟 ${r.handPot}${r.sabaccPot ? ` + 사박 팟 ${r.sabaccPot}` : ` · 사박 팟 ${r.carried} 이월`}${r.blindDraws ? ' · 동률로 싱글 블라인드 드로우 진행' : ''}`;
    $('resultRows').innerHTML = r.rows.map((row) => `
      <div class="res ${row.winner ? 'win' : ''}">
        <div class="res-name">${esc(row.name)}${row.id === state.you ? ' (나)' : ''}${row.winner ? ' <em class="tag">승리</em>' : ''}</div>
        <div class="res-hand">${row.hand ? row.hand.map((c) => cardHtml(c, 'xs')).join('') : `<span class="muted">${row.folded ? '폴드' : '—'}</span>`}</div>
        <div class="res-eval">${row.evaluation ? esc(row.evaluation.label) : ''}</div>
        <div class="res-cr">${row.won ? `+${row.won} · ` : ''}${row.credits} 크레딧${row.credits < g.rules.anteHand + g.rules.anteSabacc ? ' <em class="tag off">탈락</em>' : ''}</div>
      </div>`).join('');
    let btns = '';
    if (g.phase === 'handEnd') btns = '<button data-act="nextHand" class="primary">다음 핸드</button>';
    else if (state.hostId === state.you) btns = '<button data-act="rematch" class="primary">다시 하기</button><button data-act="leave" class="ghost">나가기</button>';
    else btns = '<span class="muted">방장이 재경기를 시작할 수 있습니다.</span><button data-act="leave" class="ghost">나가기</button>';
    btns += '<button data-act="closeResult" class="ghost">테이블 보기</button>';
    $('resultActions').innerHTML = btns;
  }

  // ---------- 카드·칩 렌더 ----------
  const SHAPE = { circle: 'c', square: 's', triangle: 't' };
  function cardHtml(card, extra = '') {
    if (!card) return '';
    if (card.sylop) {
      return `<div class="card sylop ${extra}"><span class="band"></span><span class="sylop-mark">⊕</span><span class="num">0</span><span class="band"></span></div>`;
    }
    const n = Math.abs(card.value);
    const sign = card.value > 0 ? 'pos' : 'neg';
    const face = n <= 6
      ? `<span class="pips p${n}">${`<i class="${SHAPE[card.stave]}"></i>`.repeat(n)}</span>`
      : `<span class="orn">${['✶', '✺', '❖', '✹'][n - 7]}</span>`;
    return `<div class="card ${sign} ${extra}" title="${card.value > 0 ? '+' : ''}${card.value}">
      <span class="band"></span>${face}<span class="num">${card.value > 0 ? '+' : '−'}${n}</span><span class="band"></span></div>`;
  }
  function backHtml(extra = '') { return `<div class="card back ${extra}"></div>`; }
  function coins(n) {
    const tens = Math.floor(n / 10); const fives = Math.floor((n % 10) / 5); const ones = n % 5;
    const chip = (cls, k) => `<i class="coin ${cls}"></i>`.repeat(Math.min(k, 4));
    return `<span class="coins">${chip('c10', tens)}${chip('c5', fives)}${chip('c1', ones)}</span>`;
  }
  function avatar(name) {
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="avatar" style="--h:${h}">${esc([...name][0] || '?')}</span>`;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  function rotateToMe(players) {
    const i = players.findIndex((p) => p.id === state.you);
    return i < 0 ? players : [...players.slice(i + 1), ...players.slice(0, i + 1)];
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
    sendMsg({ type: 'create', name, startCredits: Number($('creditsInput').value) });
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

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || !state) return;
    const g = state.game;
    if (t.dataset.draw) {
      if (t.dataset.draw === 'swapFaceUp') { mode = 'swapFaceUp'; renderTable(); return; }
      sendMsg({ type: 'draw', action: t.dataset.draw });
    } else if (t.dataset.card) {
      const me = g.players.find((p) => p.id === state.you);
      if (me.pending) sendMsg({ type: 'discardPending', cardId: t.dataset.card });
      else if (mode === 'swapFaceUp') { sendMsg({ type: 'draw', action: 'swapFaceUp', cardId: t.dataset.card }); mode = null; }
    } else if (t.dataset.bet) {
      const amount = $('betAmount') ? Number($('betAmount').value) : undefined;
      sendMsg({ type: 'bet', action: t.dataset.bet, amount });
    } else if (t.dataset.act) {
      const a = t.dataset.act;
      if (a === 'nextHand') sendMsg({ type: 'nextHand' });
      else if (a === 'rematch') sendMsg({ type: 'rematch' });
      else if (a === 'leave') sendMsg({ type: 'leave' });
      else if (a === 'cancelMode') { mode = null; renderTable(); }
      else if (a === 'showResult') { dismissedResult = null; renderResult(); }
      else if (a === 'closeResult') { dismissedResult = `${g.handNo}-${g.phase}`; $('resultModal').classList.add('hidden'); }
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
