'use strict';

// Kessel Sabacc 규칙 상수 및 순수 함수 (상태 없음)

const SUITS = ['sand', 'blood'];
const TURNS_PER_ROUND = 3;
const DRAW_COST = 1;
const SABACC_LOSS_PENALTY = 1;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const DEFAULT_START_CHIPS = 8;

// 한 벌(22장): 1~6 각 3장, 임포스터 3장, 사일롭 1장
function buildDeck(suit) {
  const cards = [];
  let n = 0;
  for (let v = 1; v <= 6; v++) {
    for (let i = 0; i < 3; i++) cards.push({ id: `${suit}-${n++}`, suit, kind: 'number', value: v });
  }
  for (let i = 0; i < 3; i++) cards.push({ id: `${suit}-${n++}`, suit, kind: 'impostor', value: null });
  cards.push({ id: `${suit}-${n++}`, suit, kind: 'sylop', value: 0 });
  return cards;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 임포스터 값(impostorValues: { sand, blood })을 반영해 최종 핸드 평가
// rank 배열은 사전식 비교, 낮을수록 강함
function evaluateHand(hand, impostorValues = {}) {
  const resolve = (card) => (card.kind === 'impostor' ? impostorValues[card.suit] : card.value);
  const { sand, blood } = hand;

  if (sand.kind === 'sylop' && blood.kind === 'sylop') {
    return { type: 'pure', sand: 0, blood: 0, diff: 0, rank: [0, 0, 0], label: '퓨어 사박' };
  }

  let s = resolve(sand);
  let b = resolve(blood);
  if (s == null || b == null) throw new Error('Impostor value not chosen');
  // 사일롭은 다른 카드의 값을 따름
  if (sand.kind === 'sylop') s = b;
  if (blood.kind === 'sylop') b = s;

  if (s === b) {
    const label = s === 1 ? '프라임 사박 (1/1)' : `사박 (${s}/${s})`;
    return { type: 'sabacc', sand: s, blood: b, diff: 0, rank: [1, s, 0], label };
  }
  const diff = Math.abs(s - b);
  return { type: 'none', sand: s, blood: b, diff, rank: [2, diff, s + b], label: `차이 ${diff} (${s}/${b})` };
}

function compareRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

// 패배 시 벌금: 사박이면 1칩, 아니면 두 카드 차이만큼
function penaltyFor(evaluation) {
  return evaluation.type === 'none' ? evaluation.diff : SABACC_LOSS_PENALTY;
}

module.exports = {
  SUITS,
  TURNS_PER_ROUND,
  DRAW_COST,
  SABACC_LOSS_PENALTY,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_START_CHIPS,
  buildDeck,
  shuffle,
  evaluateHand,
  compareRank,
  penaltyFor,
};
