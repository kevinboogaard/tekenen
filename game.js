/* Teken & Raad — multiplayer draw-and-guess via peer-to-peer (PeerJS).
 * The host's browser runs the game; other players connect with the room code.
 * Drawing is sent as small operations (stroke start, points, fill, undo, clear)
 * in an 800x600 coordinate space, so every screen redraws the same picture. */
(() => {
  'use strict';

  const PREFIX = 'tekenraad-nl-room-';
  const CHOOSE_SECONDS = 15;
  const TURN_END_MS = 6000;
  const W = 800, H = 600;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const AVATAR_COLORS = ['#ff9f68', '#7bd389', '#6ec6ff', '#ffd23f', '#d6a2e8', '#ff7b9c', '#9be7d8', '#f7b267', '#a0c4ff', '#cdb4db'];
  const PALETTE = ['#000000', '#4a4a4a', '#9e9e9e', '#ffffff', '#e53935', '#ff7043', '#ffb300', '#fdd835', '#43a047', '#1b5e20',
    '#4fc3f7', '#1e88e5', '#283593', '#8e24aa', '#f06292', '#ffcdd2', '#795548', '#d7a86e', '#ffe0b2', '#26a69a'];
  const SIZES = [4, 10, 20, 36];
  const HINT_AT = [0.45, 0.65, 0.82];
  const MAX_WORDS_PER_PLAYER = 30;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------ utils
  const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const compact = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);
  const cleanWord = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const isLetter = (c) => /[\p{L}\p{N}]/u.test(c);
  function shuffle(a) {
    a = [...a];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  }
  function makeCode() {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }
  function parseWords(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/[,\n;]/)) {
      const w = cleanWord(raw);
      const k = compact(w);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(w);
      if (out.length >= MAX_WORDS_PER_PLAYER) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ sound
  let muted = store.get('tekenraad-muted') === '1';
  let actx = null;
  function initAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { /* no audio */ }
  }
  function tone(freq, dur, type = 'sine', when = 0, vol = 0.14) {
    if (muted || !actx) return;
    const t = actx.currentTime + when;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    guessed() { tone(660, 0.1, 'triangle'); tone(990, 0.16, 'triangle', 0.08); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', i * 0.1)); },
    turn() { tone(880, 0.1); tone(1320, 0.16, 'sine', 0.1); },
    end() { [523, 392].forEach((f, i) => tone(f, 0.25, 'triangle', i * 0.15)); },
    hint() { tone(1100, 0.08, 'sine', 0, 0.06); },
    join() { tone(660, 0.08, 'sine', 0, 0.08); tone(990, 0.1, 'sine', 0.07, 0.08); },
    chat() { tone(1250, 0.04, 'sine', 0, 0.04); },
    tick() { tone(1000, 0.05, 'square', 0, 0.04); },
    start() { [392, 523, 659].forEach((f, i) => tone(f, 0.18, 'triangle', i * 0.09)); },
  };

  // ================================================================== DRAWING LOG
  // Shared by host (authoritative copy) and every client (render copy).
  function applyToLog(log, op) {
    switch (op.k) {
      case 'begin': log.push({ k: 'stroke', id: op.id, c: op.c, s: op.s, p: op.p.slice(0, 2) }); break;
      case 'pts': {
        const st = log.length && log[log.length - 1];
        if (st && st.k === 'stroke' && st.id === op.id) st.p.push(...op.p);
        break;
      }
      case 'fill': log.push({ k: 'fill', id: op.id, x: op.x, y: op.y, c: op.c }); break;
      case 'undo': log.pop(); break;
      case 'clear': log.length = 0; break;
    }
  }
  function validOp(op) {
    if (!op || typeof op !== 'object') return false;
    const num = (n) => typeof n === 'number' && isFinite(n);
    const col = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
    switch (op.k) {
      case 'begin': return col(op.c) && SIZES.includes(op.s) && Array.isArray(op.p) && op.p.length >= 2 && op.p.every(num);
      case 'pts': return Array.isArray(op.p) && op.p.length <= 400 && op.p.every(num);
      case 'fill': return col(op.c) && num(op.x) && num(op.y);
      case 'undo': case 'clear': return true;
    }
    return false;
  }

  // ================================================================== HOST
  const Host = {
    peer: null,
    conns: new Map(),
    lastSeen: new Map(),
    timer: null,
    hintTimer: null,
    turnEndTimer: null,
    chatId: 0,
    log: [],
    used: new Set(),
    startScores: {},
    S: null,

    init(name) {
      this.S = {
        phase: 'lobby',
        players: [],
        settings: { rounds: 2, time: 80, builtin: true },
        round: 0,
        queue: [],
        drawerId: null,
        turnNo: 0,
        choices: [],
        word: '',
        revealed: [],
        hintsGiven: 0,
        guessedIds: [],
        deadline: 0,
        timerTotal: 0,
        chat: [],
        ev: { seq: 0 },
        result: null,
      };
      this.addPlayer('host', name);
      setInterval(() => this.checkAlive(), 4000);
    },

    p(id) { return this.S.players.find((p) => p.id === id); },
    name(id) { const p = this.p(id); return p ? p.name : '?'; },
    online() { return this.S.players.filter((p) => p.on); },
    guessers() { return this.S.players.filter((p) => p.on && p.id !== this.S.drawerId); },
    event(type, extra = {}) { this.S.ev = { seq: this.S.ev.seq + 1, type, ...extra }; },
    say(text, kind = 'sys', from = null, aud = null) {
      this.S.chat.push({ id: ++this.chatId, kind, from, text, aud });
      if (this.S.chat.length > 100) this.S.chat.shift();
    },
    setDeadline(sec, fn) {
      this.clearDeadline();
      this.S.deadline = Date.now() + sec * 1000;
      this.S.timerTotal = sec * 1000;
      this.timer = setTimeout(fn, sec * 1000);
    },
    clearDeadline() {
      clearTimeout(this.timer);
      clearInterval(this.hintTimer);
      this.timer = this.hintTimer = null;
      this.S.deadline = 0;
      this.S.timerTotal = 0;
    },

    // ---- players
    addPlayer(id, rawName) {
      let name = cleanName(rawName) || `Speler ${this.S.players.length + 1}`;
      const base = name;
      let n = 2;
      while (this.S.players.some((p) => p.on && p.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
      this.S.players.push({ id, name, score: 0, on: true, color: AVATAR_COLORS[this.S.players.length % AVATAR_COLORS.length], words: [] });
      this.lastSeen.set(id, Date.now());
      if (id !== 'host') {
        this.say(`${name} doet mee`);
        this.event('join');
        if (this.S.phase !== 'lobby' && this.S.phase !== 'gameOver') this.S.queue.push(id);
      }
    },

    removePlayer(id) {
      const p = this.p(id);
      this.conns.delete(id);
      this.lastSeen.delete(id);
      if (!p || !p.on) return;
      p.on = false;
      this.say(`${p.name} is vertrokken`);
      const S = this.S;
      if (S.phase === 'lobby') S.players = S.players.filter((x) => x.id !== id);
      if (S.phase === 'choosing' || S.phase === 'drawing') {
        if (this.online().length < 2) return this.backToLobby('Te weinig spelers over — terug naar de lobby.');
        if (S.drawerId === id) return this.endTurn('drawerLeft');
        if (S.phase === 'drawing' && this.allGuessed()) return this.endTurn('all');
      }
      this.broadcast();
    },

    checkAlive() {
      const now = Date.now();
      for (const [id, t] of this.lastSeen) if (id !== 'host' && now - t > 16000) this.removePlayer(id);
    },

    // ---- word pot
    customPot() {
      const seen = new Set();
      const out = [];
      for (const p of this.S.players)
        for (const w of p.words) {
          const k = compact(w);
          if (!seen.has(k)) { seen.add(k); out.push({ w, by: p.id }); }
        }
      return out;
    },

    pickWords(drawerId) {
      const fresh = (w) => !this.used.has(compact(w));
      const pot = this.customPot().filter((x) => fresh(x.w));
      const others = shuffle(pot.filter((x) => x.by !== drawerId).map((x) => x.w));
      const own = shuffle(pot.filter((x) => x.by === drawerId).map((x) => x.w));
      const builtin = shuffle((window.BUILTIN_WORDS || []).filter(fresh));
      const useBuiltin = this.S.settings.builtin;
      const out = [];
      const add = (list, max) => { for (const w of list) { if (out.length >= max) break; if (!out.some((o) => compact(o) === compact(w))) out.push(w); } };
      add(others, useBuiltin ? 2 : 3);
      if (useBuiltin) add(builtin, 3);
      add(own, 3); // only when nothing else is left
      if (out.length < 3) {
        // pot is empty: allow words again
        this.used.clear();
        add(shuffle(this.customPot().filter((x) => x.by !== drawerId).map((x) => x.w)), 3);
        add(shuffle(window.BUILTIN_WORDS || []), 3);
      }
      return out;
    },

    // ---- flow
    startGame() {
      const S = this.S;
      if (S.phase !== 'lobby' || this.online().length < 2) return;
      if (!S.settings.builtin && this.customPot().length < 1) return this.toast('host', 'Voeg eerst woorden toe of zet de ingebouwde woorden aan.');
      S.players = S.players.filter((p) => p.on);
      S.players.forEach((p) => (p.score = 0));
      this.used.clear();
      S.round = 1;
      S.queue = S.players.map((p) => p.id);
      this.say(`Het spel begint! ${S.settings.rounds} ronde${S.settings.rounds > 1 ? 's' : ''}.`);
      this.event('start');
      this.nextDrawer();
    },

    nextDrawer() {
      const S = this.S;
      this.clearDeadline();
      if (this.online().length < 2) return this.backToLobby('Te weinig spelers over — terug naar de lobby.');
      for (let guard = 0; guard < 50; guard++) {
        while (S.queue.length) {
          const id = S.queue.shift();
          const p = this.p(id);
          if (p && p.on) return this.beginChoose(id);
        }
        S.round++;
        if (S.round > S.settings.rounds) return this.gameOver();
        S.queue = this.online().map((p) => p.id);
        this.say(`Ronde ${S.round} van ${S.settings.rounds}`);
      }
    },

    beginChoose(id) {
      const S = this.S;
      S.turnNo++;
      Object.assign(S, { phase: 'choosing', drawerId: id, choices: this.pickWords(id), word: '', revealed: [], hintsGiven: 0, guessedIds: [], result: null });
      this.log = [];
      this.startScores = Object.fromEntries(S.players.map((p) => [p.id, p.score]));
      this.event('choose', { to: id });
      this.setDeadline(CHOOSE_SECONDS, () => this.chooseWord(id, Math.floor(Math.random() * S.choices.length)));
      this.broadcast();
    },

    chooseWord(id, i) {
      const S = this.S;
      if (S.phase !== 'choosing' || id !== S.drawerId) return;
      const word = S.choices[i] ?? S.choices[0];
      if (!word) return this.nextDrawer();
      S.word = word;
      this.used.add(compact(word));
      S.phase = 'drawing';
      S.choices = [];
      this.event('drawing', { to: id });
      this.setDeadline(S.settings.time, () => this.endTurn('time'));
      this.hintTimer = setInterval(() => this.maybeHint(), 1000);
      this.broadcast();
    },

    maybeHint() {
      const S = this.S;
      if (S.phase !== 'drawing' || !S.timerTotal) return;
      const letters = [...S.word].map((c, i) => (isLetter(c) ? i : -1)).filter((i) => i >= 0);
      const maxHints = letters.length <= 3 ? 0 : Math.min(HINT_AT.length, Math.floor(letters.length / 3));
      const elapsed = 1 - (S.deadline - Date.now()) / S.timerTotal;
      if (S.hintsGiven < maxHints && elapsed >= HINT_AT[S.hintsGiven]) {
        const hidden = letters.filter((i) => !S.revealed.includes(i));
        if (hidden.length > 1) {
          S.revealed.push(hidden[Math.floor(Math.random() * hidden.length)]);
          S.hintsGiven++;
          this.event('hint');
          this.broadcast();
        }
      }
    },

    allGuessed() {
      const g = this.guessers();
      return g.length > 0 && g.every((p) => this.S.guessedIds.includes(p.id));
    },

    chat(id, rawText) {
      const S = this.S;
      const p = this.p(id);
      if (!p) return;
      const text = String(rawText || '').trim().slice(0, 80);
      if (!text) return;
      const now = Date.now();
      if (p.lastChat && now - p.lastChat < 500) return;
      p.lastChat = now;

      if (S.phase === 'drawing' && S.word) {
        const target = compact(S.word);
        const said = compact(text);
        const isDrawer = id === S.drawerId;
        const hasGuessed = S.guessedIds.includes(id);
        if (isDrawer || hasGuessed) {
          if (target && said.includes(target)) return this.toast(id, 'Niet het woord verklappen! 🤫');
          if (hasGuessed) {
            // only the drawer and others who guessed can read this
            this.say(text, 'secret', p.name, [S.drawerId, ...S.guessedIds]);
            this.event('chat');
            return this.broadcast();
          }
        } else if (said && said === target) {
          const left = Math.max(0, (S.deadline - now) / S.timerTotal);
          const pts = Math.round((100 + 200 * left) / 5) * 5;
          p.score += pts;
          const drawer = this.p(S.drawerId);
          if (drawer) drawer.score += 50;
          S.guessedIds.push(id);
          this.say(`${p.name} heeft het woord geraden! (+${pts})`, 'good');
          this.event('guessed', { by: id });
          if (this.allGuessed()) return this.endTurn('all');
          return this.broadcast();
        } else if (target.length >= 4 && levenshtein(said, target) === 1) {
          this.toast(id, `"${text}" is bijna goed!`);
        }
      }
      this.say(text, 'chat', p.name);
      this.event('chat');
      this.broadcast();
    },

    endTurn(reason) {
      const S = this.S;
      this.clearDeadline();
      const drawer = this.name(S.drawerId);
      const titles = {
        all: 'Iedereen heeft het geraden! 🎉',
        time: S.guessedIds.length ? '⏰ De tijd is om!' : '⏰ Niemand heeft het geraden…',
        drawerLeft: `${drawer} is vertrokken`,
      };
      const gains = S.players
        .filter((p) => p.on)
        .map((p) => ({ name: p.name, d: p.score - (this.startScores[p.id] ?? p.score) }))
        .sort((a, b) => b.d - a.d);
      S.result = { reason, title: titles[reason] || 'Einde beurt', word: S.word, gains };
      S.phase = 'turnEnd';
      if (S.word) this.say(`Het woord was: ${S.word}`);
      this.event('end');
      this.broadcast();
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = setTimeout(() => { if (this.S.phase === 'turnEnd') this.nextDrawer(); }, TURN_END_MS);
    },

    gameOver() {
      this.clearDeadline();
      this.S.phase = 'gameOver';
      this.S.drawerId = null;
      const best = [...this.S.players].sort((a, b) => b.score - a.score)[0];
      if (best) this.say(`${best.name} wint het spel met ${best.score} punten! 🏆`, 'good');
      this.event('gameover');
      this.broadcast();
    },

    backToLobby(msg) {
      this.clearDeadline();
      clearTimeout(this.turnEndTimer);
      const S = this.S;
      S.players = S.players.filter((p) => p.on);
      S.players.forEach((p) => (p.score = 0));
      Object.assign(S, { phase: 'lobby', round: 0, queue: [], drawerId: null, choices: [], word: '', revealed: [], guessedIds: [], result: null });
      this.log = [];
      if (msg) this.say(msg);
      this.broadcast();
    },

    setSettings(s) {
      if (this.S.phase !== 'lobby') return;
      this.S.settings = {
        rounds: Math.min(5, Math.max(1, parseInt(s.rounds, 10) || 2)),
        time: Math.min(180, Math.max(30, parseInt(s.time, 10) || 80)),
        builtin: !!s.builtin,
      };
      this.broadcast();
    },

    handle(id, m) {
      if (!m || typeof m !== 'object') return;
      this.lastSeen.set(id, Date.now());
      if (m.t !== 'join' && !this.p(id)) return;
      const S = this.S;
      switch (m.t) {
        case 'join':
          if (!this.p(id)) {
            this.addPlayer(id, m.name);
            this.broadcast();
            this.send(id, { t: 'sync', turn: S.turnNo, log: this.log });
          }
          break;
        case 'ping': this.send(id, { t: 'pong' }); break;
        case 'words':
          if (Array.isArray(m.list)) {
            this.p(id).words = parseWords(m.list.map(String).join('\n'));
            this.broadcast();
          }
          break;
        case 'pick': this.chooseWord(id, m.i | 0); break;
        case 'draw':
          if (S.phase !== 'drawing' || id !== S.drawerId || !validOp(m.op)) return;
          applyToLog(this.log, m.op);
          for (const p of S.players) if (p.on && p.id !== id) this.send(p.id, { t: 'draw', turn: S.turnNo, op: m.op });
          break;
        case 'chat': this.chat(id, m.text); break;
        case 'start': if (id === 'host') this.startGame(); break;
        case 'settings': if (id === 'host') this.setSettings(m); break;
        case 'again': if (id === 'host') this.backToLobby(); break;
      }
    },

    view(pid) {
      const S = this.S;
      const isDrawer = pid === S.drawerId;
      const guessed = S.guessedIds.includes(pid);
      const showWord = isDrawer || guessed || S.phase === 'turnEnd' || S.phase === 'gameOver';
      const me = this.p(pid);
      return {
        t: 'state',
        me: pid,
        phase: S.phase,
        players: S.players.map((p) => ({
          id: p.id, name: p.name, score: p.score, on: p.on, color: p.color,
          guessed: S.guessedIds.includes(p.id), words: p.words.length,
        })),
        settings: S.settings,
        round: S.round,
        turnNo: S.turnNo,
        drawerId: S.drawerId,
        choices: isDrawer && S.phase === 'choosing' ? S.choices : [],
        word: showWord && S.word ? S.word : null,
        mask: S.word ? [...S.word].map((c, i) => (!isLetter(c) || S.revealed.includes(i) ? c : '_')).join('') : '',
        left: S.deadline ? Math.max(0, S.deadline - Date.now()) : 0,
        total: S.timerTotal,
        chat: S.chat.filter((m) => !m.aud || m.aud.includes(pid)).slice(-60).map(({ aud, ...m }) => m),
        ev: S.ev,
        result: S.result,
        myWords: me ? me.words : [],
        pot: this.customPot().length,
      };
    },
    send(id, msg) {
      if (id === 'host') return Client.receive(msg);
      const c = this.conns.get(id);
      if (c && c.open) { try { c.send(msg); } catch { /* ignore */ } }
    },
    toast(id, text) { this.send(id, { t: 'toast', text }); },
    broadcast() { for (const p of this.S.players) if (p.on) this.send(p.id, this.view(p.id)); },

    open(name, onReady, onError) {
      this.init(name);
      let attempts = 0;
      const tryOpen = () => {
        const code = makeCode();
        const peer = new Peer(PREFIX + code, { debug: 1 });
        peer.on('open', () => { this.peer = peer; onReady(code); });
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && attempts++ < 5) { peer.destroy(); tryOpen(); }
          else if (!this.peer) onError(err);
          else console.warn('peer error', err);
        });
        peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* ignore */ } });
        peer.on('connection', (conn) => {
          conn.on('data', (m) => {
            if (m && m.t === 'join') this.conns.set(conn.peer, conn);
            this.handle(conn.peer, m);
          });
          conn.on('close', () => this.removePlayer(conn.peer));
          conn.on('error', () => this.removePlayer(conn.peer));
        });
      };
      tryOpen();
    },
  };

  // ================================================================== BOARD (canvas)
  const Board = {
    canvas: null,
    ctx: null,
    log: [],
    turn: -1,
    color: '#000000',
    size: SIZES[1],
    tool: 'pen',
    drawing: null, // current stroke id while pointer is down
    pending: [],
    lastX: 0,
    lastY: 0,
    idCounter: 0,

    init() {
      this.canvas = $('#canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.clearCanvas();
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', () => this.up());
      c.addEventListener('pointercancel', () => this.up());
      setInterval(() => this.flush(), 40);
    },

    reset(turn) {
      this.turn = turn;
      this.log = [];
      this.drawing = null;
      this.pending = [];
      this.tool = 'pen'; // every turn starts with the pen, not a leftover fill bucket
      paintToolbar();
      this.clearCanvas();
    },
    clearCanvas() {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, W, H);
    },
    redraw() {
      this.clearCanvas();
      for (const item of this.log) this.paint(item);
    },
    paint(item) {
      if (item.k === 'stroke') this.strokePts(item.c, item.s, item.p, 0);
      else if (item.k === 'fill') floodFill(this.ctx, item.x, item.y, item.c);
    },
    strokePts(c, s, p, from) {
      const ctx = this.ctx;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = s;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (from === 0) {
        // a stroke starts with a dot, so a single tap is visible
        ctx.beginPath();
        ctx.arc(p[0], p[1], s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.length <= 2) return;
      // continue from the last already-drawn point
      const start = from === 0 ? 0 : from - 2;
      ctx.beginPath();
      ctx.moveTo(p[start], p[start + 1]);
      for (let i = start + 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    },

    // apply an operation (from network or local) and render it incrementally
    apply(op) {
      if (op.k === 'pts') {
        const st = this.log.length && this.log[this.log.length - 1];
        if (!st || st.k !== 'stroke' || st.id !== op.id) return;
        const from = st.p.length;
        st.p.push(...op.p);
        this.strokePts(st.c, st.s, st.p, from);
        return;
      }
      applyToLog(this.log, op);
      if (op.k === 'begin' || op.k === 'fill') this.paint(this.log[this.log.length - 1]);
      else this.redraw();
    },

    canDraw() {
      const v = Client.v;
      return v && v.phase === 'drawing' && v.drawerId === v.me;
    },
    pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
    },
    local(op) {
      this.apply(op);
      Client.send({ t: 'draw', op });
    },
    newId() { return Client.me + '-' + ++this.idCounter; },

    down(e) {
      if (!this.canDraw()) return;
      e.preventDefault();
      const [x, y] = this.pos(e);
      if (this.tool === 'fill') return this.local({ k: 'fill', id: this.newId(), x, y, c: this.color });
      this.canvas.setPointerCapture(e.pointerId);
      this.drawing = this.newId();
      this.lastX = x;
      this.lastY = y;
      this.pending = [];
      this.local({ k: 'begin', id: this.drawing, c: this.tool === 'eraser' ? '#ffffff' : this.color, s: this.size, p: [x, y] });
    },
    move(e) {
      if (!this.drawing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = this.pos(ev);
        if (Math.hypot(x - this.lastX, y - this.lastY) < 2) continue;
        this.lastX = x;
        this.lastY = y;
        this.pending.push(x, y);
      }
    },
    up() {
      if (!this.drawing) return;
      this.flush();
      this.drawing = null;
    },
    flush() {
      if (!this.drawing || !this.pending.length) return;
      const p = this.pending;
      this.pending = [];
      for (let i = 0; i < p.length; i += 400) this.local({ k: 'pts', id: this.drawing, p: p.slice(i, i + 400) });
    },
  };

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Scanline flood fill with a tolerance so anti-aliased edges are covered.
  function floodFill(ctx, x0, y0, hex) {
    x0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
    y0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const [fr, fg, fb] = hexToRgb(hex);
    const i0 = (y0 * W + x0) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6) return;
    const TOL = 110;
    const seen = new Uint8Array(W * H);
    const match = (i) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= TOL;
    const stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      while (x >= 0 && !seen[y * W + x] && match((y * W + x) * 4)) x--;
      x++;
      let up = false, down = false;
      while (x < W && !seen[y * W + x] && match((y * W + x) * 4)) {
        const pi = y * W + x, i = pi * 4;
        seen[pi] = 1;
        d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
        if (y > 0) {
          const ok = !seen[pi - W] && match(i - W * 4);
          if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false;
        }
        if (y < H - 1) {
          const ok = !seen[pi + W] && match(i + W * 4);
          if (ok && !down) { stack.push(x, y + 1); down = true; } else if (!ok) down = false;
        }
        x++;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ================================================================== CLIENT
  const Client = {
    isHost: false,
    conn: null,
    code: '',
    me: 'host',
    v: null,
    lastSeq: -1,
    lastChatId: -1,
    lastPong: Date.now(),
    deadline: 0,
    total: 0,
    lastTick: -1,
    wordsTouched: false,

    send(m) {
      if (this.isHost) return Host.handle('host', m);
      if (this.conn && this.conn.open) this.conn.send(m);
    },

    join(code, name, onError) {
      this.code = code;
      const peer = new Peer({ debug: 1 });
      let joined = false;
      const fail = (msg) => { if (!joined) { onError(msg); try { peer.destroy(); } catch { /* ignore */ } } };
      const timeout = setTimeout(() => fail('Kan de kamer niet bereiken. Klopt de code?'), 12000);
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail('Kamer niet gevonden. Klopt de code?');
        else if (!joined) fail('Verbinding mislukt: ' + err.type);
      });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          joined = true;
          clearTimeout(timeout);
          conn.send({ t: 'join', name });
          this.lastPong = Date.now();
          setInterval(() => {
            this.send({ t: 'ping' });
            if (Date.now() - this.lastPong > 20000) this.lost();
          }, 5000);
        });
        conn.on('data', (m) => this.receive(m));
        conn.on('close', () => this.lost());
      });
    },

    lost() {
      if (this.isHost || this.gone) return;
      this.gone = true;
      showOverlay('De verbinding met de host is verbroken. Misschien heeft de host het spel gesloten.');
    },

    receive(m) {
      if (!m) return;
      this.lastPong = Date.now();
      switch (m.t) {
        case 'toast': return toast(m.text);
        case 'state': showScreen('game'); return this.render(m);
        case 'sync':
          Board.turn = m.turn;
          Board.log = JSON.parse(JSON.stringify(m.log || []));
          return Board.redraw();
        case 'draw':
          if (m.turn === Board.turn) Board.apply(m.op);
          return;
      }
    },

    render(v) {
      const prev = this.v;
      this.v = v;
      this.me = v.me;
      const isDrawer = v.drawerId === v.me;

      if (v.turnNo !== Board.turn) Board.reset(v.turnNo);

      $('#room-code').textContent = this.code;
      $('#round-info').textContent =
        v.phase === 'lobby' ? 'Lobby' :
        v.phase === 'gameOver' ? 'Einde spel' :
        `Ronde ${Math.min(v.round, v.settings.rounds)} van ${v.settings.rounds}`;

      this.renderPlayers(v);

      let view = 'lobby';
      if (v.phase === 'choosing' || v.phase === 'drawing' || v.phase === 'turnEnd') view = 'board';
      else if (v.phase === 'gameOver') view = 'gameover';
      $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + view));

      if (view === 'lobby') this.renderLobby(v);
      if (view === 'board') this.renderBoard(v, isDrawer);
      if (view === 'gameover') this.renderGameOver(v);

      this.deadline = v.left ? performance.now() + v.left : 0;
      this.total = v.total;

      $('#chat-input').placeholder = v.phase === 'drawing'
        ? (isDrawer ? 'Jij tekent — chatten mag, verklappen niet!' : 'Typ je gok hier…')
        : 'Typ een bericht…';

      this.renderChat(v);
      this.handleEvent(v, prev);
    },

    renderPlayers(v) {
      const ol = $('#player-list');
      ol.innerHTML = '';
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const rankOf = new Map(sorted.map((p, i) => [p.id, i + 1]));
      const list = v.phase === 'lobby' ? v.players.filter((p) => p.on) : sorted;
      for (const p of list) {
        const li = document.createElement('li');
        if (p.id === v.drawerId && v.phase !== 'gameOver' && v.phase !== 'lobby') li.classList.add('drawer');
        if (p.guessed) li.classList.add('guessed');
        if (!p.on) li.classList.add('off');
        let marks = p.id === 'host' ? ' 👑' : '';
        if (li.classList.contains('drawer')) marks += ' ✏️';
        if (p.guessed) marks += ' ✅';
        li.innerHTML = `<span class="rank"></span><span class="avatar" style="background:${p.color}"></span><span class="pname"></span><span class="pscore"></span>`;
        li.querySelector('.rank').textContent = v.phase === 'lobby' ? '' : '#' + rankOf.get(p.id);
        li.querySelector('.avatar').textContent = p.name.charAt(0).toUpperCase();
        li.querySelector('.pscore').textContent = v.phase === 'lobby' ? `📝 ${p.words}` : p.score;
        const nm = li.querySelector('.pname');
        nm.textContent = p.name + marks;
        if (p.id === v.me) {
          const you = document.createElement('span');
          you.className = 'you';
          you.textContent = ' (jij)';
          nm.appendChild(you);
        }
        ol.appendChild(li);
      }
    },

    renderLobby(v) {
      $('#host-settings').style.display = this.isHost ? '' : 'none';
      $('#guest-wait').style.display = this.isHost ? 'none' : '';
      const s = v.settings;
      $('#guest-wait').textContent = `De host start het spel zodra iedereen er is. (${s.rounds} ronde${s.rounds > 1 ? 's' : ''} · ${s.time} sec tekenen · ${s.builtin ? 'met' : 'zonder'} ingebouwde woorden)`;
      $('#share-link').value = shareLink(this.code);
      const ta = $('#words-input');
      if (!this.wordsTouched && document.activeElement !== ta && v.myWords.length) ta.value = v.myWords.join(', ');
      $('#words-saved').textContent = v.myWords.length ? `✓ ${v.myWords.length} woord${v.myWords.length === 1 ? '' : 'en'} opgeslagen` : '';
      $('#pot-info').textContent = `🫙 Woordenpot: ${v.pot} eigen woord${v.pot === 1 ? '' : 'en'}${s.builtin ? ' + ingebouwde woorden' : ''}`;
      const enough = v.players.filter((p) => p.on).length >= 2;
      const hasWords = s.builtin || v.pot > 0;
      $('#btn-start').disabled = !enough || !hasWords;
      $('#start-hint').textContent = !enough ? 'Minimaal 2 spelers nodig.' : !hasWords ? 'Voeg woorden toe of zet de ingebouwde woorden aan.' : '';
    },

    renderBoard(v, isDrawer) {
      const drawerName = (v.players.find((p) => p.id === v.drawerId) || {}).name || '…';
      const me = v.players.find((p) => p.id === v.me) || {};
      const label = $('#word-label');
      const mask = $('#word-mask');
      if (v.phase === 'choosing') {
        label.textContent = isDrawer ? 'Kies een woord om te tekenen' : `${drawerName} kiest een woord…`;
        mask.textContent = '';
      } else if (v.phase === 'drawing') {
        if (isDrawer) { label.textContent = 'Jij tekent:'; mask.textContent = v.word; }
        else if (me.guessed) { label.textContent = 'Je hebt het geraden! ✅'; mask.textContent = v.word; }
        else {
          label.textContent = `${drawerName} tekent — raad het woord`;
          const letters = [...v.mask].filter((c) => c !== ' ' && c !== '-').length;
          mask.textContent = [...v.mask].map((c) => (c === ' ' ? '  ' : c)).join(' ');
          const cnt = document.createElement('span');
          cnt.className = 'count';
          cnt.textContent = ` (${letters})`;
          mask.appendChild(cnt);
        }
      } else {
        label.textContent = 'Het woord was';
        mask.textContent = v.word || '';
      }

      // overlay
      const ov = $('#board-overlay');
      const title = $('#ov-title');
      const body = $('#ov-body');
      body.innerHTML = '';
      if (v.phase === 'choosing') {
        ov.classList.add('show');
        if (isDrawer) {
          title.textContent = 'Kies een woord';
          const wrap = document.createElement('div');
          wrap.className = 'choices';
          v.choices.forEach((w, i) => {
            const b = document.createElement('button');
            b.className = 'btn primary';
            b.textContent = w;
            b.addEventListener('click', () => Client.send({ t: 'pick', i }));
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        } else {
          title.textContent = `✏️ ${drawerName} kiest een woord…`;
        }
      } else if (v.phase === 'turnEnd' && v.result) {
        ov.classList.add('show');
        title.textContent = v.result.title;
        const rw = document.createElement('div');
        rw.className = 'reveal-word';
        rw.textContent = v.result.word;
        body.appendChild(rw);
        const ul = document.createElement('ul');
        ul.className = 'gains';
        for (const g of v.result.gains) {
          const li = document.createElement('li');
          if (!g.d) li.className = 'zero';
          li.textContent = g.name + ' ';
          const b = document.createElement('b');
          b.textContent = '+' + g.d;
          li.appendChild(b);
          ul.appendChild(li);
        }
        body.appendChild(ul);
      } else ov.classList.remove('show');

      const canDraw = v.phase === 'drawing' && isDrawer;
      $('#toolbar').classList.toggle('show', canDraw);
      $('#canvas').classList.toggle('can-draw', canDraw);
      $('#canvas').classList.toggle('fill-cursor', canDraw && Board.tool === 'fill');
      $('#clock').classList.toggle('hidden', !(v.total && (v.phase === 'choosing' || v.phase === 'drawing')));
    },

    renderGameOver(v) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const pod = $('#podium');
      pod.innerHTML = '';
      const places = [
        { i: 1, h: 110, c: '#cfd6de', m: '2' },
        { i: 0, h: 150, c: '#ffd23f', m: '1' },
        { i: 2, h: 80, c: '#e0a370', m: '3' },
      ];
      for (const pl of places) {
        const p = sorted[pl.i];
        if (!p) continue;
        const step = document.createElement('div');
        step.className = 'step';
        step.innerHTML = `<div class="pn"></div><div class="ps">${p.score} pt</div><div class="block" style="height:${pl.h}px;background:${pl.c}">${pl.m}</div>`;
        step.querySelector('.pn').textContent = p.name;
        pod.appendChild(step);
      }
      $('#btn-again').style.display = this.isHost ? '' : 'none';
      $('#again-wait').style.display = this.isHost ? 'none' : '';
    },

    renderChat(v) {
      const last = v.chat.length ? v.chat[v.chat.length - 1].id : 0;
      if (last === this.lastChatId) return;
      this.lastChatId = last;
      const log = $('#chat-log');
      log.innerHTML = '';
      for (const m of v.chat) {
        const li = document.createElement('li');
        li.className = 'msg-' + m.kind; // prefixed so it never collides with the .chat panel class
        if (m.from) {
          const b = document.createElement('b');
          b.textContent = m.from + ': ';
          li.appendChild(b);
        }
        li.appendChild(document.createTextNode(m.text));
        log.appendChild(li);
      }
      log.scrollTop = log.scrollHeight;
    },

    handleEvent(v) {
      const ev = v.ev;
      if (this.lastSeq === -1) { this.lastSeq = ev.seq; return; }
      if (ev.seq === this.lastSeq) return;
      this.lastSeq = ev.seq;
      switch (ev.type) {
        case 'guessed':
          if (ev.by === v.me) { sfx.win(); confetti(60); } else sfx.guessed();
          break;
        case 'choose': case 'drawing':
          if (ev.to === v.me) { sfx.turn(); if (navigator.vibrate) navigator.vibrate([60, 40, 60]); }
          break;
        case 'hint': sfx.hint(); break;
        case 'end': sfx.end(); break;
        case 'join': sfx.join(); break;
        case 'chat': sfx.chat(); break;
        case 'start': sfx.start(); break;
        case 'gameover': sfx.win(); confetti(140); break;
      }
    },
  };

  // ------------------------------------------------------------------ UI helpers
  function showScreen(name) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name)); }
  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function showOverlay(text) { $('#overlay-text').textContent = text; $('#overlay').classList.add('show'); }
  function confetti(n = 80) {
    const colors = ['#5b6cff', '#ffd23f', '#2bb673', '#ff7b9c', '#d6a2e8'];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
      c.style.animationDelay = Math.random() * 0.4 + 's';
      c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4500);
    }
  }
  const shareLink = (code) => location.origin + location.pathname + '?room=' + code;
  async function copyLink() {
    const link = shareLink(Client.code);
    try { await navigator.clipboard.writeText(link); toast('Link gekopieerd! Stuur hem naar je vrienden.'); }
    catch { const i = $('#share-link'); i.value = link; i.select(); toast('Kopieer de link hierboven'); }
  }

  // clock animation
  function tick() {
    const clock = $('#clock');
    if (Client.deadline && Client.total) {
      const left = Math.max(0, Client.deadline - performance.now());
      const sec = Math.ceil(left / 1000);
      clock.style.setProperty('--p', (left / Client.total) * 100 + '%');
      clock.classList.toggle('low', left < 10000);
      if (clock.dataset.sec !== String(sec)) {
        clock.dataset.sec = sec;
        clock.innerHTML = `<span>${sec}</span>`;
        const v = Client.v;
        const mine = v && ((v.phase === 'drawing' && v.drawerId === v.me) || (v.phase === 'choosing' && v.drawerId === v.me));
        if (mine && sec <= 5 && sec > 0 && sec !== Client.lastTick) { Client.lastTick = sec; sfx.tick(); }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ------------------------------------------------------------------ toolbar
  function buildToolbar() {
    const colors = $('#colors');
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        Board.color = c;
        if (Board.tool === 'eraser') setTool('pen');
        paintToolbar();
      });
      colors.appendChild(b);
    }
    const sizes = $('#sizes');
    SIZES.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'tool size';
      b.dataset.size = s;
      b.title = `Dikte ${s}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const px = Math.max(4, Math.round(s / 1.4));
      dot.style.width = dot.style.height = px + 'px';
      b.appendChild(dot);
      b.addEventListener('click', () => { Board.size = s; if (Board.tool === 'fill') setTool('pen'); paintToolbar(); });
      sizes.appendChild(b);
    });
    $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#btn-undo').addEventListener('click', () => { if (Board.canDraw() && Board.log.length) Board.local({ k: 'undo' }); });
    $('#btn-clear').addEventListener('click', () => { if (Board.canDraw() && Board.log.length) Board.local({ k: 'clear' }); });
    paintToolbar();
  }
  function setTool(t) {
    Board.tool = t;
    $('#canvas').classList.toggle('fill-cursor', t === 'fill');
    paintToolbar();
  }
  function paintToolbar() {
    $$('.swatch').forEach((b) => b.classList.toggle('active', b.title === Board.color && Board.tool !== 'eraser'));
    $$('.tool.size').forEach((b) => b.classList.toggle('active', +b.dataset.size === Board.size));
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === Board.tool));
    $$('.tool.size .dot').forEach((d) => (d.style.background = Board.tool === 'eraser' ? '#bbb' : Board.color === '#ffffff' ? '#ddd' : Board.color));
  }

  // ------------------------------------------------------------------ wiring
  function setup() {
    Board.init();
    buildToolbar();
    const params = new URLSearchParams(location.search);
    const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const nameInput = $('#name-input');
    nameInput.value = store.get('tekenraad-name') || store.get('galgje-name') || '';
    if (room) {
      $('#code-input').value = room;
      $('#btn-create').classList.remove('primary');
      $('#btn-join').classList.add('primary');
      (nameInput.value ? $('#btn-join') : nameInput).focus();
    } else nameInput.focus();

    const getName = () => {
      const n = cleanName(nameInput.value);
      if (!n) { $('#home-error').textContent = 'Vul eerst je naam in.'; nameInput.focus(); return null; }
      store.set('tekenraad-name', n);
      return n;
    };
    const busy = (on, label) => {
      $('#btn-create').disabled = on;
      $('#btn-join').disabled = on;
      if (label !== undefined) $('#home-error').textContent = label;
    };
    const noPeer = () => typeof Peer === 'undefined' && (($('#home-error').textContent = 'Kon de verbindingsbibliotheek niet laden. Check je internet.'), true);

    $('#btn-create').addEventListener('click', () => {
      const name = getName();
      if (!name || noPeer()) return;
      initAudio();
      busy(true, 'Kamer aanmaken…');
      Client.isHost = true;
      Host.open(name, (code) => {
        Client.code = code;
        history.replaceState(null, '', '?room=' + code);
        $('#home-error').textContent = '';
        Host.broadcast();
      }, (err) => {
        busy(false, 'Kon geen kamer aanmaken (' + err.type + '). Probeer opnieuw.');
        Client.isHost = false;
      });
    });

    const doJoin = () => {
      const name = getName();
      if (!name) return;
      const code = $('#code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) { $('#home-error').textContent = 'De code heeft 5 tekens.'; return; }
      if (noPeer()) return;
      initAudio();
      busy(true, 'Verbinden…');
      Client.join(code, name, (msg) => busy(false, msg));
    };
    $('#btn-join').addEventListener('click', doJoin);
    $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ($('#code-input').value.trim().length === 5 ? doJoin() : $('#btn-create').click());
    });

    $('#btn-copy').addEventListener('click', copyLink);
    $('#btn-copy2').addEventListener('click', copyLink);

    const muteBtn = $('#btn-mute');
    const paintMute = () => (muteBtn.textContent = muted ? '🔇' : '🔊');
    paintMute();
    muteBtn.addEventListener('click', () => {
      muted = !muted;
      store.set('tekenraad-muted', muted ? '1' : '0');
      paintMute();
      initAudio();
    });

    // lobby
    const saveWords = () => {
      const list = parseWords($('#words-input').value);
      Client.send({ t: 'words', list });
      Client.wordsTouched = false;
      $('#words-input').value = list.join(', ');
      toast(list.length ? `${list.length} woord${list.length === 1 ? '' : 'en'} opgeslagen` : 'Woorden gewist');
    };
    $('#btn-words').addEventListener('click', saveWords);
    $('#words-input').addEventListener('input', () => (Client.wordsTouched = true));
    $('#words-input').addEventListener('blur', () => { if (Client.wordsTouched) saveWords(); });

    const sendSettings = () => Client.send({ t: 'settings', rounds: $('#set-rounds').value, time: $('#set-time').value, builtin: $('#set-builtin').checked });
    ['#set-rounds', '#set-time', '#set-builtin'].forEach((s) => $(s).addEventListener('change', sendSettings));
    $('#btn-start').addEventListener('click', () => {
      initAudio();
      if (Client.wordsTouched) saveWords();
      Client.send({ t: 'start' });
    });
    $('#btn-again').addEventListener('click', () => Client.send({ t: 'again' }));

    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const i = $('#chat-input');
      if (!i.value.trim()) return;
      Client.send({ t: 'chat', text: i.value });
      i.value = '';
    });

    // Ctrl+Z undo for the drawer; typing anywhere focuses the chat for guessers
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (Board.canDraw() && Board.log.length) { e.preventDefault(); Board.local({ k: 'undo' }); }
        return;
      }
      const v = Client.v;
      if (v && v.phase === 'drawing' && v.drawerId !== v.me && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        $('#chat-input').focus();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (Client.isHost && Host.S && Host.S.players.filter((p) => p.on).length > 1) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  setup();
})();
