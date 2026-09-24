'use strict';

const R = require('./rules');

// 한 방(room)의 Corellian Spike 게임 상태 머신. 서버 권위(authoritative) 방식.
// 한 핸드 = 참가비 → 2장 배분 → 3라운드 × (드로우 → 베팅 → 스파이크 주사위) → 쇼다운
// phase: lobby → draw → betting → (주사위 자동) → draw ... → handEnd → draw ... → gameOver
class Game {
  constructor({ startCredits = R.DEFAULT_START_CREDITS, rng = Math.random } = {}) {
    this.startCredits = startCredits;
    this.rng = rng;
    this.players = [];
    this.phase = 'lobby';
    this.handNo = 0;
    this.round = 0;
    this.dealerIdx = -1;
    this.order = [];
    this.drawPos = 0;
    this.betting = null;
    this.deck = [];
    this.discard = [];
    this.pots = { hand: 0, sabacc: 0 };
    this.lastDice = null;
    this.lastResult = null;
    this.winnerId = null;
    this.log = [];
  }

  // ---------- 로비 ----------
  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new GameError('이미 게임이 시작되었습니다.');
    if (this.players.length >= R.MAX_PLAYERS) throw new GameError(`최대 ${R.MAX_PLAYERS}명까지 참가할 수 있습니다.`);
    if (this.players.some((p) => p.id === id)) return;
    this.players.push({
      id, name, credits: 0, hand: [], pending: null, folded: false, eliminated: false,
      roundBet: 0, handBet: 0,
    });
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') throw new GameError('게임 중에는 나갈 수 없습니다.');
    this.players = this.players.filter((p) => p.id !== id);
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('이미 시작된 게임입니다.');
    if (this.players.length < R.MIN_PLAYERS) throw new GameError(`최소 ${R.MIN_PLAYERS}명이 필요합니다.`);
    for (const p of this.players) p.credits = this.startCredits;
    this.dealerIdx = Math.floor(this.rng() * this.players.length);
    this.addLog(`게임 시작! 모두 ${this.startCredits} 크레딧으로 시작합니다.`);
    this.startHand();
  }

  // ---------- 핸드 시작 ----------
  startHand() {
    this.handNo += 1;
    this.round = 1;
    this.lastResult = null;
    this.lastDice = null;
    this.deck = R.shuffle(R.buildDeck(), this.rng);
    this.discard = [];
    this.pots.hand = 0;
    for (const p of this.players) {
      p.hand = []; p.pending = null; p.folded = false; p.roundBet = 0; p.handBet = 0;
    }
    this.dealerIdx = this.nextActiveIndex(this.dealerIdx);
    const ante = R.ANTE_HAND_POT + R.ANTE_SABACC_POT;
    for (const p of this.inHand()) {
      p.credits -= ante;
      this.pots.hand += R.ANTE_HAND_POT;
      this.pots.sabacc += R.ANTE_SABACC_POT;
    }
    for (let i = 0; i < R.START_HAND_SIZE; i++) for (const p of this.inHand()) p.hand.push(this.drawCard());
    this.discard.push(this.drawCard());

    const first = this.nextActiveIndex(this.dealerIdx);
    this.order = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[(first + i) % this.players.length];
      if (!p.eliminated) this.order.push(p.id);
    }
    this.addLog(`— ${this.handNo}번째 핸드 (딜러: ${this.players[this.dealerIdx].name}) · 참가비 핸드 팟 ${R.ANTE_HAND_POT} + 사박 팟 ${R.ANTE_SABACC_POT} —`);
    this.startDrawPhase();
  }

  startDrawPhase() {
    this.phase = 'draw';
    this.drawPos = -1;
    this.advanceDraw();
  }

  // 폴드하지 않은 다음 플레이어로
  advanceDraw() {
    do { this.drawPos += 1; } while (this.drawPos < this.order.length && this.get(this.order[this.drawPos]).folded);
    if (this.drawPos >= this.order.length) this.startBetting();
  }

  // ---------- 유틸 ----------
  nextActiveIndex(from) {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (from + i) % this.players.length;
      if (!this.players[idx].eliminated) return idx;
    }
    return from;
  }

  activePlayers() { return this.players.filter((p) => !p.eliminated); }
  inHand() { return this.players.filter((p) => !p.eliminated && !p.folded); }
  get(id) { return this.players.find((p) => p.id === id); }

  currentPlayerId() {
    if (this.phase === 'draw') return this.order[this.drawPos] ?? null;
    if (this.phase === 'betting') return this.betting.queue[0] ?? null;
    return null;
  }

  assertTurn(id, phase) {
    if (this.phase !== phase) throw new GameError('지금은 그 행동을 할 수 없습니다.');
    if (this.currentPlayerId() !== id) throw new GameError('당신의 차례가 아닙니다.');
    return this.get(id);
  }

  drawCard() {
    if (this.deck.length === 0) {
      if (this.discard.length <= 1) throw new GameError('남은 카드가 없습니다.');
      const top = this.discard.pop();
      this.deck = R.shuffle(this.discard.splice(0), this.rng);
      this.discard.push(top);
      this.addLog('덱이 소진되어 버림 더미를 섞었습니다.');
    }
    return this.deck.pop();
  }

  pay(p, amount, pot = 'hand') {
    if (p.credits < amount) throw new GameError('크레딧이 부족합니다.');
    p.credits -= amount;
    this.pots[pot] += amount;
  }

  // ---------- 1. 드로우 페이즈 ----------
  // action: buyDraw | buyFaceUp | swapDraw | swapFaceUp | stand
  // swapFaceUp은 cardId(교체할 손패)를 함께 받음. swapDraw는 카드를 본 뒤 discardPending으로 버릴 카드 선택
  drawAction(id, action, cardId) {
    const p = this.assertTurn(id, 'draw');
    if (p.pending) throw new GameError('먼저 버릴 카드를 선택하세요.');
    if (!(action in R.DRAW_COSTS)) throw new GameError('잘못된 행동입니다.');
    const cost = R.DRAW_COSTS[action];
    if (p.credits < cost) throw new GameError('크레딧이 부족합니다.');
    const top = this.discard[this.discard.length - 1];

    switch (action) {
      case 'stand':
        this.addLog(`${p.name}: 스탠드`);
        break;
      case 'buyDraw':
      case 'buyFaceUp': {
        if (p.hand.length >= R.MAX_HAND_SIZE) throw new GameError(`손패는 최대 ${R.MAX_HAND_SIZE}장입니다.`);
        if (action === 'buyFaceUp' && !top) throw new GameError('공개 카드가 없습니다.');
        this.pay(p, cost);
        const card = action === 'buyDraw' ? this.drawCard() : this.discard.pop();
        p.hand.push(card);
        this.addLog(action === 'buyDraw'
          ? `${p.name}: Buy Draw — 덱에서 1장 추가 (${cost}크레딧)`
          : `${p.name}: Buy Face-Up — 공개 카드 ${fmt(card)} 추가 (${cost}크레딧)`);
        break;
      }
      case 'swapFaceUp': {
        if (!top) throw new GameError('공개 카드가 없습니다.');
        const idx = p.hand.findIndex((c) => c.id === cardId);
        if (idx < 0) throw new GameError('교체할 카드를 선택하세요.');
        this.pay(p, cost);
        const card = this.discard.pop();
        const out = p.hand.splice(idx, 1, card)[0];
        this.discard.push(out);
        this.addLog(`${p.name}: SWAP Face-Up — ${fmt(card)} 가져오고 ${fmt(out)} 버림`);
        break;
      }
      case 'swapDraw': {
        this.pay(p, cost);
        p.pending = this.drawCard();
        this.addLog(`${p.name}: SWAP Draw — 덱에서 1장 확인 중`);
        return; // 버릴 카드 선택 대기
      }
      default: break;
    }
    this.advanceDraw();
  }

  // SWAP Draw 후: 손패 또는 새 카드 중 1장 버림 (cardId === pending.id 면 새 카드를 버림)
  discardPending(id, cardId) {
    const p = this.assertTurn(id, 'draw');
    if (!p.pending) throw new GameError('확인 중인 카드가 없습니다.');
    let out;
    if (cardId === p.pending.id) {
      out = p.pending;
    } else {
      const idx = p.hand.findIndex((c) => c.id === cardId);
      if (idx < 0) throw new GameError('버릴 카드를 선택하세요.');
      out = p.hand.splice(idx, 1, p.pending)[0];
    }
    p.pending = null;
    this.discard.push(out);
    this.addLog(`${p.name}: ${fmt(out)} 버림`);
    this.advanceDraw();
  }

  // ---------- 2. 베팅 페이즈 ----------
  // 사이드 팟 없이 진행하도록, 베팅 한도 = 남은 플레이어 중 최소 보유 크레딧(테이블 스테이크)
  startBetting() {
    const live = this.inHand();
    const cap = Math.min(...live.map((p) => p.credits));
    for (const p of live) p.roundBet = 0;
    this.phase = 'betting';
    this.betting = { current: 0, cap, queue: this.order.filter((id) => !this.get(id).folded) };
    if (cap <= 0) {
      this.addLog('베팅 가능한 크레딧이 없어 베팅을 건너뜁니다.');
      this.endBetting();
    }
  }

  // action: check | bet | call | raise | fold, amount: bet/raise 후 이번 라운드 총 베팅액
  betAction(id, action, amount) {
    const p = this.assertTurn(id, 'betting');
    const b = this.betting;
    const owe = b.current - p.roundBet;
    switch (action) {
      case 'check':
        if (owe > 0) throw new GameError('체크할 수 없습니다. 콜·레이즈·폴드 중 선택하세요.');
        this.addLog(`${p.name}: 체크`);
        b.queue.shift();
        break;
      case 'call':
        if (owe <= 0) throw new GameError('콜할 베팅이 없습니다.');
        this.pay(p, owe);
        p.roundBet += owe; p.handBet += owe;
        this.addLog(`${p.name}: 콜 (${owe})`);
        b.queue.shift();
        break;
      case 'bet':
      case 'raise': {
        const to = Math.floor(Number(amount));
        if (!Number.isFinite(to) || to <= b.current) throw new GameError(`현재 베팅(${b.current})보다 많이 걸어야 합니다.`);
        if (to > b.cap) throw new GameError(`이번 라운드 베팅 한도는 ${b.cap} 크레딧입니다.`);
        const add = to - p.roundBet;
        this.pay(p, add);
        p.roundBet = to; p.handBet += add;
        this.addLog(`${p.name}: ${b.current === 0 ? '베팅' : '레이즈'} ${to}`);
        b.current = to;
        // 레이즈한 사람 다음부터 다시 한 바퀴
        const i = this.order.indexOf(id);
        b.queue = [];
        for (let k = 1; k < this.order.length; k++) {
          const q = this.get(this.order[(i + k) % this.order.length]);
          if (!q.folded && !q.eliminated) b.queue.push(q.id);
        }
        break;
      }
      case 'fold':
        p.folded = true;
        this.addLog(`${p.name}: 폴드`);
        b.queue.shift();
        if (this.inHand().length === 1) { this.winByFold(); return; }
        break;
      default:
        throw new GameError('잘못된 행동입니다.');
    }
    if (b.queue.length === 0) this.endBetting();
  }

  endBetting() {
    this.betting = null;
    this.rollSpike();
  }

  // ---------- 3. 스파이크 주사위 ----------
  rollSpike() {
    const faces = [pick(R.DICE_FACES, this.rng), pick(R.DICE_FACES, this.rng)];
    const shift = faces[0] === faces[1];
    this.lastDice = { round: this.round, faces, shift };
    if (shift) {
      // 사박 시프트: 모든 참가자가 손패를 버리고 같은 장수만큼 새로 받음
      for (const p of this.inHand()) {
        const n = p.hand.length;
        this.discard.push(...p.hand);
        p.hand = [];
        for (let i = 0; i < n; i++) p.hand.push(this.drawCard());
      }
      this.addLog(`🎲 ${this.round}라운드 스파이크: 같은 문양! 사박 시프트 — 모두 손패를 새로 받습니다.`);
    } else {
      this.addLog(`🎲 ${this.round}라운드 스파이크: 다른 문양, 변화 없음`);
    }
    if (this.round >= R.ROUNDS_PER_HAND) {
      this.showdown();
    } else {
      this.round += 1;
      this.startDrawPhase();
    }
  }

  // ---------- 정산 ----------
  winByFold() {
    const w = this.inHand()[0];
    const handPot = this.pots.hand;
    w.credits += handPot;
    this.pots.hand = 0;
    this.betting = null;
    this.addLog(`${w.name}: 나머지 전원 폴드로 핸드 팟 ${handPot} 획득 (사박 팟은 이월)`);
    this.lastResult = {
      handNo: this.handNo, byFold: true, handPot, sabaccPot: 0, carried: this.pots.sabacc,
      rows: [{ id: w.id, name: w.name, hand: null, evaluation: null, winner: true, won: handPot, folded: false, credits: w.credits }],
    };
    this.finishHand();
  }

  showdown() {
    const live = this.inHand();
    const evals = live.map((p) => ({ p, ev: R.evaluateHand(p.hand) }));
    const best = evals.reduce((a, b) => (R.compareRank(b.ev.rank, a.ev.rank) < 0 ? b : a)).ev.rank;
    let winners = evals.filter((e) => R.compareRank(e.ev.rank, best) === 0);
    let blindDraws = null;

    // 동률이면 싱글 블라인드 드로우: 동률자끼리 1장씩 받아 다시 비교 (최대 5회)
    if (winners.length > 1) {
      blindDraws = [];
      for (let t = 0; t < 5 && winners.length > 1; t++) {
        const tries = winners.map((w) => {
          const card = this.drawCard();
          const ev = R.evaluateHand([...w.p.hand, card]);
          this.discard.push(card);
          return { w, card, ev };
        });
        blindDraws.push(tries.map((x) => ({ id: x.w.p.id, card: x.card })));
        const b2 = tries.reduce((a, b) => (R.compareRank(b.ev.rank, a.ev.rank) < 0 ? b : a)).ev.rank;
        winners = tries.filter((x) => R.compareRank(x.ev.rank, b2) === 0).map((x) => x.w);
      }
      this.addLog(`동률 → 싱글 블라인드 드로우로 승자 결정`);
    }

    const handPot = this.pots.hand;
    const zero = winners[0].ev.zero;
    const sabaccPot = zero ? this.pots.sabacc : 0;
    const share = (total, i) => Math.floor(total / winners.length) + (i < total % winners.length ? 1 : 0);
    const winIds = new Set(winners.map((w) => w.p.id));
    const won = {};
    winners.forEach((w, i) => {
      won[w.p.id] = share(handPot, i) + share(sabaccPot, i);
      w.p.credits += won[w.p.id];
    });
    this.pots.hand = 0;
    if (zero) this.pots.sabacc = 0;

    const names = winners.map((w) => w.p.name).join(', ');
    this.addLog(`${names} 승리 — ${winners[0].ev.label}. 핸드 팟 ${handPot}${zero ? ` + 사박 팟 ${sabaccPot}` : ' (사박 팟 이월)'}`);
    this.lastResult = {
      handNo: this.handNo, byFold: false, handPot, sabaccPot, carried: this.pots.sabacc, blindDraws,
      rows: this.players.filter((p) => !p.eliminated).map((p) => {
        const e = evals.find((x) => x.p === p);
        return {
          id: p.id, name: p.name, folded: p.folded,
          hand: p.folded ? null : p.hand, evaluation: e ? e.ev : null,
          winner: winIds.has(p.id), won: won[p.id] || 0, credits: p.credits,
        };
      }),
    };
    this.finishHand();
  }

  finishHand() {
    const need = R.ANTE_HAND_POT + R.ANTE_SABACC_POT;
    for (const p of this.activePlayers()) {
      if (p.credits < need) {
        p.eliminated = true;
        this.addLog(`${p.name} 탈락 (참가비 ${need} 크레딧 부족)`);
      }
    }
    for (const r of this.lastResult.rows) r.credits = this.get(r.id).credits;
    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      this.phase = 'gameOver';
      this.winnerId = remaining[0]?.id ?? null;
      this.addLog(`게임 종료! 최종 승자: ${remaining[0]?.name ?? '없음'}`);
    } else {
      this.phase = 'handEnd';
    }
  }

  nextHand() {
    if (this.phase !== 'handEnd') throw new GameError('아직 핸드가 끝나지 않았습니다.');
    this.startHand();
  }

  // 연결 끊김·제한시간 초과 시 자동 행동: 드로우 = 스탠드(확인 중이면 새 카드 버림), 베팅 = 체크 또는 폴드
  autoAct(id) {
    if (this.currentPlayerId() !== id) return false;
    const p = this.get(id);
    if (this.phase === 'draw') {
      if (p.pending) this.discardPending(id, p.pending.id);
      else this.drawAction(id, 'stand');
      return true;
    }
    if (this.phase === 'betting') {
      this.betAction(id, this.betting.current > p.roundBet ? 'fold' : 'check');
      return true;
    }
    return false;
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 80) this.log.shift();
  }

  // ---------- 클라이언트별 뷰 (다른 사람 손패 숨김) ----------
  viewFor(viewerId) {
    const cur = this.currentPlayerId();
    const b = this.betting;
    return {
      phase: this.phase,
      handNo: this.handNo,
      round: this.round,
      roundsPerHand: R.ROUNDS_PER_HAND,
      startCredits: this.startCredits,
      currentPlayerId: cur,
      dealerId: this.dealerIdx >= 0 ? this.players[this.dealerIdx]?.id : null,
      winnerId: this.winnerId,
      deckCount: this.deck.length,
      faceUp: this.discard.length ? this.discard[this.discard.length - 1] : null,
      pots: { ...this.pots },
      betting: b ? { current: b.current, cap: b.cap } : null,
      lastDice: this.lastDice,
      rules: {
        drawCosts: R.DRAW_COSTS, maxHand: R.MAX_HAND_SIZE, anteHand: R.ANTE_HAND_POT, anteSabacc: R.ANTE_SABACC_POT,
      },
      players: this.players.map((p) => {
        const mine = p.id === viewerId;
        return {
          id: p.id,
          name: p.name,
          credits: p.credits,
          roundBet: p.roundBet,
          handBet: p.handBet,
          folded: p.folded,
          eliminated: p.eliminated,
          cardCount: p.hand.length,
          hand: mine ? p.hand : null,
          pending: mine ? p.pending : (p.pending ? { hidden: true } : null),
          evaluation: mine && p.hand.length ? R.evaluateHand(p.hand) : null,
        };
      }),
      lastResult: this.lastResult,
      log: this.log.slice(-40),
    };
  }
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function fmt(c) { return c.sylop ? '사일롭(0)' : `${c.value > 0 ? '+' : ''}${c.value}`; }

class GameError extends Error {}

module.exports = { Game, GameError };
