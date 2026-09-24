'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules');
const { Game, GameError } = require('../src/game');

let uid = 0;
const c = (v) => (v === 0
  ? { id: `s${uid++}`, stave: null, value: 0, sylop: true }
  : { id: `c${uid++}`, stave: 'circle', value: v, sylop: false });
const H = (...vals) => vals.map(c);
const key = (...vals) => R.evaluateHand(H(...vals)).key;

function seeded(seed = 1) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

function newGame(n = 3, opts = {}) {
  const g = new Game({ rng: seeded(7), ...opts });
  for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`);
  g.start();
  return g;
}

// 드로우 페이즈 전원 스탠드
function allStand(g) {
  while (g.phase === 'draw') g.drawAction(g.currentPlayerId(), 'stand');
}
// 베팅 페이즈 전원 체크
function allCheck(g) {
  while (g.phase === 'betting') g.betAction(g.currentPlayerId(), 'check');
}
// 주사위를 항상 다른 문양으로 (시프트 없음)
function noShift(g) {
  let i = 0;
  const base = g.rng;
  g.rng = () => { i += 1; return i % 2 ? 0.01 : 0.5; };
  return () => { g.rng = base; };
}

test('덱 구성: 62장 = 3 스테이브 × (+1~+10, −1~−10) + 사일롭 2장', () => {
  const d = R.buildDeck();
  assert.equal(d.length, 62);
  for (const s of R.STAVES) {
    assert.equal(d.filter((x) => x.stave === s && x.value > 0).length, 10);
    assert.equal(d.filter((x) => x.stave === s && x.value < 0).length, 10);
  }
  assert.equal(d.filter((x) => x.sylop).length, 2);
  assert.equal(R.sumOf(d), 0);
  assert.equal(new Set(d.map((x) => x.id)).size, 62);
});

test('족보 판정: 각 족보 예시', () => {
  assert.equal(key(0, 0), 'pure');
  assert.equal(key(10, 10, 0, -10, -10), 'full');
  assert.equal(key(-5, -5, 5, 5, 0), 'fleet');
  assert.equal(key(4, -4, 0), 'yeehaa');
  assert.equal(key(2, 2, -4, 0), 'yeehaa');
  assert.equal(key(2, 2, 2, -3, -3), 'rhylet');
  assert.equal(key(-6, -6, 6, 6), 'squadron');
  assert.equal(key(10, -1, -2, -3, -4), 'geewhiz');
  assert.equal(key(-10, 1, 2, 3, 4), 'geewhiz');
  assert.equal(key(1, 4, -2, -3), 'khyron');
  assert.equal(key(3, 3, 3, -9), 'bantha');
  assert.equal(key(2, 2, -5, -5, 6), 'ruleOfTwo');
  assert.equal(key(7, -7), 'sabacc');
  assert.equal(key(5, -2), 'nulrhek');
});

test('족보 순서: 퓨어 > 풀 > 플릿 > 이-하 > 라일렛 > 스쿼드런 > 지 위즈 > 카이론 > 밴서스 > 룰 오브 투 > 사박 > 널렉', () => {
  const hands = [
    H(0, 0), H(10, 10, 0, -10, -10), H(-5, -5, 5, 5, 0), H(4, -4, 0), H(2, 2, 2, -3, -3),
    H(-6, -6, 6, 6), H(10, -1, -2, -3, -4), H(1, 4, -2, -3), H(3, 3, 3, -9), H(2, 2, -5, -5, 6),
    H(7, -7), H(1, -2),
  ].map((h) => R.evaluateHand(h));
  for (let i = 0; i < hands.length - 1; i++) {
    assert.ok(R.compareRank(hands[i].rank, hands[i + 1].rank) < 0, `${hands[i].key} > ${hands[i + 1].key}`);
  }
});

test('사박 동률: 카드 수 많은 쪽 → 양수 합 큰 쪽 → 가장 높은 양수 카드', () => {
  const ev = (...v) => R.evaluateHand(H(...v)).rank;
  assert.ok(R.compareRank(ev(5, -2, -3), ev(5, -5)) < 0);
  assert.ok(R.compareRank(ev(9, -9), ev(4, -4)) < 0);
  assert.ok(R.compareRank(ev(9, 1, -5, -5), ev(6, 4, -9, -1)) < 0);
});

test('널렉: 0에 가까울수록, 같으면 양수가 음수보다 우선', () => {
  const ev = (...v) => R.evaluateHand(H(...v)).rank;
  assert.ok(R.compareRank(ev(1, -2), ev(5, -3)) < 0); // -1 vs +2
  assert.ok(R.compareRank(ev(3, -2), ev(2, -3)) < 0); // +1 vs -1
  assert.ok(R.compareRank(ev(7, -3, -3), ev(3, -2)) < 0); // +1, 3장 vs 2장
});

test('3~6명 제한', () => {
  const g = new Game();
  g.addPlayer('a', 'A'); g.addPlayer('b', 'B');
  assert.throws(() => g.start(), GameError);
  for (let i = 0; i < 4; i++) g.addPlayer(`x${i}`, `X${i}`);
  assert.throws(() => g.addPlayer('y', 'Y'), GameError);
});

test('핸드 시작: 참가비(핸드 팟 2 + 사박 팟 1), 각자 2장, 공개 카드 1장', () => {
  const g = newGame(4, { startCredits: 50 });
  assert.equal(g.pots.hand, 8);
  assert.equal(g.pots.sabacc, 4);
  for (const p of g.players) {
    assert.equal(p.hand.length, 2);
    assert.equal(p.credits, 47);
  }
  assert.equal(g.discard.length, 1);
  assert.equal(g.deck.length, 62 - 8 - 1);
  assert.equal(g.phase, 'draw');
});

test('드로우 4종: Buy Draw/Face-Up은 장수 +1·비용, SWAP은 장수 유지', () => {
  const g = newGame(3);
  let id = g.currentPlayerId();
  let p = g.get(id);
  const before = p.credits;
  g.drawAction(id, 'buyDraw');
  assert.equal(p.hand.length, 3);
  assert.equal(p.credits, before - R.DRAW_COSTS.buyDraw);

  id = g.currentPlayerId(); p = g.get(id);
  const top = g.discard.at(-1);
  const out = p.hand[0];
  g.drawAction(id, 'swapFaceUp', out.id);
  assert.equal(p.hand.length, 2);
  assert.ok(p.hand.includes(top));
  assert.equal(g.discard.at(-1), out);

  id = g.currentPlayerId(); p = g.get(id);
  g.drawAction(id, 'swapDraw');
  assert.ok(p.pending);
  assert.throws(() => g.drawAction(id, 'stand'), GameError);
  const drawn = p.pending;
  g.discardPending(id, p.hand[1].id);
  assert.equal(p.hand.length, 2);
  assert.ok(p.hand.includes(drawn));
  assert.equal(g.phase, 'betting');
});

test('손패 최대 장수 초과 불가', () => {
  const g = newGame(3);
  const id = g.currentPlayerId();
  g.get(id).hand = H(1, 2, 3, 4, 5);
  assert.throws(() => g.drawAction(id, 'buyDraw'), GameError);
});

test('베팅: 체크 불가 시 콜/레이즈/폴드, 레이즈 후 다시 한 바퀴', () => {
  const g = newGame(3);
  allStand(g);
  const [a, b, c2] = g.betting.queue.map((id) => g.get(id));
  const pot = g.pots.hand;
  g.betAction(a.id, 'bet', 3);
  assert.throws(() => g.betAction(b.id, 'check'), GameError);
  g.betAction(b.id, 'raise', 5);
  g.betAction(c2.id, 'call');
  assert.equal(g.currentPlayerId(), a.id);
  g.betAction(a.id, 'call');
  assert.equal(g.pots.hand, pot + 15);
  assert.equal(g.phase, 'draw');
  assert.equal(g.round, 2);
});

test('베팅 한도 = 남은 플레이어 최소 보유 크레딧', () => {
  const g = newGame(3);
  allStand(g);
  const cap = g.betting.cap;
  const id = g.currentPlayerId();
  assert.throws(() => g.betAction(id, 'bet', cap + 1), GameError);
});

test('나머지 전원 폴드 시 핸드 팟만 획득, 사박 팟은 이월', () => {
  const g = newGame(3);
  allStand(g);
  const [a, b, c2] = g.betting.queue.map((id) => g.get(id));
  const handPot = g.pots.hand; const sab = g.pots.sabacc;
  const before = c2.credits;
  g.betAction(a.id, 'fold');
  g.betAction(b.id, 'fold');
  assert.equal(g.phase, 'handEnd');
  assert.equal(c2.credits, before + handPot);
  assert.equal(g.pots.sabacc, sab);
});

test('스파이크: 같은 문양이면 사박 시프트(장수 유지하며 새 카드)', () => {
  const g = newGame(3);
  allStand(g);
  const hands = g.inHand().map((p) => p.hand.map((x) => x.id).join());
  g.rng = () => 0.01; // 두 주사위 모두 첫 번째 문양
  allCheck(g);
  assert.equal(g.lastDice.shift, true);
  g.inHand().forEach((p, i) => {
    assert.equal(p.hand.length, 2);
    assert.notEqual(p.hand.map((x) => x.id).join(), hands[i]);
  });
});

test('3라운드 후 쇼다운: 합계 0 승자는 핸드 팟 + 사박 팟', () => {
  const g = newGame(3);
  const restore = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  for (let r = 0; r < 3; r++) { allStand(g); allCheck(g); }
  assert.equal(g.phase, 'handEnd');
  restore();

  // 결과를 고정한 핸드로 한 번 더
  g.nextHand();
  const r2 = noShift(g);
  a.hand = H(3, -3); b.hand = H(5, -2); c2.hand = H(9, -1);
  for (let r = 0; r < 3; r++) { allStand(g); allCheck(g); }
  r2();
  const res = g.lastResult;
  const wa = res.rows.find((x) => x.id === a.id);
  assert.ok(wa.winner);
  assert.equal(res.sabaccPot > 0, true);
  assert.equal(g.pots.sabacc, 0);
  assert.equal(wa.won, res.handPot + res.sabaccPot);
});

test('0이 아닌 승자는 핸드 팟만, 사박 팟은 이월', () => {
  const g = newGame(3);
  const r = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  a.hand = H(3, -2); b.hand = H(5, -2); c2.hand = H(9, -1);
  const sab = g.pots.sabacc;
  for (let i = 0; i < 3; i++) { allStand(g); allCheck(g); }
  r();
  assert.ok(g.lastResult.rows.find((x) => x.id === a.id).winner);
  assert.equal(g.pots.sabacc, sab);
});

test('참가비를 낼 수 없으면 탈락, 1명 남으면 게임 종료', () => {
  const g = newGame(3, { startCredits: 10 });
  const r = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  a.hand = H(0, 0); b.hand = H(5, -2); c2.hand = H(9, -1);
  b.credits = 0; c2.credits = 2;
  for (let i = 0; i < 3; i++) { allStand(g); allCheck(g); }
  r();
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winnerId, a.id);
});

test('다른 사람 손패는 숨김(장수만 공개)', () => {
  const g = newGame(3);
  const view = g.viewFor('p0');
  for (const p of view.players) {
    if (p.id === 'p0') assert.ok(p.hand);
    else { assert.equal(p.hand, null); assert.equal(p.cardCount, 2); }
  }
});

test('자동 행동: 드로우=스탠드, 베팅 중 콜 필요하면 폴드', () => {
  const g = newGame(3);
  const id = g.currentPlayerId();
  g.autoAct(id);
  assert.notEqual(g.currentPlayerId(), id);
  allStand(g);
  const [a, b] = g.betting.queue;
  g.betAction(a, 'bet', 1);
  g.autoAct(b);
  assert.ok(g.get(b).folded);
});
