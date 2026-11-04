/* Teken & Raad — multiplayer draw-and-guess via peer-to-peer (PeerJS).
 * The host's browser runs the game; other players connect with the room code.
 * Drawing is sent as small operations (stroke start, points, fill, shape, undo,
 * clear) in an 800x600 coordinate space, so every screen redraws the same picture. */
(() => {
  'use strict';

  const PREFIX = 'tekenraad-nl-room-';
  const CHOOSE_SECONDS = 15;
  const TURN_END_MS = 6000;
  const W = 800, H = 600;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const AVATAR_COLORS = ['#ff9f68', '#7bd389', '#6ec6ff', '#ffd23f', '#d6a2e8', '#ff7b9c', '#9be7d8', '#f7b267', '#a0c4ff', '#cdb4db'];
  const AVATAR_EMOJIS = ['😀', '😎', '🤓', '🥳', '😺', '🐶', '🦊', '🐼', '🐸', '🐵', '🦄', '🐙', '🐢', '🦖', '👽', '🤖', '👻', '🎃', '🐯', '🐨', '🐷', '🐧', '🦉', '🐝'];
  const PALETTE = ['#000000', '#4a4a4a', '#9e9e9e', '#ffffff', '#e53935', '#ff7043', '#ffb300', '#fdd835', '#43a047', '#1b5e20',
    '#4fc3f7', '#1e88e5', '#283593', '#8e24aa', '#f06292', '#ffcdd2', '#795548', '#d7a86e', '#ffe0b2', '#26a69a'];
  const SIZES = [4, 10, 20, 36];
  const SHAPES = ['line', 'rect', 'ellipse'];
  const MAX_WORDS_PER_PLAYER = 30;
  const DEFAULT_SETTINGS = { rounds: 2, time: 80, builtin: true, choices: 3, hints: 3, mode: 'normal', max: 12 };

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
  const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(hi, Math.max(lo, n)); };
  const randId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  function cleanAvatar(a) {
    const e = a && AVATAR_EMOJIS.includes(a.e) ? a.e : AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)];
    const c = a && AVATAR_COLORS.includes(a.c) ? a.c : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    return { e, c };
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
    leave() { tone(500, 0.1, 'sine', 0, 0.06); tone(350, 0.12, 'sine', 0.08, 0.06); },
    chat() { tone(1250, 0.04, 'sine', 0, 0.04); },
    like() { tone(1320, 0.06, 'triangle', 0, 0.06); },
    tick() { tone(1000, 0.05, 'square', 0, 0.04); },
    start() { [392, 523, 659].forEach((f, i) => tone(f, 0.18, 'triangle', i * 0.09)); },
  };

  // ================================================================== DRAWING LOG
  // Shared by host (authoritative copy) and every client (render copy).
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function applyToLog(log, op) {
    switch (op.k) {
      case 'begin': log.push({ k: 'stroke', id: op.id, c: op.c, s: op.s, p: op.p.slice(0, 2) }); break;
      case 'pts': {
        const st = log.length && log[log.length - 1];
        if (st && st.k === 'stroke' && st.id === op.id) st.p.push(...op.p);
        break;
      }
      case 'fill': log.push({ k: 'fill', id: op.id, x: op.x, y: op.y, c: op.c }); break;
      case 'shape': log.push({ k: 'shape', id: op.id, sh: op.sh, c: op.c, s: op.s, x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }); break;
      case 'item': log.push(clone(op.it)); break;
      case 'undo': log.pop(); break;
      case 'clear': log.length = 0; break;
    }
  }
  const isNum = (n) => typeof n === 'number' && isFinite(n);
  const isCol = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  function validItem(it) {
    if (!it || typeof it !== 'object') return false;
    if (it.k === 'stroke') return isCol(it.c) && SIZES.includes(it.s) && Array.isArray(it.p) && it.p.length >= 2 && it.p.length <= 40000 && it.p.every(isNum);
    if (it.k === 'fill') return isCol(it.c) && isNum(it.x) && isNum(it.y);
    if (it.k === 'shape') return SHAPES.includes(it.sh) && isCol(it.c) && SIZES.includes(it.s) && [it.x1, it.y1, it.x2, it.y2].every(isNum);
    return false;
  }
  function validOp(op) {
    if (!op || typeof op !== 'object') return false;
    switch (op.k) {
      case 'begin': return isCol(op.c) && SIZES.includes(op.s) && Array.isArray(op.p) && op.p.length >= 2 && op.p.every(isNum);
      case 'pts': return Array.isArray(op.p) && op.p.length <= 400 && op.p.every(isNum);
      case 'fill': return isCol(op.c) && isNum(op.x) && isNum(op.y);
      case 'shape': return validItem({ ...op, k: 'shape' });
      case 'item': return validItem(op.it);
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
    banned: new Set(),
    startScores: {},
    S: null,

    init(name, avatar) {
      this.S = {
        phase: 'lobby',
        players: [],
        settings: { ...DEFAULT_SETTINGS },
        round: 0,
        queue: [],
        drawerId: null,
        turnNo: 0,
        choices: [],
        word: '',
        revealed: [],
        hintsGiven: 0,
        guessedIds: [],
        rates: {}, // playerId -> 1 | -1 for this turn
        kickVotes: {}, // targetId -> [voterIds]
        deadline: 0,
        timerTotal: 0,
        chat: [],
        ev: { seq: 0 },
        result: null,
      };
      this.addPlayer('host', name, avatar, 'host');
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
    addPlayer(id, rawName, avatar, token) {
      let name = cleanName(rawName) || `Speler ${this.S.players.length + 1}`;
      const base = name;
      let n = 2;
      while (this.S.players.some((p) => p.on && p.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
      this.S.players.push({ id, token: String(token || randId()), name, score: 0, on: true, avatar: cleanAvatar(avatar), words: [] });
      this.lastSeen.set(id, Date.now());
      if (id !== 'host') {
        this.say(`${name} doet mee`);
        this.event('join');
        if (this.S.phase !== 'lobby' && this.S.phase !== 'gameOver') this.S.queue.push(id);
      }
    },

    // a player who lost connection comes back with the same token: keep score
    restorePlayer(p, newId, avatar) {
      const old = p.id;
      p.id = newId;
      p.on = true;
      if (avatar) p.avatar = cleanAvatar(avatar);
      const S = this.S;
      S.queue = S.queue.map((x) => (x === old ? newId : x));
      S.guessedIds = S.guessedIds.map((x) => (x === old ? newId : x));
      if (S.drawerId === old) S.drawerId = newId;
      this.lastSeen.set(newId, Date.now());
      this.say(`${p.name} is terug!`);
      this.event('join');
      if (S.phase !== 'lobby' && S.phase !== 'gameOver' && !S.queue.includes(newId)) S.queue.push(newId);
    },

    removePlayer(id) {
      const p = this.p(id);
      this.conns.delete(id);
      this.lastSeen.delete(id);
      if (!p || !p.on) return;
      p.on = false;
      this.say(`${p.name} is vertrokken`);
      this.event('leave');
      const S = this.S;
      delete S.kickVotes[id];
      for (const t in S.kickVotes) S.kickVotes[t] = S.kickVotes[t].filter((v) => v !== id);
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

    // ---- kicking
    voteKick(voter, target) {
      const S = this.S;
      const t = this.p(target);
      if (!t || !t.on || target === 'host' || target === voter) return;
      if (voter === 'host') return this.kick(target);
      const votes = S.kickVotes[target] || (S.kickVotes[target] = []);
      if (votes.includes(voter)) return this.toast(voter, 'Je hebt al gestemd.');
      votes.push(voter);
      const eligible = this.online().filter((p) => p.id !== target).length;
      const needed = Math.floor(eligible / 2) + 1;
      this.say(`${this.name(voter)} stemt om ${t.name} te verwijderen (${votes.length}/${needed})`, 'bad');
      if (votes.length >= needed) return this.kick(target);
      this.broadcast();
    },
    kick(target) {
      const t = this.p(target);
      if (!t || target === 'host') return;
      this.banned.add(t.token);
      this.send(target, { t: 'kicked' });
      this.say(`${t.name} is uit het spel verwijderd`, 'bad');
      const c = this.conns.get(target);
      setTimeout(() => { try { c && c.close(); } catch { /* ignore */ } }, 400);
      this.removePlayer(target);
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
      const n = this.S.settings.choices;
      const fresh = (w) => !this.used.has(compact(w));
      const pot = this.customPot().filter((x) => fresh(x.w));
      const others = shuffle(pot.filter((x) => x.by !== drawerId).map((x) => x.w));
      const own = shuffle(pot.filter((x) => x.by === drawerId).map((x) => x.w));
      const builtin = shuffle((window.BUILTIN_WORDS || []).filter(fresh));
      const useBuiltin = this.S.settings.builtin;
      const out = [];
      const add = (list, max) => { for (const w of list) { if (out.length >= max) break; if (!out.some((o) => compact(o) === compact(w))) out.push(w); } };
      add(others, useBuiltin ? Math.max(1, n - 1) : n); // own words of others first, at least one built-in for variety
      if (useBuiltin) add(builtin, n);
      add(own, n); // only when nothing else is left
      if (out.length < n) {
        this.used.clear(); // pot is empty: allow words again
        add(shuffle(this.customPot().filter((x) => x.by !== drawerId).map((x) => x.w)), n);
        add(shuffle(window.BUILTIN_WORDS || []), n);
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
      S.kickVotes = {};
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
      Object.assign(S, { phase: 'choosing', drawerId: id, choices: this.pickWords(id), word: '', revealed: [], hintsGiven: 0, guessedIds: [], rates: {}, result: null });
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
      if (S.phase !== 'drawing' || !S.timerTotal || S.settings.mode === 'hidden') return;
      const letters = [...S.word].map((c, i) => (isLetter(c) ? i : -1)).filter((i) => i >= 0);
      const maxHints = Math.max(0, Math.min(S.settings.hints, letters.length - 2));
      if (S.hintsGiven >= maxHints) return;
      // spread the hints between 35% and 90% of the drawing time
      const at = 0.35 + (0.55 * (S.hintsGiven + 1)) / (maxHints + 1);
      const elapsed = 1 - (S.deadline - Date.now()) / S.timerTotal;
      if (elapsed < at) return;
      const hidden = letters.filter((i) => !S.revealed.includes(i));
      if (hidden.length > 1) {
        S.revealed.push(hidden[Math.floor(Math.random() * hidden.length)]);
        S.hintsGiven++;
        this.event('hint');
        this.broadcast();
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

    rate(id, v) {
      const S = this.S;
      if ((S.phase !== 'drawing' && S.phase !== 'turnEnd') || id === S.drawerId || !this.p(id)) return;
      v = v > 0 ? 1 : -1;
      const first = !(id in S.rates);
      if (S.rates[id] === v) return;
      S.rates[id] = v;
      if (first) this.say(`${this.name(id)} vindt de tekening ${v > 0 ? 'leuk 👍' : 'niet zo leuk 👎'}`);
      this.event('rate', { v });
      this.broadcast();
    },
    rateCounts() {
      const vals = Object.values(this.S.rates);
      return { up: vals.filter((v) => v > 0).length, down: vals.filter((v) => v < 0).length };
    },

    endTurn(reason) {
      const S = this.S;
      this.clearDeadline();
      const drawer = this.name(S.drawerId);
      const titles = {
        all: 'Iedereen heeft het geraden! 🎉',
        time: S.guessedIds.length ? '⏰ De tijd is om!' : '⏰ Niemand heeft het geraden…',
        drawerLeft: `${drawer} is vertrokken`,
        skipped: '⏭️ Beurt overgeslagen',
      };
      const gains = S.players
        .filter((p) => p.on)
        .map((p) => ({ name: p.name, d: p.score - (this.startScores[p.id] ?? p.score) }))
        .sort((a, b) => b.d - a.d);
      S.result = { reason, title: titles[reason] || 'Einde beurt', word: S.word, drawer, gains };
      S.phase = 'turnEnd';
      if (S.word) this.say(`Het woord was: ${S.word}`);
      this.event('end');
      this.broadcast();
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = setTimeout(() => { if (this.S.phase === 'turnEnd') this.nextDrawer(); }, TURN_END_MS);
    },

    skip(id) {
      if (id !== 'host') return;
      const S = this.S;
      if (S.phase === 'choosing' || S.phase === 'drawing') this.endTurn('skipped');
    },

    gameOver() {
      this.clearDeadline();
      this.S.phase = 'gameOver';
      this.S.drawerId = null;
      const best = this.online().sort((a, b) => b.score - a.score)[0]; // players who left or were kicked can't win
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
      Object.assign(S, { phase: 'lobby', round: 0, queue: [], drawerId: null, choices: [], word: '', revealed: [], guessedIds: [], rates: {}, result: null });
      this.log = [];
      if (msg) this.say(msg);
      this.broadcast();
    },

    setSettings(s) {
      if (this.S.phase !== 'lobby') return;
      this.S.settings = {
        rounds: clampInt(s.rounds, 1, 10, 2),
        time: clampInt(s.time, 30, 180, 80),
        choices: clampInt(s.choices, 1, 5, 3),
        hints: clampInt(s.hints, 0, 5, 3),
        mode: s.mode === 'hidden' ? 'hidden' : 'normal',
        max: clampInt(s.max, 2, 16, 12),
        builtin: !!s.builtin,
      };
      this.broadcast();
    },

    handleJoin(id, m, conn) {
      const token = typeof m.token === 'string' ? m.token.slice(0, 64) : '';
      const refuse = (t) => { this.send(id, { t }); setTimeout(() => { try { conn && conn.close(); } catch { /* ignore */ } }, 400); };
      if (token && this.banned.has(token)) return refuse('kicked');
      if (this.p(id)) return;
      const back = token && this.S.players.find((p) => p.token === token && p.id !== 'host');
      if (back && back.on) {
        // same tab reconnected before we noticed it was gone: drop the old connection
        const old = this.conns.get(back.id);
        this.conns.delete(back.id);
        this.lastSeen.delete(back.id);
        try { old && old.close(); } catch { /* ignore */ }
      }
      if (back) this.restorePlayer(back, id, m.avatar);
      else if (this.online().length >= this.S.settings.max) return refuse('full');
      else this.addPlayer(id, m.name, m.avatar, token);
      this.broadcast();
      this.send(id, { t: 'sync', turn: this.S.turnNo, log: this.log });
    },

    handle(id, m, conn) {
      if (!m || typeof m !== 'object') return;
      this.lastSeen.set(id, Date.now());
      if (m.t === 'join') return this.handleJoin(id, m, conn);
      if (!this.p(id)) return;
      const S = this.S;
      switch (m.t) {
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
        case 'rate': this.rate(id, m.v); break;
        case 'kick': this.voteKick(id, m.target); break;
        case 'skip': this.skip(id); break;
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
      const hiddenMode = S.settings.mode === 'hidden';
      const me = this.p(pid);
      return {
        t: 'state',
        me: pid,
        phase: S.phase,
        players: S.players.map((p) => ({
          id: p.id, name: p.name, score: p.score, on: p.on, avatar: p.avatar,
          guessed: S.guessedIds.includes(p.id), words: p.words.length,
          votes: (S.kickVotes[p.id] || []).length,
        })),
        settings: S.settings,
        round: S.round,
        turnNo: S.turnNo,
        drawerId: S.drawerId,
        choices: isDrawer && S.phase === 'choosing' ? S.choices : [],
        word: showWord && S.word ? S.word : null,
        mask: S.word && !hiddenMode ? [...S.word].map((c, i) => (!isLetter(c) || S.revealed.includes(i) ? c : '_')).join('') : '',
        hidden: hiddenMode,
        left: S.deadline ? Math.max(0, S.deadline - Date.now()) : 0,
        total: S.timerTotal,
        chat: S.chat.filter((m) => !m.aud || m.aud.includes(pid)).slice(-60).map(({ aud, ...m }) => m),
        ev: S.ev,
        result: S.result,
        rates: this.rateCounts(),
        myRate: S.rates[pid] || 0,
        myVotes: Object.keys(S.kickVotes).filter((t) => S.kickVotes[t].includes(pid)),
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

    open(name, avatar, onReady, onError) {
      this.init(name, avatar);
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
            this.handle(conn.peer, m, conn);
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
    pv: null, // preview canvas context for shapes
    log: [],
    redoStack: [],
    turn: -1,
    color: '#000000',
    size: SIZES[1],
    tool: 'pen',
    drawing: null, // current stroke id while pointer is down
    shapeStart: null,
    pending: [],
    lastX: 0,
    lastY: 0,
    idCounter: 0,

    init() {
      this.canvas = $('#canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.pv = $('#preview').getContext('2d');
      this.clearCanvas();
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', (e) => this.up(e));
      c.addEventListener('pointercancel', (e) => this.up(e));
      setInterval(() => this.flush(), 40);
    },

    reset(turn) {
      this.turn = turn;
      this.log = [];
      this.redoStack = [];
      this.drawing = null;
      this.shapeStart = null;
      this.pending = [];
      this.tool = 'pen'; // every turn starts with the pen, not a leftover fill bucket
      paintToolbar();
      this.clearPreview();
      this.clearCanvas();
    },
    clearCanvas() {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, W, H);
    },
    clearPreview() { this.pv.clearRect(0, 0, W, H); },
    redraw() {
      this.clearCanvas();
      for (const item of this.log) this.paint(item);
    },
    paint(item) {
      if (item.k === 'stroke') this.strokePts(item.c, item.s, item.p, 0);
      else if (item.k === 'fill') floodFill(this.ctx, item.x, item.y, item.c);
      else if (item.k === 'shape') drawShape(this.ctx, item);
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
      if (op.k === 'undo' || op.k === 'clear') this.redraw();
      else this.paint(this.log[this.log.length - 1]);
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
      if (op.k !== 'pts' && op.k !== 'undo' && !(op.k === 'item' && op.redo)) this.redoStack = [];
      delete op.redo;
      this.apply(op);
      Client.send({ t: 'draw', op });
    },
    newId() { return Client.me + '-' + ++this.idCounter; },
    paintColor() { return this.tool === 'eraser' ? '#ffffff' : this.color; },

    undo() {
      if (!this.canDraw() || !this.log.length) return;
      this.redoStack.push(clone(this.log[this.log.length - 1]));
      this.local({ k: 'undo' });
    },
    redo() {
      if (!this.canDraw() || !this.redoStack.length) return;
      const it = this.redoStack.pop();
      it.id = this.newId();
      this.local({ k: 'item', it, redo: true });
    },
    clearAll() {
      if (!this.canDraw() || !this.log.length) return;
      this.local({ k: 'clear' });
    },

    down(e) {
      if (!this.canDraw()) return;
      e.preventDefault();
      const [x, y] = this.pos(e);
      if (this.tool === 'fill') return this.local({ k: 'fill', id: this.newId(), x, y, c: this.color });
      if (this.tool === 'picker') {
        const d = this.ctx.getImageData(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)), 1, 1).data;
        setColor('#' + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join(''));
        setTool('pen');
        return;
      }
      this.canvas.setPointerCapture(e.pointerId);
      if (SHAPES.includes(this.tool)) { this.shapeStart = [x, y]; return; }
      this.drawing = this.newId();
      this.lastX = x;
      this.lastY = y;
      this.pending = [];
      this.local({ k: 'begin', id: this.drawing, c: this.paintColor(), s: this.size, p: [x, y] });
    },
    move(e) {
      if (this.shapeStart) {
        const [x, y] = this.pos(e);
        this.clearPreview();
        drawShape(this.pv, { sh: this.tool, c: this.color, s: this.size, x1: this.shapeStart[0], y1: this.shapeStart[1], x2: x, y2: y });
        return;
      }
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
    up(e) {
      if (this.shapeStart) {
        const [x1, y1] = this.shapeStart;
        const [x2, y2] = e && e.clientX !== undefined ? this.pos(e) : [x1, y1];
        this.shapeStart = null;
        this.clearPreview();
        if (Math.hypot(x2 - x1, y2 - y1) >= 3 && this.canDraw())
          this.local({ k: 'shape', id: this.newId(), sh: this.tool, c: this.color, s: this.size, x1, y1, x2, y2 });
        return;
      }
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

  function drawShape(ctx, it) {
    ctx.strokeStyle = it.c;
    ctx.lineWidth = it.s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (it.sh === 'line') { ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); }
    else if (it.sh === 'rect') ctx.rect(Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
    else if (it.sh === 'ellipse') ctx.ellipse((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, Math.abs(it.x2 - it.x1) / 2, Math.abs(it.y2 - it.y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

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
    gallery: [],
    onJoinError: null,

    send(m) {
      if (this.isHost) return Host.handle('host', m);
      if (this.conn && this.conn.open) this.conn.send(m);
    },

    join(code, name, avatar, onError) {
      this.code = code;
      this.onJoinError = onError;
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
          conn.send({ t: 'join', name, avatar, token: myToken() });
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

    lost(text) {
      if (this.isHost || this.gone) return;
      this.gone = true;
      showOverlay(text || 'De verbinding met de host is verbroken. Probeer opnieuw te verbinden — je punten blijven bewaard.', !text);
    },

    receive(m) {
      if (!m) return;
      this.lastPong = Date.now();
      switch (m.t) {
        case 'toast': return toast(m.text);
        case 'state': showScreen('game'); return this.render(m);
        case 'full':
          this.gone = true;
          if (this.onJoinError) this.onJoinError('Deze kamer is vol.');
          return;
        case 'kicked':
          return this.lost('Je bent uit het spel verwijderd.');
        case 'sync':
          Board.turn = m.turn;
          Board.log = clone(m.log || []);
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

      // keep a picture of every finished drawing for the gallery
      if (prev && prev.phase === 'drawing' && v.phase === 'turnEnd' && v.result && v.result.word) this.snapshot(v);
      if (prev && (prev.phase === 'lobby' || prev.phase === 'gameOver') && v.phase !== 'lobby' && v.phase !== 'gameOver') this.gallery = [];
      if (prev && prev.phase === 'turnEnd' && prev.turnNo === v.turnNo && this.gallery.length) {
        const last = this.gallery[this.gallery.length - 1];
        if (last.turn === v.turnNo) last.rates = v.rates;
      }

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
      this.handleEvent(v);
    },

    snapshot(v) {
      try {
        this.gallery.push({
          turn: v.turnNo,
          word: v.result.word,
          drawer: v.result.drawer,
          img: Board.canvas.toDataURL('image/jpeg', 0.75),
          rates: v.rates,
        });
      } catch { /* ignore */ }
    },

    renderPlayers(v) {
      const ol = $('#player-list');
      ol.innerHTML = '';
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const rankOf = new Map(sorted.map((p, i) => [p.id, i + 1]));
      const list = v.phase === 'lobby' ? v.players.filter((p) => p.on) : sorted;
      const online = v.players.filter((p) => p.on).length;
      $('#player-count').textContent = `${online}/${v.settings.max}`;
      for (const p of list) {
        const li = document.createElement('li');
        if (p.id === v.drawerId && v.phase !== 'gameOver' && v.phase !== 'lobby') li.classList.add('drawer');
        if (p.guessed) li.classList.add('guessed');
        if (!p.on) li.classList.add('off');
        let marks = p.id === 'host' ? ' 👑' : '';
        if (li.classList.contains('drawer')) marks += ' ✏️';
        if (p.guessed) marks += ' ✅';
        li.innerHTML = `<span class="rank"></span><span class="avatar"></span><span class="pname"></span><span class="votes"></span><span class="pscore"></span>`;
        li.querySelector('.rank').textContent = v.phase === 'lobby' ? '' : '#' + rankOf.get(p.id);
        const av = li.querySelector('.avatar');
        av.textContent = p.avatar.e;
        av.style.background = p.avatar.c;
        li.querySelector('.pscore').textContent = v.phase === 'lobby' ? `📝 ${p.words}` : p.score;
        if (p.votes) li.querySelector('.votes').textContent = `🥾${p.votes}`;
        const nm = li.querySelector('.pname');
        nm.textContent = p.name + marks;
        if (p.id === v.me) {
          const you = document.createElement('span');
          you.className = 'you';
          you.textContent = ' (jij)';
          nm.appendChild(you);
        } else if (p.on && p.id !== 'host') {
          const k = document.createElement('button');
          k.className = 'kick';
          k.textContent = '🥾';
          const voted = v.myVotes.includes(p.id);
          k.title = this.isHost ? `${p.name} verwijderen` : voted ? 'Je hebt al gestemd' : `Stem om ${p.name} te verwijderen`;
          k.addEventListener('click', () => {
            const q = this.isHost ? `${p.name} uit het spel verwijderen?` : `Stemmen om ${p.name} uit het spel te zetten?`;
            if (confirm(q)) Client.send({ t: 'kick', target: p.id });
          });
          li.appendChild(k);
        }
        ol.appendChild(li);
      }
    },

    renderLobby(v) {
      $('#host-settings').style.display = this.isHost ? '' : 'none';
      $('#guest-wait').style.display = this.isHost ? 'none' : '';
      const s = v.settings;
      $('#guest-wait').innerHTML = '';
      const lines = [
        'De host start het spel zodra iedereen er is.',
        `${s.rounds} ronde${s.rounds > 1 ? 's' : ''} · ${s.time} sec tekenen · ${s.choices} woordkeuze${s.choices > 1 ? 's' : ''}`,
        `${s.mode === 'hidden' ? 'Verborgen woorden' : `${s.hints} hint${s.hints === 1 ? '' : 's'}`} · max ${s.max} spelers · ${s.builtin ? 'met' : 'zonder'} ingebouwde woorden`,
      ];
      for (const l of lines) { const p = document.createElement('p'); p.textContent = l; $('#guest-wait').appendChild(p); }
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
        else if (v.hidden) { label.textContent = `${drawerName} tekent — raad het woord`; mask.textContent = '❓❓❓'; }
        else {
          label.textContent = `${drawerName} tekent — raad het woord`;
          mask.textContent = [...v.mask].map((c) => (c === ' ' ? '  ' : c)).join(' ');
          const cnt = document.createElement('span');
          cnt.className = 'count';
          cnt.textContent = ` (${v.mask.split(' ').map((w) => [...w].filter((c) => c !== '-').length).join(', ')})`;
          mask.appendChild(cnt);
        }
      } else {
        label.textContent = 'Het woord was';
        mask.textContent = v.word || '';
      }

      // actions: rate, save, skip
      const canRate = !isDrawer && (v.phase === 'drawing' || v.phase === 'turnEnd');
      $('#btn-like').hidden = !canRate && !isDrawer;
      $('#btn-dislike').hidden = !canRate && !isDrawer;
      $('#btn-like').disabled = $('#btn-dislike').disabled = !canRate;
      $('#btn-like').classList.toggle('active', v.myRate > 0);
      $('#btn-dislike').classList.toggle('active', v.myRate < 0);
      $('#like-n').textContent = v.rates.up;
      $('#dislike-n').textContent = v.rates.down;
      $('#btn-save').hidden = v.phase === 'choosing';
      $('#btn-skip').hidden = !(this.isHost && (v.phase === 'choosing' || v.phase === 'drawing'));

      // overlay
      const ov = $('#board-overlay');
      const sub = $('#ov-sub');
      const title = $('#ov-title');
      const body = $('#ov-body');
      body.innerHTML = '';
      sub.textContent = '';
      if (v.phase === 'choosing') {
        ov.classList.add('show');
        sub.textContent = `Ronde ${Math.min(v.round, v.settings.rounds)} van ${v.settings.rounds}`;
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
        if (v.rates.up || v.rates.down) {
          const r = document.createElement('div');
          r.className = 'rate-sum';
          r.textContent = `Tekening: 👍 ${v.rates.up} · 👎 ${v.rates.down}`;
          body.appendChild(r);
        }
      } else ov.classList.remove('show');

      const canDraw = v.phase === 'drawing' && isDrawer;
      $('#toolbar').classList.toggle('show', canDraw);
      $('#canvas').classList.toggle('can-draw', canDraw);
      $('#canvas').classList.toggle('fill-cursor', canDraw && (Board.tool === 'fill' || Board.tool === 'picker'));
      $('#clock').classList.toggle('hidden', !(v.total && (v.phase === 'choosing' || v.phase === 'drawing')));
    },

    renderGameOver(v) {
      const sorted = v.players.filter((p) => p.on).sort((a, b) => b.score - a.score);
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
        step.innerHTML = `<span class="avatar huge"></span><div class="pn"></div><div class="ps">${p.score} pt</div><div class="block" style="height:${pl.h}px;background:${pl.c}">${pl.m}</div>`;
        const av = step.querySelector('.avatar');
        av.textContent = p.avatar.e;
        av.style.background = p.avatar.c;
        step.querySelector('.pn').textContent = p.name;
        pod.appendChild(step);
      }
      $('#btn-again').style.display = this.isHost ? '' : 'none';
      $('#again-wait').style.display = this.isHost ? 'none' : '';

      const gal = $('#gallery');
      gal.innerHTML = '';
      $('.gallery-title').style.display = this.gallery.length ? '' : 'none';
      for (const g of this.gallery) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<img alt=""><div class="meta"><div><b></b><span class="muted"></span></div><a title="Downloaden">💾</a></div>`;
        card.querySelector('img').src = g.img;
        card.querySelector('img').alt = `Tekening van ${g.word}`;
        card.querySelector('b').textContent = g.word;
        card.querySelector('.muted').textContent = `door ${g.drawer} · 👍 ${g.rates.up} 👎 ${g.rates.down}`;
        const a = card.querySelector('a');
        a.href = g.img;
        a.download = `tekening-${compact(g.word) || 'raad'}.jpg`;
        gal.appendChild(card);
      }
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
        case 'leave': sfx.leave(); break;
        case 'chat': sfx.chat(); break;
        case 'rate': sfx.like(); break;
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
  function showOverlay(text, canReconnect = false) {
    $('#overlay-text').textContent = text;
    $('#btn-reconnect').style.display = canReconnect ? '' : 'none';
    $('#overlay').classList.add('show');
  }
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
  // a per-tab token (survives reloads), so a player who reconnects gets their score back
  function myToken() {
    let t = null;
    try { t = sessionStorage.getItem('tekenraad-token'); } catch { /* ignore */ }
    if (!t) { t = randId(); try { sessionStorage.setItem('tekenraad-token', t); } catch { /* ignore */ } }
    return t;
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
        const mine = v && (v.phase === 'drawing' || v.phase === 'choosing') && v.drawerId === v.me;
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
      b.addEventListener('click', () => setColor(c));
      colors.appendChild(b);
    }
    $('#color-input').addEventListener('input', (e) => setColor(e.target.value));
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
      b.addEventListener('click', () => { Board.size = s; if (Board.tool === 'fill' || Board.tool === 'picker') setTool('pen'); paintToolbar(); });
      sizes.appendChild(b);
    });
    $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#btn-undo').addEventListener('click', () => Board.undo());
    $('#btn-redo').addEventListener('click', () => Board.redo());
    $('#btn-clear').addEventListener('click', () => Board.clearAll());
    paintToolbar();
  }
  function setColor(c) {
    Board.color = c.toLowerCase();
    if (Board.tool === 'eraser' || Board.tool === 'picker') Board.tool = 'pen';
    paintToolbar();
  }
  function setTool(t) {
    Board.tool = t;
    $('#canvas').classList.toggle('fill-cursor', t === 'fill' || t === 'picker');
    paintToolbar();
  }
  function paintToolbar() {
    const custom = !PALETTE.includes(Board.color);
    $$('.swatch').forEach((b) => b.classList.toggle('active', b.title === Board.color && Board.tool !== 'eraser'));
    $('.custom-color').classList.toggle('active', custom && Board.tool !== 'eraser');
    $('.custom-color').style.background = custom ? Board.color : '';
    $('#color-input').value = Board.color;
    $$('.tool.size').forEach((b) => b.classList.toggle('active', +b.dataset.size === Board.size));
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === Board.tool));
    $$('.tool.size .dot').forEach((d) => (d.style.background = Board.tool === 'eraser' ? '#bbb' : Board.color === '#ffffff' ? '#ddd' : Board.color));
  }

  // ------------------------------------------------------------------ avatar picker
  let avatar = (() => { try { return cleanAvatar(JSON.parse(store.get('tekenraad-avatar') || 'null')); } catch { return cleanAvatar(null); } })();
  function buildAvatarPicker() {
    const em = $('#av-emojis');
    for (const e of AVATAR_EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.addEventListener('click', () => { avatar.e = e; paintAvatar(); });
      em.appendChild(b);
    }
    const co = $('#av-colors');
    for (const c of AVATAR_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = c;
      b.dataset.c = c;
      b.title = 'Kleur';
      b.addEventListener('click', () => { avatar.c = c; paintAvatar(); });
      co.appendChild(b);
    }
    $('#av-preview').addEventListener('click', () => { avatar = cleanAvatar(null); paintAvatar(); });
    $('#av-preview').title = 'Klik voor een willekeurige avatar';
    paintAvatar();
  }
  function paintAvatar() {
    const pv = $('#av-preview');
    pv.textContent = avatar.e;
    pv.style.background = avatar.c;
    $$('#av-emojis button').forEach((b) => b.classList.toggle('active', b.textContent === avatar.e));
    $$('#av-colors button').forEach((b) => b.classList.toggle('active', b.dataset.c === avatar.c));
    store.set('tekenraad-avatar', JSON.stringify(avatar));
  }

  // ------------------------------------------------------------------ wiring
  function setup() {
    Board.init();
    buildToolbar();
    buildAvatarPicker();
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
      Host.open(name, avatar, (code) => {
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
      Client.join(code, name, avatar, (msg) => busy(false, msg));
    };
    $('#btn-join').addEventListener('click', doJoin);
    $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ($('#code-input').value.trim().length === 5 ? doJoin() : $('#btn-create').click());
    });
    $('#btn-reconnect').addEventListener('click', () => {
      location.href = location.pathname + '?room=' + Client.code + '&rejoin=1';
    });
    // after "Opnieuw verbinden": join straight away
    if (room && params.get('rejoin') && nameInput.value) {
      history.replaceState(null, '', '?room=' + room);
      setTimeout(doJoin, 50);
    }

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

    const settingIds = ['rounds', 'time', 'choices', 'hints', 'mode', 'max', 'builtin'];
    const sendSettings = () => {
      const m = { t: 'settings' };
      for (const k of settingIds) { const el = $('#set-' + k); m[k] = el.type === 'checkbox' ? el.checked : el.value; }
      Client.send(m);
    };
    settingIds.forEach((k) => $('#set-' + k).addEventListener('change', sendSettings));
    $('#btn-start').addEventListener('click', () => {
      initAudio();
      if (Client.wordsTouched) saveWords();
      Client.send({ t: 'start' });
    });
    $('#btn-again').addEventListener('click', () => Client.send({ t: 'again' }));

    // board actions
    $('#btn-like').addEventListener('click', () => Client.send({ t: 'rate', v: 1 }));
    $('#btn-dislike').addEventListener('click', () => Client.send({ t: 'rate', v: -1 }));
    $('#btn-skip').addEventListener('click', () => { if (confirm('Deze beurt overslaan?')) Client.send({ t: 'skip' }); });
    $('#btn-save').addEventListener('click', () => {
      const a = document.createElement('a');
      const v = Client.v;
      a.href = Board.canvas.toDataURL('image/png');
      a.download = `tekening-${compact(v && v.word) || 'raad'}.png`;
      a.click();
    });

    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const i = $('#chat-input');
      if (!i.value.trim()) return;
      Client.send({ t: 'chat', text: i.value });
      i.value = '';
    });

    // keyboard: shortcuts for the drawer; typing anywhere focuses the chat for guessers
    const TOOL_KEYS = { b: 'pen', p: 'pen', e: 'eraser', f: 'fill', l: 'line', r: 'rect', o: 'ellipse', i: 'picker' };
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const key = e.key.toLowerCase();
      if (Board.canDraw()) {
        if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) { e.preventDefault(); return Board.undo(); }
        if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); return Board.redo(); }
        if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[key]) return setTool(TOOL_KEYS[key]);
        if (!e.ctrlKey && !e.metaKey && key >= '1' && key <= '4') { Board.size = SIZES[+key - 1]; return paintToolbar(); }
        return;
      }
      const v = Client.v;
      if (v && v.phase === 'drawing' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) $('#chat-input').focus();
    });

    window.addEventListener('beforeunload', (e) => {
      if (Client.isHost && Host.S && Host.S.players.filter((p) => p.on).length > 1) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  setup();
})();
