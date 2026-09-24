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
  while (g.phase === 'betting') g.betAction(g.currentPlayerId(), 'stand');
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

test('룰북 족보 페이지의 카드 예시', () => {
  assert.equal(key(0, 0), 'pure');
  assert.equal(key(10, 10, 0, -10, -10), 'full');
  assert.equal(key(-4, -4, 0, 4, 4), 'fleet');
  assert.equal(key(-2, 0, 2), 'yeehaa');
  assert.equal(key(2, 2, 2, -3, -3), 'rhylet');
  assert.equal(key(-5, -5, 5, 5), 'squadron');
  assert.equal(key(1, 2, 3, 4, -10), 'geewhiz');
  assert.equal(key(-5, 6, 7, -8), 'khyron');
  assert.equal(key(4, 4, 4, -3, -9), 'bantha');
  assert.equal(key(3, 3, -5, 5, -6), 'ruleOfTwo');
  assert.equal(key(3, 3, -6), 'sabacc');
  const ev = (...v) => R.evaluateHand(H(...v)).rank;
  assert.ok(R.compareRank(ev(2, 8, -3, -7), ev(1, 6, -2, -5)) < 0, '양수 합이 큰 사박');
  assert.ok(R.compareRank(ev(3, -2), ev(2, -3)) < 0, '양수 널렉');
  assert.ok(R.compareRank(ev(2, -1), ev(4, -1)) < 0, '0에 가까운 널렉');
  assert.ok(R.compareRank(ev(1), ev(-1)) < 0, '싱글 블라인드 드로우: +1 > -1');
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

test('룰북 승패: 절댓값 같으면 카드 수 많은 쪽, 그다음 양수가 음수보다 우선', () => {
  const ev = (...v) => R.evaluateHand(H(...v)).rank;
  assert.ok(R.compareRank(ev(1, 2, -4), ev(3, -2)) < 0, '−1(3장) > +1(2장)');
  assert.ok(R.compareRank(ev(3, -2), ev(2, -3)) < 0, '+1 > −1 (같은 장수)');
});

test('딜러는 매 라운드 끝나면 왼쪽으로 넘어가고, 모든 단계는 딜러 왼쪽부터', () => {
  const g = newGame(4);
  const r = noShift(g);
  const ids = g.players.map((p) => p.id);
  for (let round = 1; round <= 3; round++) {
    const dealer = g.dealerIdx;
    assert.equal(g.round, round);
    assert.equal(g.currentPlayerId(), ids[(dealer + 1) % 4], '드로우는 딜러 왼쪽부터');
    allStand(g);
    assert.equal(g.currentPlayerId(), ids[(dealer + 1) % 4], '베팅도 딜러 왼쪽부터');
    allCheck(g);
    assert.equal(g.dealerIdx, (dealer + 1) % 4, '라운드 후 딜러 이동');
  }
  r();
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
  assert.ok(g.faceUp);
  assert.equal(g.discard.length, 0);
  assert.equal(g.deck.length, 62 - 8 - 1);
  assert.equal(g.phase, 'draw');
});

test('드로우: Buy Draw 1크레딧·Buy Face-Up 2크레딧(장수 +1), SWAP은 먼저 버리고 교환(무료)', () => {
  const g = newGame(3);
  let id = g.currentPlayerId();
  let p = g.get(id);
  let before = p.credits;
  g.drawAction(id, 'buyDraw');
  assert.equal(p.hand.length, 3);
  assert.equal(p.credits, before - 1);

  id = g.currentPlayerId(); p = g.get(id); before = p.credits;
  const up = g.faceUp;
  g.drawAction(id, 'buyFaceUp');
  assert.equal(p.credits, before - 2);
  assert.ok(p.hand.includes(up));
  assert.ok(g.faceUp && g.faceUp !== up, '공개 카드는 드로우 더미에서 다시 채워짐');

  id = g.currentPlayerId(); p = g.get(id); before = p.credits;
  const up2 = g.faceUp;
  const out = p.hand[0];
  assert.throws(() => g.drawAction(id, 'swapFaceUp'), GameError);
  g.drawAction(id, 'swapFaceUp', out.id);
  assert.equal(p.hand.length, 2);
  assert.equal(p.credits, before);
  assert.ok(p.hand.includes(up2));
  assert.equal(g.discard.at(-1), out);
  assert.notEqual(g.faceUp, out, '버린 카드는 공개 카드가 아닌 버린 카드 더미로');
  assert.equal(g.phase, 'betting');
});

test('SWAP Draw: 먼저 버린 카드 자리에 드로우 더미 맨 위 카드', () => {
  const g = newGame(3);
  const id = g.currentPlayerId();
  const p = g.get(id);
  const out = p.hand[1];
  const top = g.deck.at(-1);
  g.drawAction(id, 'swapDraw', out.id);
  assert.equal(p.hand[1], top);
  assert.equal(g.discard.at(-1), out);
});

test('손패 최대 장수 초과 불가', () => {
  const g = newGame(3);
  const id = g.currentPlayerId();
  g.get(id).hand = H(1, 2, 3, 4, 5);
  assert.throws(() => g.drawAction(id, 'buyDraw'), GameError);
});

test('베팅: 레이즈는 2 이상, 레이즈가 있으면 스탠드 불가, 레이즈 후 다시 한 바퀴', () => {
  const g = newGame(3);
  allStand(g);
  const [a, b, c2] = g.betting.queue.map((id) => g.get(id));
  const pot = g.pots.hand;
  assert.throws(() => g.betAction(a.id, 'raise', 1), GameError);
  g.betAction(a.id, 'raise', 3);
  assert.throws(() => g.betAction(b.id, 'stand'), GameError);
  assert.throws(() => g.betAction(b.id, 'raise', 4), GameError);
  g.betAction(b.id, 'raise', 5);
  g.betAction(c2.id, 'call');
  assert.equal(g.currentPlayerId(), a.id);
  g.betAction(a.id, 'call');
  assert.equal(g.pots.hand, pot + 15);
  assert.equal(g.phase, 'draw');
  assert.equal(g.round, 2);
});

test('올인: 가진 만큼만 콜, 이후 베팅 차례에서 제외', () => {
  const g = newGame(3);
  allStand(g);
  const [a, b, c2] = g.betting.queue.map((id) => g.get(id));
  b.credits = 4;
  g.betAction(a.id, 'raise', 10);
  g.betAction(b.id, 'call');
  assert.equal(b.credits, 0);
  assert.equal(b.roundBet, 4);
  g.betAction(c2.id, 'call');
  assert.equal(g.phase, 'draw');
  allStand(g);
  assert.ok(!g.betting.queue.includes(b.id));
});

test('사이드 팟: 올인한 사람은 자기가 낸 만큼까지만 가져감', () => {
  const g = newGame(3, { startCredits: 50 });
  const r = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  a.hand = H(0, 0); // 최강
  b.hand = H(3, -2);
  c2.hand = H(9, -1);
  allStand(g);
  a.credits = 5;
  g.betAction(a.id, 'raise', 5); // 올인
  g.betAction(b.id, 'raise', 20);
  g.betAction(c2.id, 'call');
  // 베팅: a 5(올인), b·c 20. 메인 팟 = 참가비 6 + 5×3, 사이드 팟 = 15×2
  for (let i = 0; i < 2; i++) { allStand(g); allCheck(g); }
  r();
  const res = g.lastResult;
  assert.equal(res.pots[0].amount, 6 + 15);
  assert.deepEqual(res.pots[0].winners, [a.name]);
  assert.equal(res.pots[1].amount, 30);
  assert.deepEqual(res.pots[1].winners, [b.name]);
  assert.equal(res.rows.find((x) => x.id === a.id).won, 21 + res.sabaccPot);
});

test('드로우 비용은 사이드 팟을 만들지 않고 메인 팟에 포함', () => {
  const g = newGame(3);
  const r = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  g.drawAction(a.id, 'buyDraw');
  g.drawAction(b.id, 'buyFaceUp');
  g.drawAction(c2.id, 'stand');
  a.hand = H(5, -2); b.hand = H(6, -1); c2.hand = H(2, -2);
  allCheck(g);
  for (let i = 0; i < 2; i++) { allStand(g); allCheck(g); }
  r();
  const res = g.lastResult;
  assert.equal(res.pots.length, 1);
  assert.equal(res.pots[0].amount, 6 + 1 + 2);
  assert.deepEqual(res.pots[0].winners, [c2.name]);
});

test('싱글 블라인드 드로우: 동률이면 한 장씩 뽑아 그 카드로 비교', () => {
  const g = newGame(3);
  const r = noShift(g);
  const [a, b, c2] = g.order.map((id) => g.get(id));
  a.hand = H(4, -4); b.hand = H(4, -4); c2.hand = H(9, -1);
  for (let i = 0; i < 3; i++) { allStand(g); allCheck(g); }
  r();
  const res = g.lastResult;
  assert.ok(res.blind.length >= 2);
  assert.ok(res.blind.every((x) => x.id !== c2.id));
  assert.equal(res.rows.filter((x) => x.winner).length, 1, '서로 다른 값이 나올 때까지 뽑아 승자 1명');
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

test('자동 행동: 드로우=스탠드, 베팅 중 레이즈가 있으면 폴드', () => {
  const g = newGame(3);
  const id = g.currentPlayerId();
  g.autoAct(id);
  assert.notEqual(g.currentPlayerId(), id);
  allStand(g);
  const [a, b] = g.betting.queue;
  g.betAction(a, 'raise', 2);
  g.autoAct(b);
  assert.ok(g.get(b).folded);
});
