'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Game, GameError } = require('./src/game');
const R = require('./src/rules');

const PORT = Number(process.env.PORT) || 3000;
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 60;
const DISCONNECTED_TURN_SECONDS = 10;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- 정적 파일 ----------
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// 같은 Wi-Fi(공유기)에 연결된 친구가 접속할 주소
function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${PORT}`);
}

// ---------- 방 관리 ----------
// room: { code, hostId, game, sockets: Map<playerId, ws>, tokens: Map<token, playerId>, timer, deadline }
const rooms = new Map();

function newRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(startCredits) {
  const code = newRoomCode();
  const room = {
    code, hostId: null, game: new Game({ startCredits }),
    sockets: new Map(), tokens: new Map(), timer: null, deadline: null, lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function broadcast(room) {
  room.lastActive = Date.now();
  scheduleTimer(room);
  for (const [pid, ws] of room.sockets) {
    send(ws, {
      type: 'state',
      room: room.code,
      you: pid,
      hostId: room.hostId,
      connected: [...room.sockets.keys()],
      deadline: room.deadline,
      minPlayers: R.MIN_PLAYERS,
      maxPlayers: R.MAX_PLAYERS,
      lanUrls: lanUrls(),
      game: room.game.viewFor(pid),
    });
  }
}

// 제한시간·연결 끊김 처리: 시간 초과 시 자동 행동
function scheduleTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
  const g = room.game;
  let waitingIds = [];
  const cur = g.currentPlayerId();
  if (cur) waitingIds = [cur];
  if (!waitingIds.length) return;
  const allOffline = waitingIds.every((id) => !room.sockets.has(id));
  const secs = allOffline ? DISCONNECTED_TURN_SECONDS : TURN_SECONDS;
  room.deadline = Date.now() + secs * 1000;
  room.timer = setTimeout(() => {
    for (const id of waitingIds) {
      try { g.autoAct(id); } catch (e) { /* 이미 처리된 경우 무시 */ }
    }
    broadcast(room);
  }, secs * 1000);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 16);
  if (!n) throw new GameError('이름을 입력하세요.');
  return n;
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null;
  let playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const attach = (r, pid, token) => {
    room = r; playerId = pid;
    const old = r.sockets.get(pid);
    if (old && old !== ws) old.close(4000, 'replaced');
    r.sockets.set(pid, ws);
    send(ws, { type: 'joined', room: r.code, playerId: pid, token });
    broadcast(r);
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.type) {
        case 'create': {
          if (room) throw new GameError('이미 방에 있습니다.');
          const name = cleanName(msg.name);
          const credits = Math.min(500, Math.max(10, Math.floor(Number(msg.startCredits)) || R.DEFAULT_START_CREDITS));
          const r = createRoom(credits);
          const pid = crypto.randomUUID();
          const token = crypto.randomUUID();
          r.game.addPlayer(pid, name);
          r.hostId = pid;
          r.tokens.set(token, pid);
          attach(r, pid, token);
          break;
        }
        case 'join': {
          if (room) throw new GameError('이미 방에 있습니다.');
          const r = rooms.get(String(msg.room || '').toUpperCase().trim());
          if (!r) throw new GameError('존재하지 않는 방 코드입니다.');
          // 재접속
          if (msg.token && r.tokens.has(msg.token)) {
            attach(r, r.tokens.get(msg.token), msg.token);
            break;
          }
          const name = cleanName(msg.name);
          if (r.game.players.some((p) => p.name === name)) throw new GameError('같은 이름의 플레이어가 이미 있습니다.');
          const pid = crypto.randomUUID();
          const token = crypto.randomUUID();
          r.game.addPlayer(pid, name);
          r.tokens.set(token, pid);
          attach(r, pid, token);
          break;
        }
        case 'leave': {
          if (!room) return;
          if (room.game.phase === 'lobby') {
            room.game.removePlayer(playerId);
            for (const [t, id] of room.tokens) if (id === playerId) room.tokens.delete(t);
            if (room.hostId === playerId) room.hostId = room.game.players[0]?.id ?? null;
          }
          room.sockets.delete(playerId);
          const r = room;
          room = null; playerId = null;
          send(ws, { type: 'left' });
          if (!r.game.players.length) { clearTimeout(r.timer); rooms.delete(r.code); } else broadcast(r);
          break;
        }
        case 'start': {
          requireRoom();
          if (room.hostId !== playerId) throw new GameError('방장만 시작할 수 있습니다.');
          room.game.start();
          broadcast(room);
          break;
        }
        case 'draw':
          requireRoom(); room.game.drawAction(playerId, msg.action, msg.cardId); broadcast(room); break;
        case 'bet':
          requireRoom(); room.game.betAction(playerId, msg.action, msg.amount); broadcast(room); break;
        case 'nextHand':
          requireRoom();
          if (room.game.phase !== 'handEnd') return; // 다른 사람이 먼저 누른 경우
          room.game.nextHand(); broadcast(room); break;
        case 'rematch': {
          requireRoom();
          if (room.game.phase !== 'gameOver') throw new GameError('게임이 아직 끝나지 않았습니다.');
          if (room.hostId !== playerId) throw new GameError('방장만 다시 시작할 수 있습니다.');
          const old = room.game;
          room.game = new Game({ startCredits: old.startCredits });
          for (const p of old.players) room.game.addPlayer(p.id, p.name);
          broadcast(room);
          break;
        }
        case 'chat': {
          requireRoom();
          const text = String(msg.text || '').trim().slice(0, 200);
          if (!text) return;
          const name = room.game.get(playerId)?.name ?? '?';
          for (const s of room.sockets.values()) send(s, { type: 'chat', name, text, at: Date.now() });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      if (e instanceof GameError) send(ws, { type: 'error', message: e.message });
      else { console.error(e); send(ws, { type: 'error', message: '서버 오류가 발생했습니다.' }); }
    }
  });

  ws.on('close', () => {
    if (room && room.sockets.get(playerId) === ws) {
      room.sockets.delete(playerId);
      broadcast(room);
    }
  });

  function requireRoom() {
    if (!room) throw new GameError('방에 먼저 참가하세요.');
  }
});

// 끊긴 연결 정리: 30초마다 ping, 응답 없으면 종료 (호스팅 프록시의 유휴 연결 끊김 방지)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000).unref();

// 오래 비어 있는 방 정리 (30분)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.sockets.size === 0 && now - r.lastActive > 30 * 60 * 1000) {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    const lan = lanUrls();
    console.log('');
    console.log('  사박 서버가 켜졌습니다.');
    console.log(`  내 컴퓨터에서 접속:   http://localhost:${PORT}`);
    for (const url of lan) console.log(`  같은 Wi-Fi 친구 접속: ${url}`);
    console.log('  종료하려면 이 창에서 Ctrl+C');
    console.log('');
  });
}

module.exports = { server, rooms };
