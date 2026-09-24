'use strict';

// Corellian Spike 사박 규칙 상수 및 순수 함수 (상태 없음)
// ※ 표시된 [가정] 값은 룰북 원문 확인 후 조정 대상

const STAVES = ['circle', 'square', 'triangle'];
const ROUNDS_PER_HAND = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const START_HAND_SIZE = 2;
const MAX_HAND_SIZE = 5; // [가정] 5장 족보(풀 사박·플릿·라이렛·지 위즈)까지만 허용
const ANTE_HAND_POT = 2; // 핸드 팟 참가비
const ANTE_SABACC_POT = 1; // 사박 팟 참가비
const DEFAULT_START_CREDITS = 50; // [가정]

// 드로우 페이즈 행동별 비용(핸드 팟으로) — 룰북 기준
const DRAW_COSTS = {
  buyDraw: 1, // 드로우 더미 맨 위 카드를 손패에 추가
  buyFaceUp: 2, // 공개 카드를 손패에 추가
  swapDraw: 0, // 손패 1장을 먼저 버리고 드로우 더미 맨 위 카드와 교환
  swapFaceUp: 0, // 손패 1장을 먼저 버리고 공개 카드와 교환
  stand: 0,
};
const MIN_RAISE = 2; // 레이즈는 2크레딧 이상

// 스파이크 주사위 6면 (같은 문양 = 사박 시프트)
const DICE_FACES = ['circle', 'square', 'triangle', 'diamond', 'star', 'sylop'];

// 62장: 3개 스테이브 × (+1~+10, −1~−10) + 사일롭 2장
function buildDeck() {
  const cards = [];
  for (const stave of STAVES) {
    for (let v = 1; v <= 10; v++) {
      cards.push({ id: `${stave}+${v}`, stave, value: v, sylop: false });
      cards.push({ id: `${stave}-${v}`, stave, value: -v, sylop: false });
    }
  }
  cards.push({ id: 'sylop-1', stave: null, value: 0, sylop: true });
  cards.push({ id: 'sylop-2', stave: null, value: 0, sylop: true });
  return cards;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 족보 (강한 순). 1~11번은 합계 0(사박)일 때만 성립
const HANDS = [
  { key: 'pure', name: '퓨어 사박', en: 'Pure Sabacc' },
  { key: 'full', name: '풀 사박', en: 'Full Sabacc' },
  { key: 'fleet', name: '플릿', en: 'Fleet' },
  { key: 'yeehaa', name: '이-하', en: 'Yee-Haa' },
  { key: 'rhylet', name: '라일렛', en: 'Rhylet' },
  { key: 'squadron', name: '스쿼드런', en: 'Squadron' },
  { key: 'geewhiz', name: '지 위즈', en: 'Gee Whiz' },
  { key: 'khyron', name: '스트레이트 카이론', en: 'Straight Khyron' },
  { key: 'bantha', name: '밴서스 와일드', en: "Bantha's Wild" },
  { key: 'ruleOfTwo', name: '룰 오브 투', en: 'Rule of Two' },
  { key: 'sabacc', name: '사박', en: 'Sabacc' },
  { key: 'nulrhek', name: '널렉', en: 'Nulrhek' },
];
const HAND_INDEX = Object.fromEntries(HANDS.map((h, i) => [h.key, i]));

function sumOf(cards) {
  return cards.reduce((a, c) => a + c.value, 0);
}

function classify(cards) {
  const n = cards.length;
  const sylops = cards.filter((c) => c.sylop).length;
  const nums = cards.filter((c) => !c.sylop);
  const total = sumOf(cards);
  if (total !== 0) return 'nulrhek';
  if (n === 2 && sylops === 2) return 'pure';

  const counts = new Map();
  for (const c of nums) counts.set(Math.abs(c.value), (counts.get(Math.abs(c.value)) || 0) + 1);
  const kinds = [...counts.values()].sort((a, b) => b - a);
  const pairs = kinds.filter((k) => k >= 2).length;
  const four = kinds[0] >= 4;
  const three = kinds[0] >= 3;

  const vals = nums.map((c) => c.value).sort((a, b) => a - b);
  if (n === 5 && sylops === 1 && vals.join() === '-10,-10,10,10') return 'full';
  if (n === 5 && sylops === 1 && four) return 'fleet';
  if (sylops >= 1 && pairs >= 1) return 'yeehaa';
  if (three && kinds.length >= 2 && kinds[1] >= 2) return 'rhylet';
  if (four) return 'squadron';
  if (n === 5 && sylops === 0 && isGeeWhiz(vals)) return 'geewhiz';
  if (hasRunOfFour([...counts.keys()])) return 'khyron';
  if (three) return 'bantha';
  if (pairs >= 2) return 'ruleOfTwo';
  return 'sabacc';
}

function isGeeWhiz(sorted) {
  return sorted.join() === '-10,1,2,3,4' || sorted.join() === '-4,-3,-2,-1,10';
}

function hasRunOfFour(absValues) {
  const set = new Set(absValues);
  for (const v of set) if (set.has(v + 1) && set.has(v + 2) && set.has(v + 3)) return true;
  return false;
}

// rank 배열은 사전식 비교, 낮을수록 강함
// 동률 판정: 카드 수 많은 쪽 → 양수 카드 합 높은 쪽 → 가장 높은 양수 카드
// 널렉은 0에 가까운 쪽 → 카드 수 많은 쪽 → 양수 합계가 음수 합계보다 우선 (룰북 '게임 승패')
function evaluateHand(cards) {
  const key = classify(cards);
  const total = sumOf(cards);
  const pos = cards.filter((c) => c.value > 0);
  const posSum = sumOf(pos);
  const maxPos = pos.length ? Math.max(...pos.map((c) => c.value)) : 0;
  const tail = [-cards.length, -posSum, -maxPos];
  const rank = key === 'nulrhek'
    ? [HAND_INDEX.nulrhek, Math.abs(total), -cards.length, total > 0 ? 0 : 1, -posSum, -maxPos]
    : [HAND_INDEX[key], 0, 0, ...tail];
  const hand = HANDS[HAND_INDEX[key]];
  const label = key === 'nulrhek' ? `${hand.name} (합계 ${total > 0 ? '+' : ''}${total})` : hand.name;
  return { key, name: hand.name, en: hand.en, total, rank, label, zero: total === 0 };
}

function compareRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

module.exports = {
  STAVES,
  ROUNDS_PER_HAND,
  MIN_PLAYERS,
  MAX_PLAYERS,
  START_HAND_SIZE,
  MAX_HAND_SIZE,
  ANTE_HAND_POT,
  ANTE_SABACC_POT,
  DEFAULT_START_CREDITS,
  DRAW_COSTS,
  MIN_RAISE,
  DICE_FACES,
  HANDS,
  buildDeck,
  shuffle,
  evaluateHand,
  compareRank,
  sumOf,
};
