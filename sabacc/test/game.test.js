'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules');
const { Game, GameError } = require('../src/game');

const num = (suit, value) => ({ id: `${suit}${value}`, suit, kind: 'number', value });
const imp = (suit) => ({ id: `${suit}i`, suit, kind: 'impostor', value: null });
const syl = (suit) => ({ id: `${suit}s`, suit, kind: 'sylop', value: 0 });
const hand = (sand, blood) => ({ sand, blood });

function seeded(seed = 1) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

function newGame(n = 3, opts = {}) {
  const g = new Game({ rng: seeded(42), ...opts });
  for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`);
  g.start();
  return g;
}

test('덱 구성: 22장, 1~6 각 3장, 임포스터 3장, 사일롭 1장', () => {
  const d = R.buildDeck('sand');
  assert.equal(d.length, 22);
  for (let v = 1; v <= 6; v++) assert.equal(d.filter((c) => c.value === v && c.kind === 'number').length, 3);
  assert.equal(d.filter((c) => c.kind === 'impostor').length, 3);
  assert.equal(d.filter((c) => c.kind === 'sylop').length, 1);
});

test('족보: 퓨어 사박 > 프라임 사박 > 높은 사박 > 차이', () => {
  const pure = R.evaluateHand(hand(syl('sand'), syl('blood')));
  const prime = R.evaluateHand(hand(num('sand', 1), num('blood', 1)));
  const six = R.evaluateHand(hand(num('sand', 6), num('blood', 6)));
  const diff1 = R.evaluateHand(hand(num('sand', 2), num('blood', 3)));
  const diff1High = R.evaluateHand(hand(num('sand', 5), num('blood', 6)));
  const diff3 = R.evaluateHand(hand(num('sand', 1), num('blood', 4)));
  const ordered = [pure, prime, six, diff1, diff1High, diff3];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(R.compareRank(ordered[i].rank, ordered[i + 1].rank) < 0, `${ordered[i].label} > ${ordered[i + 1].label}`);
  }
});

test('사일롭은 다른 카드 값을 따르고, 임포스터는 선택한 주사위 값', () => {
  const s = R.evaluateHand(hand(syl('sand'), num('blood', 4)));
  assert.equal(s.type, 'sabacc');
  assert.equal(s.sand, 4);
  const i = R.evaluateHand(hand(imp('sand'), num('blood', 2)), { sand: 5 });
  assert.equal(i.diff, 3);
  const si = R.evaluateHand(hand(imp('sand'), syl('blood')), { sand: 3 });
  assert.deepEqual([si.type, si.blood], ['sabacc', 3]);
});

test('벌금: 사박으로 지면 1칩, 아니면 차이만큼', () => {
  assert.equal(R.penaltyFor(R.evaluateHand(hand(num('sand', 3), num('blood', 3)))), 1);
  assert.equal(R.penaltyFor(R.evaluateHand(hand(num('sand', 1), num('blood', 5)))), 4);
});

test('3~6명 제한', () => {
  const g = new Game();
  g.addPlayer('a', 'A'); g.addPlayer('b', 'B');
  assert.throws(() => g.start(), GameError);
  for (let i = 0; i < 4; i++) g.addPlayer(`x${i}`, `X${i}`);
  assert.throws(() => g.addPlayer('y', 'Y'), GameError);
});

test('시작 시 각자 샌드 1장+블러드 1장, 버림 더미 각 1장', () => {
  const g = newGame(4);
  for (const p of g.players) {
    assert.equal(p.hand.sand.suit, 'sand');
    assert.equal(p.hand.blood.suit, 'blood');
    assert.equal(p.chips, R.DEFAULT_START_CHIPS);
  }
  assert.equal(g.discards.sand.length, 1);
  assert.equal(g.decks.sand.length, 22 - 4 - 1);
});

test('차례가 아니면 행동 불가, 드로우는 1칩 소모 후 같은 계열 1장 버림', () => {
  const g = newGame(3);
  const cur = g.currentPlayerId();
  const other = g.players.find((p) => p.id !== cur).id;
  assert.throws(() => g.stand(other), GameError);

  const p = g.get(cur);
  const discardTop = g.discards.blood.at(-1);
  g.draw(cur, { suit: 'blood', from: 'discard' });
  assert.equal(p.chips, R.DEFAULT_START_CHIPS - 1);
  assert.equal(p.invested, 1);
  assert.equal(p.pending, discardTop);
  assert.throws(() => g.stand(cur), GameError);
  const old = p.hand.blood;
  g.keep(cur, 'drawn');
  assert.equal(p.hand.blood, discardTop);
  assert.equal(g.discards.blood.at(-1), old);
  assert.notEqual(g.currentPlayerId(), cur);
});

test('3턴 후 공개·정산, 승자는 베팅 회수, 패자는 베팅 손실 + 벌금', () => {
  const g = newGame(3);
  // 결과를 고정하기 위해 손패를 직접 지정
  const [a, b, c] = g.order.map((id) => g.get(id));
  a.hand = hand(num('sand', 2), num('blood', 2)); // 사박 2/2
  b.hand = hand(num('sand', 1), num('blood', 4)); // 차이 3
  c.hand = hand(num('sand', 3), num('blood', 3)); // 사박 3/3
  for (let t = 0; t < R.TURNS_PER_ROUND; t++) {
    for (const p of [a, b, c]) {
      if (t === 0) {
        g.draw(p.id, { suit: 'sand', from: 'deck' });
        g.keep(p.id, 'hand');
      } else {
        g.stand(p.id);
      }
    }
  }
  assert.equal(g.phase, 'roundEnd');
  const start = R.DEFAULT_START_CHIPS;
  assert.equal(a.chips, start); // 1칩 썼지만 회수
  assert.equal(b.chips, start - 1 - 3);
  assert.equal(c.chips, start - 1 - 1);
  assert.ok(g.lastResult.rows.find((r) => r.id === a.id).winner);
});

test('동점이면 모두 승자', () => {
  const g = newGame(3);
  const [a, b, c] = g.order.map((id) => g.get(id));
  a.hand = hand(num('sand', 1), num('blood', 1));
  b.hand = hand(num('sand', 1), num('blood', 1));
  c.hand = hand(num('sand', 1), num('blood', 6));
  for (let t = 0; t < R.TURNS_PER_ROUND; t++) for (const p of [a, b, c]) g.stand(p.id);
  const winners = g.lastResult.rows.filter((r) => r.winner).map((r) => r.id);
  assert.deepEqual(winners.sort(), [a.id, b.id].sort());
  assert.equal(c.chips, R.DEFAULT_START_CHIPS - 5);
});

test('임포스터: 공개 시 주사위 선택을 기다린 뒤 정산', () => {
  const g = newGame(3);
  const [a, b, c] = g.order.map((id) => g.get(id));
  a.hand = hand(imp('sand'), num('blood', 4));
  b.hand = hand(num('sand', 1), num('blood', 6));
  c.hand = hand(num('sand', 2), num('blood', 6));
  g.rng = (() => { const seq = [0.0, 0.6]; let i = 0; return () => seq[i++ % seq.length]; })(); // 주사위 1, 4
  for (let t = 0; t < R.TURNS_PER_ROUND; t++) for (const p of [a, b, c]) g.stand(p.id);
  assert.equal(g.phase, 'impostor');
  assert.deepEqual(a.impostor.sand.dice, [1, 4]);
  g.chooseImpostor(a.id, 'sand', 1);
  assert.equal(g.phase, 'roundEnd');
  assert.ok(g.lastResult.rows.find((r) => r.id === a.id).winner);
});

test('칩이 0이 되면 탈락, 마지막 1명이 남으면 게임 종료', () => {
  const g = newGame(3, { startChips: 2 });
  const [a, b, c] = g.order.map((id) => g.get(id));
  a.hand = hand(syl('sand'), syl('blood'));
  b.hand = hand(num('sand', 1), num('blood', 6));
  c.hand = hand(num('sand', 1), num('blood', 5));
  for (let t = 0; t < R.TURNS_PER_ROUND; t++) for (const p of [a, b, c]) g.stand(p.id);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winnerId, a.id);
  assert.ok(b.eliminated && c.eliminated);
});

test('탈락자는 다음 라운드에서 제외되고 딜러가 순환', () => {
  const g = newGame(4, { startChips: 3 });
  const ids = [...g.order];
  const [a, b, c, d] = ids.map((id) => g.get(id));
  a.hand = hand(num('sand', 1), num('blood', 1));
  b.hand = hand(num('sand', 2), num('blood', 2));
  c.hand = hand(num('sand', 1), num('blood', 6)); // 벌금 5 → 탈락
  d.hand = hand(num('sand', 3), num('blood', 3));
  const dealer = g.dealerIdx;
  for (let t = 0; t < R.TURNS_PER_ROUND; t++) for (const p of [a, b, c, d]) g.stand(p.id);
  assert.equal(g.phase, 'roundEnd');
  assert.ok(c.eliminated);
  g.nextRound();
  assert.equal(g.order.length, 3);
  assert.ok(!g.order.includes(c.id));
  assert.notEqual(g.dealerIdx, dealer);
  assert.equal(c.hand, null);
});

test('다른 사람 손패는 공개 전까지 숨김', () => {
  const g = newGame(3);
  const view = g.viewFor('p0');
  for (const p of view.players) {
    if (p.id === 'p0') assert.ok(p.hand);
    else assert.equal(p.hand, null);
  }
});

test('자동 행동: 드로우 중이면 새 카드 버리고 넘김', () => {
  const g = newGame(3);
  const cur = g.currentPlayerId();
  const before = g.get(cur).hand.sand;
  g.draw(cur, { suit: 'sand', from: 'deck' });
  g.autoAct(cur);
  assert.equal(g.get(cur).hand.sand, before);
  assert.notEqual(g.currentPlayerId(), cur);
});

test('칩이 없으면 드로우 불가', () => {
  const g = newGame(3, { startChips: 2 });
  const cur = g.currentPlayerId();
  g.get(cur).chips = 0;
  assert.throws(() => g.draw(cur, { suit: 'sand', from: 'deck' }), GameError);
});
