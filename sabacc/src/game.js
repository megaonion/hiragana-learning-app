'use strict';

const R = require('./rules');

// 한 방(room)의 Kessel Sabacc 게임 상태 머신. 서버 권위(authoritative) 방식.
// phase: lobby → turn → (impostor) → roundEnd → turn ... → gameOver
class Game {
  constructor({ startChips = R.DEFAULT_START_CHIPS, rng = Math.random } = {}) {
    this.startChips = startChips;
    this.rng = rng;
    this.players = [];
    this.phase = 'lobby';
    this.round = 0;
    this.turn = 0;
    this.order = [];
    this.orderPos = 0;
    this.dealerIdx = -1;
    this.decks = { sand: [], blood: [] };
    this.discards = { sand: [], blood: [] };
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
      id, name, chips: 0, invested: 0, hand: null, pending: null,
      eliminated: false, impostor: {}, result: null,
    });
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') throw new GameError('게임 중에는 나갈 수 없습니다.');
    this.players = this.players.filter((p) => p.id !== id);
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('이미 시작된 게임입니다.');
    if (this.players.length < R.MIN_PLAYERS) throw new GameError(`최소 ${R.MIN_PLAYERS}명이 필요합니다.`);
    for (const p of this.players) {
      p.chips = this.startChips;
      p.eliminated = false;
    }
    this.dealerIdx = Math.floor(this.rng() * this.players.length);
    this.addLog(`게임 시작! 모두 ${this.startChips}칩으로 시작합니다.`);
    this.startRound();
  }

  // ---------- 라운드 진행 ----------
  startRound() {
    this.round += 1;
    this.turn = 1;
    this.lastResult = null;
    for (const s of R.SUITS) {
      this.decks[s] = R.shuffle(R.buildDeck(s), this.rng);
      this.discards[s] = [];
    }
    const active = this.activePlayers();
    for (const p of this.players) {
      p.hand = null; p.pending = null; p.invested = 0; p.impostor = {}; p.result = null;
    }
    for (const p of active) p.hand = { sand: this.decks.sand.pop(), blood: this.decks.blood.pop() };
    for (const s of R.SUITS) this.discards[s].push(this.decks[s].pop());

    // 딜러 다음 사람부터 시작, 딜러는 매 라운드 순환
    this.dealerIdx = this.nextActiveIndex(this.dealerIdx);
    const first = this.nextActiveIndex(this.dealerIdx);
    this.order = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[(first + i) % this.players.length];
      if (!p.eliminated) this.order.push(p.id);
    }
    this.orderPos = 0;
    this.phase = 'turn';
    this.addLog(`— ${this.round}라운드 시작 (선: ${this.get(this.order[0]).name}) —`);
  }

  nextActiveIndex(from) {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (from + i) % this.players.length;
      if (!this.players[idx].eliminated) return idx;
    }
    return from;
  }

  activePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  get(id) {
    return this.players.find((p) => p.id === id);
  }

  currentPlayerId() {
    return this.phase === 'turn' ? this.order[this.orderPos] : null;
  }

  assertTurn(id) {
    if (this.phase !== 'turn') throw new GameError('지금은 행동할 수 없습니다.');
    if (this.currentPlayerId() !== id) throw new GameError('당신의 차례가 아닙니다.');
    return this.get(id);
  }

  // source: { suit: 'sand'|'blood', from: 'deck'|'discard' }
  draw(id, source) {
    const p = this.assertTurn(id);
    if (p.pending) throw new GameError('먼저 가져온 카드를 처리하세요.');
    if (!source || !R.SUITS.includes(source.suit) || !['deck', 'discard'].includes(source.from)) {
      throw new GameError('잘못된 카드 더미입니다.');
    }
    if (p.chips < R.DRAW_COST) throw new GameError('칩이 부족해 카드를 뽑을 수 없습니다. 스탠드만 가능합니다.');
    const { suit, from } = source;
    let card;
    if (from === 'deck') {
      if (this.decks[suit].length === 0) this.reshuffle(suit);
      card = this.decks[suit].pop();
    } else {
      card = this.discards[suit].pop();
    }
    if (!card) throw new GameError('해당 더미가 비어 있습니다.');
    p.chips -= R.DRAW_COST;
    p.invested += R.DRAW_COST;
    p.pending = card;
    this.addLog(`${p.name}: ${suitName(suit)} ${from === 'deck' ? '덱' : '버림 더미'}에서 1장 뽑음 (1칩)`);
  }

  // which: 'drawn' = 새 카드를 갖고 기존 카드 버림, 'hand' = 새 카드를 버림
  keep(id, which) {
    const p = this.assertTurn(id);
    if (!p.pending) throw new GameError('가져온 카드가 없습니다.');
    if (!['drawn', 'hand'].includes(which)) throw new GameError('잘못된 선택입니다.');
    const suit = p.pending.suit;
    if (which === 'drawn') {
      this.discards[suit].push(p.hand[suit]);
      p.hand[suit] = p.pending;
    } else {
      this.discards[suit].push(p.pending);
    }
    p.pending = null;
    this.advance();
  }

  stand(id) {
    const p = this.assertTurn(id);
    if (p.pending) throw new GameError('먼저 가져온 카드를 처리하세요.');
    this.addLog(`${p.name}: 스탠드`);
    this.advance();
  }

  reshuffle(suit) {
    const pile = this.discards[suit];
    if (pile.length <= 1) return;
    const top = pile.pop();
    this.decks[suit] = R.shuffle(pile.splice(0), this.rng);
    pile.push(top);
    this.addLog(`${suitName(suit)} 덱이 소진되어 버림 더미를 섞었습니다.`);
  }

  advance() {
    this.orderPos += 1;
    if (this.orderPos < this.order.length) return;
    this.orderPos = 0;
    this.turn += 1;
    if (this.turn > R.TURNS_PER_ROUND) this.reveal();
  }

  // ---------- 공개 & 임포스터 ----------
  reveal() {
    this.addLog('카드 공개!');
    let waiting = false;
    for (const p of this.activePlayers()) {
      for (const s of R.SUITS) {
        if (p.hand[s].kind !== 'impostor') continue;
        const dice = [rollDie(this.rng), rollDie(this.rng)];
        p.impostor[s] = { dice, value: dice[0] === dice[1] ? dice[0] : null };
        if (p.impostor[s].value == null) waiting = true;
      }
    }
    if (waiting) {
      this.phase = 'impostor';
    } else {
      this.score();
    }
  }

  chooseImpostor(id, suit, dieIndex) {
    if (this.phase !== 'impostor') throw new GameError('지금은 주사위를 고를 수 없습니다.');
    const p = this.get(id);
    const imp = p && p.impostor[suit];
    if (!imp || imp.value != null) throw new GameError('선택할 임포스터 카드가 없습니다.');
    if (dieIndex !== 0 && dieIndex !== 1) throw new GameError('잘못된 주사위입니다.');
    imp.value = imp.dice[dieIndex];
    this.addLog(`${p.name}: ${suitName(suit)} 임포스터 값으로 ${imp.value} 선택`);
    if (this.pendingImpostors().length === 0) this.score();
  }

  pendingImpostors() {
    const list = [];
    for (const p of this.activePlayers()) {
      for (const s of R.SUITS) if (p.impostor[s] && p.impostor[s].value == null) list.push({ id: p.id, suit: s });
    }
    return list;
  }

  // ---------- 정산 ----------
  score() {
    const active = this.activePlayers();
    const evals = active.map((p) => ({
      p,
      ev: R.evaluateHand(p.hand, { sand: p.impostor.sand?.value, blood: p.impostor.blood?.value }),
    }));
    const best = evals.reduce((a, b) => (R.compareRank(b.ev.rank, a.ev.rank) < 0 ? b : a)).ev.rank;
    const rows = [];
    for (const { p, ev } of evals) {
      const winner = R.compareRank(ev.rank, best) === 0;
      let refund = 0; let penalty = 0; const lostInvested = winner ? 0 : p.invested;
      if (winner) {
        refund = p.invested;
        p.chips += refund;
      } else {
        penalty = Math.min(R.penaltyFor(ev), p.chips);
        p.chips -= penalty;
      }
      p.result = { evaluation: ev, winner, refund, penalty, lostInvested };
      rows.push({ id: p.id, name: p.name, hand: p.hand, impostor: p.impostor, ...p.result, chips: p.chips });
      p.invested = 0;
    }
    const winners = rows.filter((r) => r.winner).map((r) => r.name);
    this.addLog(`${this.round}라운드 승자: ${winners.join(', ')}`);

    for (const p of active) {
      if (p.chips <= 0) {
        p.eliminated = true;
        this.addLog(`${p.name} 탈락 (칩 소진)`);
      }
    }
    this.lastResult = { round: this.round, rows };
    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      this.phase = 'gameOver';
      this.winnerId = remaining[0]?.id ?? null;
      this.addLog(`게임 종료! 최종 승자: ${remaining[0]?.name ?? '없음'}`);
    } else {
      this.phase = 'roundEnd';
    }
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('아직 라운드가 끝나지 않았습니다.');
    this.startRound();
  }

  // 연결 끊김·제한시간 초과 시 자동 행동: 스탠드 / 새 카드 버림 / 유리한 주사위 선택
  autoAct(id) {
    if (this.phase === 'turn' && this.currentPlayerId() === id) {
      const p = this.get(id);
      if (p.pending) this.keep(id, 'hand');
      else this.stand(id);
      return true;
    }
    if (this.phase === 'impostor') {
      const p = this.get(id);
      for (const s of R.SUITS) {
        const imp = p?.impostor[s];
        if (imp && imp.value == null) this.chooseImpostor(id, s, bestDieIndex(p, s));
      }
      return true;
    }
    return false;
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 60) this.log.shift();
  }

  // ---------- 클라이언트별 뷰 (다른 사람 손패 숨김) ----------
  viewFor(viewerId) {
    const revealed = this.phase === 'impostor' || this.phase === 'roundEnd' || this.phase === 'gameOver';
    return {
      phase: this.phase,
      round: this.round,
      turn: this.turn,
      turnsPerRound: R.TURNS_PER_ROUND,
      startChips: this.startChips,
      currentPlayerId: this.currentPlayerId(),
      dealerId: this.dealerIdx >= 0 ? this.players[this.dealerIdx]?.id : null,
      winnerId: this.winnerId,
      decks: { sand: this.decks.sand.length, blood: this.decks.blood.length },
      discardTop: { sand: top(this.discards.sand), blood: top(this.discards.blood) },
      discardCount: { sand: this.discards.sand.length, blood: this.discards.blood.length },
      players: this.players.map((p) => {
        const mine = p.id === viewerId;
        const showHand = p.hand && (mine || (revealed && !p.eliminated));
        return {
          id: p.id,
          name: p.name,
          chips: p.chips,
          invested: p.invested,
          eliminated: p.eliminated,
          hand: showHand ? p.hand : null,
          hasHand: !!p.hand,
          pending: mine ? p.pending : (p.pending ? { hidden: true, suit: p.pending.suit } : null),
          impostor: mine || revealed ? p.impostor : {},
        };
      }),
      lastResult: this.lastResult,
      log: this.log.slice(-30),
    };
  }
}

function bestDieIndex(p, suit) {
  const imp = p.impostor[suit];
  const other = suit === 'sand' ? 'blood' : 'sand';
  const oc = p.hand[other];
  let target;
  if (oc.kind === 'number') target = oc.value;
  else if (oc.kind === 'impostor') target = p.impostor[other]?.value ?? null;
  else return imp.dice[0] <= imp.dice[1] ? 0 : 1; // 사일롭: 낮을수록 좋은 사박
  if (target == null) return imp.dice[0] <= imp.dice[1] ? 0 : 1;
  const d0 = Math.abs(imp.dice[0] - target); const d1 = Math.abs(imp.dice[1] - target);
  if (d0 !== d1) return d0 < d1 ? 0 : 1;
  return imp.dice[0] <= imp.dice[1] ? 0 : 1;
}

function rollDie(rng) {
  return 1 + Math.floor(rng() * 6);
}

function top(arr) {
  return arr.length ? arr[arr.length - 1] : null;
}

function suitName(s) {
  return s === 'sand' ? '샌드' : '블러드';
}

class GameError extends Error {}

module.exports = { Game, GameError };
