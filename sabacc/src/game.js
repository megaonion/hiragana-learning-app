'use strict';

const R = require('./rules');

// 한 방(room)의 Corellian Spike 게임 상태 머신. 서버 권위(authoritative) 방식.
// 한 게임(핸드) = 참가비 → 2장 배분 → 3라운드 × (드로우 → 베팅 → 스파이크 주사위) → 쇼다운
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
    this.faceUp = null; // 공개 카드 (항상 1장)
    this.discard = []; // 버린 카드 더미
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
      id, name, credits: 0, hand: [], folded: false, eliminated: false,
      roundBet: 0, betTotal: 0,
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

  // ---------- 게임(핸드) 시작 ----------
  startHand() {
    this.handNo += 1;
    this.round = 1;
    this.lastResult = null;
    this.lastDice = null;
    this.deck = R.shuffle(R.buildDeck(), this.rng);
    this.discard = [];
    this.pots.hand = 0;
    for (const p of this.players) {
      p.hand = []; p.folded = false; p.roundBet = 0; p.betTotal = 0;
    }
    this.dealerIdx = this.nextActiveIndex(this.dealerIdx);
    for (const p of this.inHand()) {
      this.pay(p, R.ANTE_HAND_POT, 'hand');
      this.pay(p, R.ANTE_SABACC_POT, 'sabacc');
    }
    for (let i = 0; i < R.START_HAND_SIZE; i++) for (const p of this.inHand()) p.hand.push(this.drawCard());
    this.faceUp = this.drawCard();

    const first = this.nextActiveIndex(this.dealerIdx);
    this.order = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[(first + i) % this.players.length];
      if (!p.eliminated) this.order.push(p.id);
    }
    this.addLog(`— ${this.handNo}번째 게임 (딜러: ${this.players[this.dealerIdx].name}) · 참가비 핸드 팟 ${R.ANTE_HAND_POT} + 사박 팟 ${R.ANTE_SABACC_POT} —`);
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
      if (this.discard.length === 0) throw new GameError('남은 카드가 없습니다.');
      this.deck = R.shuffle(this.discard.splice(0), this.rng);
      this.addLog('드로우 더미가 소진되어 버린 카드 더미를 섞었습니다.');
    }
    return this.deck.pop();
  }

  // 공개 카드를 가져가면 딜러가 드로우 더미에서 한 장을 채움
  takeFaceUp() {
    const card = this.faceUp;
    this.faceUp = this.drawCard();
    return card;
  }

  pay(p, amount, pot = 'hand') {
    if (p.credits < amount) throw new GameError('크레딧이 부족합니다.');
    p.credits -= amount;
    this.pots[pot] += amount;
  }

  // ---------- 1. 드로우 단계 ----------
  // action: buyDraw | buyFaceUp | swapDraw | swapFaceUp | stand
  // SWAP 두 가지는 먼저 버릴 손패(cardId)를 지정
  drawAction(id, action, cardId) {
    const p = this.assertTurn(id, 'draw');
    if (!(action in R.DRAW_COSTS)) throw new GameError('잘못된 행동입니다.');
    const cost = R.DRAW_COSTS[action];
    if (p.credits < cost) throw new GameError(`크레딧이 부족합니다 (${cost} 필요).`);

    switch (action) {
      case 'stand':
        this.addLog(`${p.name}: 스탠드`);
        break;
      case 'buyDraw':
      case 'buyFaceUp': {
        if (p.hand.length >= R.MAX_HAND_SIZE) throw new GameError(`손패는 최대 ${R.MAX_HAND_SIZE}장입니다.`);
        this.pay(p, cost);
        if (action === 'buyDraw') {
          p.hand.push(this.drawCard());
          this.addLog(`${p.name}: Buy Draw — 드로우 더미에서 1장 (${cost}크레딧)`);
        } else {
          const card = this.takeFaceUp();
          p.hand.push(card);
          this.addLog(`${p.name}: Buy Face-Up — 공개 카드 ${fmt(card)} 구매 (${cost}크레딧)`);
        }
        break;
      }
      case 'swapDraw':
      case 'swapFaceUp': {
        const idx = p.hand.findIndex((c) => c.id === cardId);
        if (idx < 0) throw new GameError('먼저 버릴 카드를 선택하세요.');
        this.pay(p, cost);
        const out = p.hand.splice(idx, 1)[0];
        this.discard.push(out);
        const card = action === 'swapDraw' ? this.drawCard() : this.takeFaceUp();
        p.hand.splice(idx, 0, card);
        this.addLog(action === 'swapDraw'
          ? `${p.name}: SWAP Draw — ${fmt(out)} 버리고 드로우 더미에서 1장`
          : `${p.name}: SWAP Face-Up — ${fmt(out)} 버리고 공개 카드 ${fmt(card)} 가져옴`);
        break;
      }
      default: break;
    }
    this.advanceDraw();
  }

  // ---------- 2. 베팅 단계 ----------
  // 순서대로 스탠드(추가 베팅 없음)·레이즈(2 이상)·콜·폴드. 올인 허용, 정산 때 사이드 팟 처리
  startBetting() {
    for (const p of this.inHand()) p.roundBet = 0;
    this.phase = 'betting';
    const queue = this.order.filter((id) => { const q = this.get(id); return !q.folded && q.credits > 0; });
    this.betting = { current: 0, queue };
    if (queue.length < 2) {
      this.addLog('베팅할 수 있는 참가자가 부족해 베팅을 건너뜁니다.');
      this.endBetting();
    }
  }

  // action: stand | raise | call | fold, amount: 레이즈 후 이번 라운드 총 베팅액
  betAction(id, action, amount) {
    const p = this.assertTurn(id, 'betting');
    const b = this.betting;
    const owe = b.current - p.roundBet;
    switch (action) {
      case 'stand':
        if (owe > 0) throw new GameError('레이즈가 있어 스탠드할 수 없습니다. 콜 또는 폴드하세요.');
        this.addLog(`${p.name}: 스탠드`);
        b.queue.shift();
        break;
      case 'call': {
        if (owe <= 0) throw new GameError('콜할 레이즈가 없습니다.');
        const pay = Math.min(owe, p.credits);
        this.putIn(p, pay);
        this.addLog(`${p.name}: 콜 ${pay}${p.credits === 0 ? ' (올인)' : ''}`);
        b.queue.shift();
        break;
      }
      case 'raise': {
        const to = Math.floor(Number(amount));
        const max = p.roundBet + p.credits;
        if (!Number.isFinite(to) || to <= b.current) throw new GameError('현재 베팅보다 많이 걸어야 합니다.');
        if (to > max) throw new GameError(`최대 ${max}까지 걸 수 있습니다.`);
        const allIn = to === max;
        if (to - b.current < R.MIN_RAISE && !allIn) throw new GameError(`레이즈는 ${R.MIN_RAISE} 크레딧 이상이어야 합니다.`);
        this.putIn(p, to - p.roundBet);
        b.current = to;
        this.addLog(`${p.name}: 레이즈 → ${to}${allIn ? ' (올인)' : ''}`);
        // 레이즈한 사람 다음부터, 더 걸 수 있는 사람들에게 다시 차례
        const i = this.order.indexOf(id);
        b.queue = [];
        for (let k = 1; k < this.order.length; k++) {
          const q = this.get(this.order[(i + k) % this.order.length]);
          if (!q.folded && !q.eliminated && q.credits > 0) b.queue.push(q.id);
        }
        break;
      }
      case 'fold':
        p.folded = true;
        this.addLog(`${p.name}: 폴드 (낸 크레딧은 팟에 남음)`);
        b.queue.shift();
        if (this.inHand().length === 1) { this.winByFold(); return; }
        break;
      default:
        throw new GameError('잘못된 행동입니다.');
    }
    if (b.queue.length === 0) this.endBetting();
  }

  // 베팅 단계에서 낸 금액만 betTotal에 기록 (사이드 팟 계산용). 참가비·드로우 비용은 메인 팟
  putIn(p, amount) {
    this.pay(p, amount);
    p.roundBet += amount;
    p.betTotal += amount;
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
      handNo: this.handNo, byFold: true, handPot, sabaccPot: 0, carried: this.pots.sabacc, pots: [],
      rows: [{ id: w.id, name: w.name, hand: null, evaluation: null, winner: true, won: handPot, folded: false, credits: w.credits }],
    };
    this.finishHand();
  }

  // 참가자별 비교 키: 족보 rank + (동률이면) 싱글 블라인드 드로우 결과
  strengthKeys(live) {
    const keys = new Map(live.map((p) => [p.id, [...R.evaluateHand(p.hand).rank]]));
    const blind = [];
    for (let t = 0; t < 5; t++) {
      const groups = new Map();
      for (const p of live) {
        const k = keys.get(p.id).join();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      const tied = [...groups.values()].filter((g) => g.length > 1);
      if (!tied.length) break;
      for (const g of tied) {
        for (const p of g) {
          // 한 장씩 뽑아 그 카드만으로 비교 (0에 가까울수록, 같으면 양수 우선)
          const card = this.drawCard();
          this.discard.push(card);
          keys.get(p.id).push(...R.evaluateHand([card]).rank);
          blind.push({ id: p.id, name: p.name, card });
        }
      }
    }
    return { keys, blind };
  }

  showdown() {
    const live = this.inHand();
    const evals = new Map(live.map((p) => [p.id, R.evaluateHand(p.hand)]));
    const { keys, blind } = this.strengthKeys(live);
    const best = (cands) => {
      const top = cands.reduce((a, b) => (R.compareRank(keys.get(b.id), keys.get(a.id)) < 0 ? b : a));
      return cands.filter((c) => R.compareRank(keys.get(c.id), keys.get(top.id)) === 0);
    };

    // 사이드 팟: 올인한 사람의 베팅 총액 단계별로 나눠, 그 단계까지 낸 참가자 중 최고 패가 가져감
    // 참가비·드로우 비용·폴드한 사람이 낸 몫(베팅 외 금액)은 메인 팟에 포함
    const maxBet = Math.max(...live.map((p) => p.betTotal));
    const levels = [...new Set(live.filter((p) => p.credits === 0 && p.betTotal < maxBet).map((p) => p.betTotal))]
      .sort((a, b) => a - b);
    levels.push(Infinity);
    const betSum = this.players.reduce((a, q) => a + q.betTotal, 0);
    const deadMoney = this.pots.hand - betSum;
    const won = {};
    const pots = [];
    let prev = 0;
    levels.forEach((lv, li) => {
      let amount = this.players.reduce((a, q) => a + Math.max(0, Math.min(q.betTotal, lv) - prev), 0);
      if (li === 0) amount += deadMoney;
      const eligible = live.filter((p) => p.betTotal >= Math.min(lv, maxBet));
      prev = lv;
      if (amount <= 0) return;
      const ws = best(eligible);
      ws.forEach((w, i) => { won[w.id] = (won[w.id] || 0) + share(amount, ws.length, i); });
      pots.push({ amount, winners: ws.map((w) => w.name), main: li === 0 });
    });

    // 사박 팟: 모두가 걸린 메인 팟 승자의 합계가 0일 때만
    const mainWinners = best(live);
    const zero = evals.get(mainWinners[0].id).zero;
    const sabaccPot = zero ? this.pots.sabacc : 0;
    if (zero) {
      mainWinners.forEach((w, i) => { won[w.id] = (won[w.id] || 0) + share(sabaccPot, mainWinners.length, i); });
      this.pots.sabacc = 0;
    }
    const handPot = this.pots.hand;
    this.pots.hand = 0;
    for (const [id, amt] of Object.entries(won)) this.get(id).credits += amt;

    const winIds = new Set(mainWinners.map((w) => w.id));
    const names = mainWinners.map((w) => w.name).join(', ');
    if (blind.length) this.addLog('동률 → 싱글 블라인드 드로우로 승자 결정');
    this.addLog(`${names} 승리 — ${evals.get(mainWinners[0].id).label}. 핸드 팟 ${handPot}${zero ? ` + 사박 팟 ${sabaccPot}` : ' (사박 팟 이월)'}`);
    this.lastResult = {
      handNo: this.handNo, byFold: false, handPot, sabaccPot, carried: this.pots.sabacc, blind, pots,
      rows: this.players.filter((p) => !p.eliminated).map((p) => ({
        id: p.id, name: p.name, folded: p.folded,
        hand: p.folded ? null : p.hand, evaluation: evals.get(p.id) || null,
        winner: winIds.has(p.id), won: won[p.id] || 0, credits: p.credits,
      })),
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
    if (this.phase !== 'handEnd') throw new GameError('아직 게임이 끝나지 않았습니다.');
    this.startHand();
  }

  // 연결 끊김·제한시간 초과 시 자동 행동: 드로우 = 스탠드, 베팅 = 스탠드(레이즈가 있으면 폴드)
  autoAct(id) {
    if (this.currentPlayerId() !== id) return false;
    const p = this.get(id);
    if (this.phase === 'draw') {
      this.drawAction(id, 'stand');
      return true;
    }
    if (this.phase === 'betting') {
      this.betAction(id, this.betting.current > p.roundBet ? 'fold' : 'stand');
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
    const b = this.betting;
    return {
      phase: this.phase,
      handNo: this.handNo,
      round: this.round,
      roundsPerHand: R.ROUNDS_PER_HAND,
      startCredits: this.startCredits,
      currentPlayerId: this.currentPlayerId(),
      dealerId: this.dealerIdx >= 0 ? this.players[this.dealerIdx]?.id : null,
      winnerId: this.winnerId,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      faceUp: this.faceUp,
      pots: { ...this.pots },
      betting: b ? { current: b.current } : null,
      lastDice: this.lastDice,
      rules: {
        drawCosts: R.DRAW_COSTS, maxHand: R.MAX_HAND_SIZE, anteHand: R.ANTE_HAND_POT,
        anteSabacc: R.ANTE_SABACC_POT, minRaise: R.MIN_RAISE,
      },
      players: this.players.map((p) => {
        const mine = p.id === viewerId;
        return {
          id: p.id,
          name: p.name,
          credits: p.credits,
          roundBet: p.roundBet,
          folded: p.folded,
          eliminated: p.eliminated,
          allIn: !p.folded && !p.eliminated && p.credits === 0 && this.phase !== 'handEnd',
          cardCount: p.hand.length,
          hand: mine ? p.hand : null,
          evaluation: mine && p.hand.length ? R.evaluateHand(p.hand) : null,
        };
      }),
      lastResult: this.lastResult,
      log: this.log.slice(-40),
    };
  }
}

function share(total, n, i) { return Math.floor(total / n) + (i < total % n ? 1 : 0); }
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function fmt(c) { return c.sylop ? '사일롭(0)' : `${c.value > 0 ? '+' : ''}${c.value}`; }

class GameError extends Error {}

module.exports = { Game, GameError };
