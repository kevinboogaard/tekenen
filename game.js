/* Teken & Raad — multiplayer draw-and-guess via peer-to-peer (PeerJS).
 * The host's browser runs the game; other players connect with the room code.
 * Drawing is sent as small operations (stroke start, points, fill, shape, undo,
 * clear) in an 800x600 coordinate space, so every screen redraws the same picture. */
(() => {
  'use strict';

  const VERSION = 14; // keep in sync with the ?v= in index.html
  const PREFIX = 'tekenraad-nl-room-';
  // PeerJS's own defaults plus extra STUN servers, so more networks can connect directly.
  const PEER_OPTIONS = {
    debug: 1,
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
      ],
      sdpSemantics: 'unified-plan',
    },
  };
  const ALIVE_TIMEOUT_MS = 30000; // no message for this long: the host marks a player as gone
  const HOST_QUIET_MS = 12000; // no answer from the host for this long: a guest connects anew
  const JOIN_RETRY_MS = 4000;
  const CONNECT_TIMEOUT_MS = 15000;
  const RECONNECT_FOR_MS = 120000; // a guest who lost the host keeps trying this long
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
  const REACTIONS = ['😂', '🔥', '🤔', '💀', '😍', '👏', '🤯', '🙈'];
  const newStats = () => ({ fastest: 0, guesses: 0, wrong: 0, close: 0, likes: 0, dislikes: 0, reactions: 0, allGuessed: 0, unguessed: 0 });
  const MAX_WORDS_PER_PLAYER = 500;
  const DEFAULT_SETTINGS = { rounds: 2, time: 80, choices: 3, hints: 3, mode: 'normal', max: 12 };

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
      // someone joining on the end screen plays from the next game on, and isn't on this podium
      const late = this.S.phase === 'gameOver';
      this.S.players.push({ id, token: String(token || randId()), name, score: 0, on: true, late, avatar: cleanAvatar(avatar), words: [], stats: newStats() });
      this.lastSeen.set(id, Date.now());
      if (id !== 'host') {
        this.say(late ? `${name} doet mee en wacht op een nieuw spel` : `${name} doet mee`);
        this.event('join');
        if (this.S.phase !== 'lobby' && this.S.phase !== 'gameOver') this.S.queue.push(id);
      }
    },

    // a player who lost connection comes back with the same token: keep score
    restorePlayer(p, newId, avatar) {
      const old = p.id;
      const wasOn = p.on;
      p.id = newId;
      p.on = true;
      if (avatar) p.avatar = cleanAvatar(avatar);
      const S = this.S;
      S.queue = S.queue.map((x) => (x === old ? newId : x));
      S.guessedIds = S.guessedIds.map((x) => (x === old ? newId : x));
      if (S.drawerId === old) S.drawerId = newId;
      this.lastSeen.set(newId, Date.now());
      if (wasOn) return; // only the connection changed: nobody needs to hear about it
      this.say(`${p.name} is terug!`);
      this.event('join');
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
      // in the lobby a player stays on file (hidden) until the game starts: if they come back
      // their words are still there
      if (S.phase === 'choosing' || S.phase === 'drawing') {
        if (this.online().length < 2) return this.backToLobby('Te weinig spelers over — terug naar de lobby.');
        if (S.drawerId === id) return this.endTurn('drawerLeft');
        if (S.phase === 'drawing' && this.allGuessed()) return this.endTurn('all');
      }
      this.broadcast();
    },

    checkAlive() {
      const now = Date.now();
      for (const [id, t] of this.lastSeen) if (id !== 'host' && now - t > ALIVE_TIMEOUT_MS) this.removePlayer(id);
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
      for (const p of this.S.players) {
        if (this.S.phase === 'lobby' && !p.on) continue; // not back yet: don't count these words
        for (const w of p.words) {
          const k = compact(w);
          if (!seen.has(k)) { seen.add(k); out.push({ w, by: p.id }); }
        }
      }
      return out;
    },

    // Only the players' own words are used. Only when nobody entered any word
    // does the game fall back to the built-in list.
    pickWords() {
      const n = this.S.settings.choices;
      const pot = this.customPot().map((x) => x.w);
      const source = pot.length ? pot : window.BUILTIN_WORDS || [];
      const unused = shuffle(source.filter((w) => !this.used.has(compact(w))));
      // everyone draws from the same pot, including their own words; repeats only once it runs out
      const repeats = shuffle(source.filter((w) => this.used.has(compact(w))));
      return [...unused, ...repeats].slice(0, n);
    },

    // ---- flow
    startGame() {
      const S = this.S;
      if (S.phase !== 'lobby' || this.online().length < 2) return;
      S.players = S.players.filter((p) => p.on);
      S.players.forEach((p) => { p.score = 0; p.late = false; p.stats = newStats(); });
      S.awards = [];
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
      // ratings can still change during the turn-end screen, so count them only now
      const lastDrawer = this.p(S.drawerId);
      if (lastDrawer) {
        const r = this.rateCounts();
        lastDrawer.stats.likes += r.up;
        lastDrawer.stats.dislikes += r.down;
      }
      S.rates = {};
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
      Object.assign(S, { phase: 'choosing', drawerId: id, choices: this.pickWords(), word: '', revealed: [], hintsGiven: 0, guessedIds: [], rates: {}, result: null });
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
          const ms = S.timerTotal - (S.deadline - now);
          p.stats.guesses++;
          if (!p.stats.fastest || ms < p.stats.fastest) p.stats.fastest = Math.max(1, ms);
          const drawer = this.p(S.drawerId);
          if (drawer) drawer.score += 50;
          S.guessedIds.push(id);
          this.say(`${p.name} heeft het woord geraden! (+${pts})`, 'good');
          this.event('guessed', { by: id });
          if (this.allGuessed()) return this.endTurn('all');
          return this.broadcast();
        } else if (said) {
          p.stats.wrong++;
          if (target.length >= 4 && levenshtein(said, target) === 1) {
            p.stats.close++;
            this.toast(id, `"${text}" is bijna goed!`);
          }
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
    // floating emoji: sent straight to everyone, without a full state update
    react(id, e) {
      const S = this.S;
      const p = this.p(id);
      if ((S.phase !== 'drawing' && S.phase !== 'turnEnd') || !p || !REACTIONS.includes(e)) return;
      const now = Date.now();
      if (p.lastReact && now - p.lastReact < 250) return;
      p.lastReact = now;
      const drawer = this.p(S.drawerId);
      if (drawer && id !== S.drawerId) drawer.stats.reactions++;
      for (const o of this.online()) this.send(o.id, { t: 'react', e, from: p.name });
    },

    computeAwards() {
      const players = this.online();
      const out = [];
      const award = (icon, title, value, why, lowest = false) => {
        const scored = players.map((p) => ({ p, v: value(p.stats) })).filter((x) => x.v > 0);
        if (!scored.length) return;
        const top = (lowest ? Math.min : Math.max)(...scored.map((x) => x.v));
        out.push({ icon, title, who: scored.filter((x) => x.v === top).map((x) => x.p.name).join(' & '), why: why(top) });
      };
      award('⚡', 'Snelste rader', (s) => s.fastest, (v) => `geraden in ${(v / 1000).toFixed(1).replace('.', ',')} sec`, true);
      award('🎯', 'Scherpschutter', (s) => s.guesses, (v) => `${v}× goed geraden`);
      award('🎨', 'Picasso', (s) => s.likes, (v) => `${v}× 👍 gekregen`);
      award('🔥', 'Publiekslieveling', (s) => s.reactions, (v) => `${v} reactie${v === 1 ? '' : 's'} op tekeningen`);
      award('🖌️', 'Duidelijke taal', (s) => s.allGuessed, (v) => `${v}× raadde iedereen het`);
      award('🤷', 'Onbegrepen kunstenaar', (s) => s.unguessed, (v) => `${v}× raadde niemand het`);
      award('🙈', 'Moderne kunst', (s) => s.dislikes, (v) => `${v}× 👎 gekregen`);
      award('🤏', 'Net niet', (s) => s.close, (v) => `${v}× bijna goed`);
      award('🎲', 'Grootste gokker', (s) => s.wrong, (v) => `${v} foute gok${v === 1 ? '' : 'ken'}`);
      return out;
    },

    rateCounts() {
      const vals = Object.values(this.S.rates);
      return { up: vals.filter((v) => v > 0).length, down: vals.filter((v) => v < 0).length };
    },

    endTurn(reason) {
      const S = this.S;
      this.clearDeadline();
      const drawer = this.name(S.drawerId);
      const dp = this.p(S.drawerId);
      if (dp && reason === 'all') dp.stats.allGuessed++;
      if (dp && reason === 'time' && S.word && !S.guessedIds.length) dp.stats.unguessed++;
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
      this.S.awards = this.computeAwards();
      this.S.guessedIds = [];
      const playing = this.online().filter((p) => !p.late); // players who left or were kicked can't win
      const top = Math.max(...playing.map((p) => p.score));
      const winners = playing.filter((p) => p.score === top);
      if (winners.length === 1) this.say(`${winners[0].name} wint het spel met ${top} punten! 🏆`, 'good');
      else if (winners.length) this.say(`${winners.map((p) => p.name).join(' & ')} winnen samen met ${top} punten! 🏆`, 'good');
      this.event('gameover');
      this.broadcast();
    },

    backToLobby(msg) {
      this.clearDeadline();
      clearTimeout(this.turnEndTimer);
      const S = this.S;
      S.players = S.players.filter((p) => p.on);
      S.players.forEach((p) => (p.score = 0));
      Object.assign(S, { phase: 'lobby', awards: [], round: 0, queue: [], drawerId: null, choices: [], word: '', revealed: [], guessedIds: [], rates: {}, result: null });
      this.log = [];
      if (msg) this.say(msg);
      this.broadcast();
    },

    setSettings(s) {
      if (this.S.phase !== 'lobby') return;
      this.S.settings = {
        rounds: clampInt(s.rounds, 1, 10, 2),
        time: clampInt(s.time, 30, 180, 80),
        choices: clampInt(s.choices, 1, 10, 3),
        hints: clampInt(s.hints, 0, 5, 3),
        mode: s.mode === 'hidden' ? 'hidden' : 'normal',
        max: clampInt(s.max, 2, 16, 12),
      };
      this.broadcast();
    },

    handleJoin(id, m, conn) {
      const token = typeof m.token === 'string' ? m.token.slice(0, 64) : '';
      const refuse = (t) => { this.send(id, { t }); setTimeout(() => { try { conn && conn.close(); } catch { /* ignore */ } }, 400); };
      if (token && this.banned.has(token)) return refuse('kicked');
      if (this.p(id)) return;
      const back = token && this.S.players.find((p) => p.token === token && p.id !== 'host');
      if (back) {
        // Same tab reconnected, possibly before we noticed it was gone. Move the player to the
        // new connection first: closing the old one counts as leaving for whoever still holds it.
        const old = back.on ? this.conns.get(back.id) : null;
        this.conns.delete(back.id);
        this.lastSeen.delete(back.id);
        this.restorePlayer(back, id, m.avatar);
        try { old && old.close(); } catch { /* ignore */ }
      }
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
        case 'react': this.react(id, m.e); break;
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
        ver: VERSION,
        me: pid,
        phase: S.phase,
        players: S.players.map((p) => ({
          id: p.id, name: p.name, score: p.score, on: p.on, late: !!p.late, avatar: p.avatar,
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
        awards: S.phase === 'gameOver' ? S.awards || [] : [],
        rates: this.rateCounts(),
        myRate: S.rates[pid] || 0,
        myVotes: Object.keys(S.kickVotes).filter((t) => S.kickVotes[t].includes(pid)),
        myWords: me && S.phase === 'lobby' ? me.words : [], // up to 500 words: only needed in the lobby
        pot: this.customPot().length,
      };
    },
    send(id, msg) {
      if (id === 'host') return Client.receive(msg);
      const c = this.conns.get(id);
      if (c && c.open) { try { c.send(msg); } catch { /* ignore */ } }
    },
    toast(id, text) { this.send(id, { t: 'toast', text }); },
    broadcast() {
      for (const p of this.S.players) if (p.on) this.send(p.id, this.view(p.id));
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 500);
    },

    // Keep the room in this tab's storage, so a refresh by the host doesn't end it.
    save() {
      if (!this.code) return;
      const S = this.S;
      try {
        sessionStorage.setItem(HOST_KEY, JSON.stringify({
          code: this.code,
          settings: S.settings,
          banned: [...this.banned],
          players: S.players.map(({ token, name, avatar, words }) => ({ token, name, avatar, words })),
        }));
      } catch { /* storage full or blocked: only the refresh recovery is lost */ }
    },
    restore(saved) {
      const S = this.S;
      if (saved.settings) S.settings = { ...S.settings, ...saved.settings };
      this.banned = new Set(saved.banned || []);
      for (const sp of saved.players || []) {
        if (sp.token === 'host') { S.players[0].words = sp.words || []; continue; }
        // offline until they reconnect with their token; dropped at the next game start otherwise
        S.players.push({ id: 'old-' + sp.token, token: sp.token, name: sp.name, score: 0, on: false, late: false, avatar: cleanAvatar(sp.avatar), words: sp.words || [], stats: newStats() });
      }
      this.say('De host heeft de pagina ververst — terug in de lobby.');
    },

    // The link to the PeerJS server is only needed so that NEW players can find this room.
    // Current players stay connected without it, so keep trying calmly in the background.
    scheduleReconnect(peer) {
      setBanner('⚠️ Geen verbinding met de spelserver: nieuwe spelers kunnen even niet meedoen. Wordt hersteld…');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.reconnectNow(peer), 2000);
    },
    reconnectNow(peer = this.peer) {
      if (!peer || peer.destroyed || !peer.disconnected) return;
      clearTimeout(this.reconnectTimer);
      try { peer.reconnect(); } catch { /* the next 'disconnected' event tries again */ }
    },
    // A player we had written off (e.g. a frozen phone tab) is talking again on the same connection.
    revive(p, conn) {
      this.conns.set(conn.peer, conn);
      this.restorePlayer(p, conn.peer);
      this.broadcast();
      this.send(conn.peer, { t: 'sync', turn: this.S.turnNo, log: this.log });
    },

    open(name, avatar, onReady, onError, resume = null) {
      this.init(name, avatar);
      if (resume) this.restore(resume);
      let attempts = 0;
      const tryOpen = () => {
        const code = resume ? resume.code : makeCode();
        const peer = new Peer(PREFIX + code, PEER_OPTIONS);
        peer.on('open', () => {
          this.peer = peer;
          this.code = code;
          setBanner('');
          onReady(code);
        });
        peer.on('error', (err) => {
          if (this.peer) return console.warn('peer error', err);
          // after a refresh the server can hold on to the old room id for a little while
          if (err.type === 'unavailable-id' && attempts++ < (resume ? 20 : 5)) {
            peer.destroy();
            setTimeout(tryOpen, resume ? 3000 : 0);
          } else onError(err);
        });
        peer.on('disconnected', () => { if (this.peer === peer) this.scheduleReconnect(peer); });
        peer.on('connection', (conn) => {
          conn.on('data', (m) => {
            if (m && m.t === 'join') this.conns.set(conn.peer, conn);
            else {
              const p = this.p(conn.peer);
              if (p && !p.on && !this.banned.has(p.token)) this.revive(p, conn);
            }
            this.handle(conn.peer, m, conn);
          });
          conn.on('close', () => this.removePlayer(conn.peer));
          conn.on('error', (err) => console.warn('connection error', err)); // the alive check decides who is gone
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
    paint(item) { paintItem(this.ctx, item); },
    strokePts(c, s, p, from) { drawStroke(this.ctx, c, s, p, from); },

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

  function paintItem(ctx, item) {
    if (item.k === 'stroke') drawStroke(ctx, item.c, item.s, item.p, 0);
    else if (item.k === 'fill') floodFill(ctx, item.x, item.y, item.c);
    else if (item.k === 'shape') drawShape(ctx, item);
  }
  // Draws stroke points from coordinate index `from` onward (0 = the whole stroke).
  function drawStroke(ctx, c, s, p, from) {
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
  }

  // ================================================================== REPLAY
  // Plays a finished drawing back stroke by stroke from its operation log.
  const Replay = {
    ctx: null,
    list: [],
    index: 0,
    item: 0,
    drawn: 0, // points of the current stroke already drawn
    spent: 0,
    total: 0,
    elapsed: 0,
    duration: 0,
    last: 0,
    speed: 1,
    paused: false,
    raf: 0,
    nextTimer: 0,

    weight(it) { return it.k === 'stroke' ? Math.max(1, it.p.length / 2) : 12; },
    open(list) {
      this.list = list.filter((g) => g.log && g.log.length);
      if (!this.list.length) return;
      this.ctx = this.ctx || $('#replay-canvas').getContext('2d', { willReadFrequently: true });
      $('#replay').classList.add('show');
      this.play(0);
    },
    play(i) {
      this.stop();
      this.index = i;
      const g = this.list[i];
      $('#replay-word').textContent = g.word;
      $('#replay-by').textContent = `door ${g.drawer}${this.list.length > 1 ? ` · ${i + 1} van ${this.list.length}` : ''}`;
      $('#replay-next').hidden = i >= this.list.length - 1;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, W, H);
      this.item = this.drawn = this.spent = this.elapsed = 0;
      this.total = g.log.reduce((n, it) => n + this.weight(it), 0);
      this.duration = Math.min(12000, Math.max(2500, this.total * 14)); // always watchable, never endless
      this.paused = false;
      $('#replay-pause').textContent = '⏸️';
      $('#replay-bar').style.width = '0';
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    },
    frame(now) {
      const g = this.list[this.index];
      if (!this.paused) this.elapsed += (now - this.last) * this.speed;
      this.last = now;
      const target = (this.elapsed / this.duration) * this.total;
      while (this.item < g.log.length && this.spent < target) {
        const it = g.log[this.item];
        if (it.k === 'stroke') {
          const n = Math.max(1, it.p.length / 2);
          const upto = Math.min(n, this.drawn + Math.ceil(target - this.spent));
          drawStroke(this.ctx, it.c, it.s, it.p.slice(0, upto * 2), this.drawn * 2);
          this.spent += upto - this.drawn;
          this.drawn = upto;
          if (this.drawn >= n) { this.item++; this.drawn = 0; }
        } else {
          paintItem(this.ctx, it);
          this.spent += 12;
          this.item++;
        }
      }
      $('#replay-bar').style.width = Math.min(100, (this.spent / this.total) * 100) + '%';
      if (this.item < g.log.length) { this.raf = requestAnimationFrame((t) => this.frame(t)); return; }
      this.raf = 0;
      $('#replay-pause').textContent = '▶️';
      if (this.index < this.list.length - 1) this.nextTimer = setTimeout(() => this.play(this.index + 1), 1500);
    },
    togglePause() {
      if (!this.raf) return this.play(this.index); // finished: play it again
      this.paused = !this.paused;
      $('#replay-pause').textContent = this.paused ? '▶️' : '⏸️';
    },
    cycleSpeed() {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      $('#replay-speed').textContent = this.speed + '×';
    },
    stop() {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.nextTimer);
      this.raf = 0;
    },
    close() {
      this.stop();
      $('#replay').classList.remove('show');
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
    // The soft edge of a line is a blend of the line colour and the OLD background, so it would
    // stay behind as a thin rim. Re-blend those edge pixels with the new fill colour instead.
    const dist = (i) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb);
    const edits = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const pi = y * W + x;
        if (seen[pi]) continue;
        let touchesFill = false;
        let far = 0; // the neighbour least like the old background: the pure line colour
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (seen[ni]) touchesFill = true;
            else far = Math.max(far, dist(ni * 4));
          }
        }
        if (!touchesFill) continue;
        const own = dist(pi * 4);
        if (far <= own) continue; // already pure line colour
        const share = 1 - own / far; // how much of this pixel was old background
        edits.push(pi * 4, d[pi * 4] + (fr - tr) * share, d[pi * 4 + 1] + (fg - tg) * share, d[pi * 4 + 2] + (fb - tb) * share);
      }
    }
    for (let k = 0; k < edits.length; k += 4) {
      const i = edits[k];
      d[i] = edits[k + 1]; d[i + 1] = edits[k + 2]; d[i + 2] = edits[k + 3]; // the pixel array clamps to 0–255
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

    // One connection attempt. Reports 'notfound' (no such room right now), 'timeout' (the room
    // exists but no connection comes up: usually the network) or 'server' (spelserver unreachable).
    connect(onOpen, onFail) {
      const peer = new Peer(PEER_OPTIONS);
      let settled = false;
      let signalled = false;
      const fail = (kind) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        onFail(kind);
      };
      const timer = setTimeout(() => fail(signalled ? 'timeout' : 'server'), CONNECT_TIMEOUT_MS);
      peer.on('error', (err) => fail(err.type === 'peer-unavailable' ? 'notfound' : 'server'));
      peer.on('open', () => {
        signalled = true;
        const conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          settled = true;
          clearTimeout(timer);
          this.lastPong = Date.now();
          conn.send({ t: 'join', name: this.joinName, avatar: this.joinAvatar, token: myToken() });
          // The old connection goes only now: the host hands our place straight to this new one.
          // Dropping it first would make us "leave", which ends a two-player game.
          const old = this.peer;
          this.peer = peer;
          try { old && old.destroy(); } catch { /* ignore */ }
          onOpen();
        });
        conn.on('data', (m) => { if (this.conn === conn) this.receive(m); });
        conn.on('close', () => { if (this.conn === conn && settled) this.connectionLost(); });
      });
    },

    // First join: a room can be unreachable for a moment (host just switched apps, or refreshed),
    // so try a few times before telling the player something is wrong.
    join(code, name, avatar, onError, onStatus) {
      this.code = code;
      this.joinName = name;
      this.joinAvatar = avatar;
      this.onJoinError = onError;
      this.gone = false;
      const MESSAGES = {
        notfound: 'Kamer niet gevonden. Klopt de code, en heeft de host het spel nog open? Op een telefoon moet de host de browser open houden.',
        timeout: 'De kamer bestaat, maar de verbinding komt niet tot stand. Dit ligt meestal aan het netwerk (bijv. werk-wifi): probeer een ander netwerk of mobiele data.',
        server: 'Geen verbinding met de spelserver. Controleer je internet en probeer het opnieuw.',
      };
      const attempt = (n) => {
        onStatus(n === 1 ? 'Verbinden…' : `Kamer zoeken… (poging ${n} van 5)`);
        this.connect(() => {
          try { sessionStorage.setItem(JOINED_KEY, code); } catch { /* ignore */ }
          this.startPing();
        }, (kind) => {
          // a timeout already took 15 seconds, so don't repeat that as often
          if (n < (kind === 'timeout' ? 2 : 5)) setTimeout(() => attempt(n + 1), JOIN_RETRY_MS);
          else onError(MESSAGES[kind]);
        });
      };
      attempt(1);
    },

    startPing() {
      if (this.pingTimer) return;
      this.pingTimer = setInterval(() => this.checkHost(), 5000);
    },
    checkHost() {
      if (this.gone || this.reconnecting) return;
      this.send({ t: 'ping' });
      if (Date.now() - this.lastPong <= HOST_QUIET_MS) return;
      // quiet for a while (e.g. this tab was frozen): the connection may still be fine, so give
      // the ping a moment to get an answer before building a new one
      clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        if (Date.now() - this.lastPong > HOST_QUIET_MS) this.connectionLost();
      }, 3000);
    },

    // Lost the host mid-game: retry on our own. The host recognises our token, so the score stays.
    connectionLost() {
      if (this.isHost || this.gone || this.reconnecting) return;
      this.reconnecting = true;
      this.conn = null;
      const until = Date.now() + RECONNECT_FOR_MS;
      setBanner('🔄 Verbinding met de host herstellen…');
      const retry = () => {
        if (this.gone) return setBanner('');
        if (Date.now() > until) {
          this.reconnecting = false;
          setBanner('');
          return this.lost();
        }
        this.connect(() => {
          this.reconnecting = false;
          setBanner('');
          // the host may have dropped us, words and all: hand over what is in the box again
          const words = parseWords($('#words-input').value);
          if (words.length) this.send({ t: 'words', list: words });
        }, () => setTimeout(retry, JOIN_RETRY_MS));
      };
      retry();
    },

    lost(text) {
      if (this.isHost || this.gone) return;
      this.gone = true;
      setBanner('');
      showOverlay(text || 'De verbinding met de host is verbroken. Misschien heeft de host het spel gesloten.', !text);
    },

    receive(m) {
      if (!m) return;
      this.lastPong = Date.now();
      switch (m.t) {
        case 'toast': return toast(m.text);
        case 'react': return spawnReaction(m.e, m.from);
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

      // the host's browser runs the rules (e.g. the word limit): warn if it runs an older version
      if (!this.isHost && !this.versionWarned && (v.ver || 0) < VERSION) {
        this.versionWarned = true;
        const warn = () => toast('⚠️ De host gebruikt een oude versie van het spel. Vraag de host de pagina te verversen (Ctrl+F5) en een nieuw spel te maken.');
        warn();
        setTimeout(warn, 3000);
      }

      // keep a picture of every finished drawing for the gallery
      if (prev && prev.phase === 'drawing' && v.phase === 'turnEnd' && v.result && v.result.word) this.snapshot(v);
      if (prev && (prev.phase === 'lobby' || prev.phase === 'gameOver') && v.phase !== 'lobby' && v.phase !== 'gameOver') this.gallery = [];
      if (prev && prev.phase === 'turnEnd' && prev.turnNo === v.turnNo && this.gallery.length) {
        const last = this.gallery[this.gallery.length - 1];
        if (last.turn === v.turnNo) last.rates = v.rates;
      }

      if (v.turnNo !== Board.turn) Board.reset(v.turnNo);
      if (v.phase !== 'gameOver') Replay.close();

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

      updateGuessCount();
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
          log: clone(Board.log),
          rates: v.rates,
        });
      } catch { /* ignore */ }
    },

    renderPlayers(v) {
      const ol = $('#player-list');
      ol.innerHTML = '';
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const rankOf = tiedRanks(sorted);
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
        `${s.choices} woordoptie${s.choices > 1 ? 's' : ''} per beurt · ${s.rounds} ronde${s.rounds > 1 ? 's' : ''} · ${s.time} sec tekenen`,
        `${s.mode === 'hidden' ? 'Verborgen woorden' : `${s.hints} hint${s.hints === 1 ? '' : 's'}`} · max ${s.max} spelers`,
      ];
      for (const l of lines) { const p = document.createElement('p'); p.textContent = l; $('#guest-wait').appendChild(p); }
      $('#share-link').value = shareLink(this.code);
      const ta = $('#words-input');
      if (!this.wordsTouched && document.activeElement !== ta && v.myWords.length) ta.value = v.myWords.join(', ');
      $('#words-saved').textContent = v.myWords.length ? `✓ ${v.myWords.length} / ${MAX_WORDS_PER_PLAYER} woorden opgeslagen` : `max. ${MAX_WORDS_PER_PLAYER} woorden`;
      $('#pot-info').textContent = v.pot
        ? `🫙 Woordenpot: ${v.pot} woord${v.pot === 1 ? '' : 'en'} — alleen deze woorden worden getekend`
        : '🫙 Woordenpot is leeg — er worden ingebouwde woorden gebruikt';
      const enough = v.players.filter((p) => p.on).length >= 2;
      $('#btn-start').disabled = !enough;
      $('#start-hint').textContent = enough ? '' : 'Minimaal 2 spelers nodig.';
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

      $('#reactions').classList.toggle('show', v.phase === 'drawing' || v.phase === 'turnEnd');

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
      paintCursor();
      $('#clock').classList.toggle('hidden', !(v.total && (v.phase === 'choosing' || v.phase === 'drawing')));
    },

    renderGameOver(v) {
      const sorted = v.players.filter((p) => p.on && !p.late).sort((a, b) => b.score - a.score);
      const meLate = (v.players.find((p) => p.id === v.me) || {}).late;
      const pod = $('#podium');
      pod.innerHTML = '';
      const ranks = tiedRanks(sorted);
      const PLACES = { 1: { h: 150, c: '#ffd23f' }, 2: { h: 110, c: '#cfd6de' }, 3: { h: 80, c: '#e0a370' } };
      // silver on the left, gold in the middle, bronze on the right; ties stand side by side
      const atPlace = (n) => sorted.filter((p) => ranks.get(p.id) === n);
      for (const p of [...atPlace(2), ...atPlace(1), ...atPlace(3)]) {
        const place = ranks.get(p.id);
        const pl = PLACES[place];
        const step = document.createElement('div');
        step.className = 'step';
        step.innerHTML = `<span class="avatar huge"></span><div class="pn"></div><div class="ps">${p.score} pt</div><div class="block" style="height:${pl.h}px;background:${pl.c}">${place}</div>`;
        const av = step.querySelector('.avatar');
        av.textContent = p.avatar.e;
        av.style.background = p.avatar.c;
        step.querySelector('.pn').textContent = p.name;
        pod.appendChild(step);
      }
      $('#btn-again').style.display = this.isHost ? '' : 'none';
      $('#again-wait').style.display = this.isHost ? 'none' : '';
      $('#again-wait').textContent = meLate
        ? 'Dit spel is net afgelopen. Je doet mee zodra de host een nieuw spel start.'
        : 'Wachten tot de host een nieuw spel start…';

      const awards = $('#awards');
      awards.innerHTML = '';
      for (const a of v.awards) {
        const el = document.createElement('div');
        el.className = 'award';
        el.innerHTML = '<span class="award-icon"></span><div class="award-text"><div class="award-title"></div><div class="award-who"></div><div class="award-why"></div></div>';
        el.querySelector('.award-icon').textContent = a.icon;
        el.querySelector('.award-title').textContent = a.title;
        el.querySelector('.award-who').textContent = a.who;
        el.querySelector('.award-why').textContent = a.why;
        awards.appendChild(el);
      }

      const gal = $('#gallery');
      gal.innerHTML = '';
      $('.gallery-head').style.display = this.gallery.length ? '' : 'none';
      $('#btn-replay-all').style.display = this.gallery.filter((g) => g.log.length).length > 1 ? '' : 'none';
      for (const g of this.gallery) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<button class="thumb" title="Terugkijken"><img alt=""><span class="play-badge">▶</span></button><div class="meta"><div><b></b><span class="muted"></span></div><a title="Downloaden">💾</a></div>`;
        const thumb = card.querySelector('.thumb');
        if (g.log.length) thumb.addEventListener('click', () => Replay.open([g]));
        else { thumb.disabled = true; thumb.title = 'Niets getekend'; thumb.querySelector('.play-badge').remove(); }
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
  // Letters typed so far against the length of the word, shown while guessing.
  function updateGuessCount() {
    const el = $('#guess-count');
    const v = Client.v;
    const me = v && v.players.find((p) => p.id === v.me);
    const guessing = v && me && v.phase === 'drawing' && v.drawerId !== v.me && !me.guessed;
    el.hidden = !guessing;
    if (!guessing) return;
    const typed = [...$('#chat-input').value].filter(isLetter).length;
    // the "verborgen" mode keeps the length secret, so there it only counts what you typed
    const total = v.hidden ? 0 : [...v.mask].filter((c) => c === '_' || isLetter(c)).length;
    el.textContent = total ? `${typed}/${total}` : String(typed);
    el.classList.toggle('match', !!total && typed === total);
    el.classList.toggle('over', !!total && typed > total);
  }
  // Equal scores share a place: 335, 335, 100 gives places 1, 1, 3.
  function tiedRanks(sorted) {
    const ranks = new Map();
    sorted.forEach((p, i) => ranks.set(p.id, i > 0 && p.score === sorted[i - 1].score ? ranks.get(sorted[i - 1].id) : i + 1));
    return ranks;
  }
  // Cursors are drawn here so the point that really draws (the hotspot) is known on every
  // system, and they show the chosen colour. Returned as a PNG, which all browsers accept.
  const cursorCache = {};
  function toolCursor(tool, color) {
    const key = tool + color;
    if (cursorCache[key]) return cursorCache[key];
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const x = cv.getContext('2d');
    x.lineWidth = 1.6;
    x.lineJoin = 'round';
    x.strokeStyle = '#23262b';
    const shape = (fill, draw) => { x.beginPath(); draw(); x.fillStyle = fill; x.fill(); x.stroke(); };
    if (tool === 'pen') {
      // a pencil with its point in the bottom-left corner
      x.translate(2, 30);
      x.rotate(-Math.PI / 4);
      shape(color, () => x.rect(9, -4.5, 21, 9));
      shape('#ff9db4', () => x.rect(30, -4.5, 6, 9));
      shape('#f5d6a0', () => { x.moveTo(0, 0); x.lineTo(9, -4.5); x.lineTo(9, 4.5); x.closePath(); });
      shape(color, () => { x.moveTo(0, 0); x.lineTo(3.5, -1.75); x.lineTo(3.5, 1.75); x.closePath(); });
    } else if (tool === 'eraser') {
      // an eraser with its rubbing end in the bottom-left corner
      x.translate(5, 27);
      x.rotate(-Math.PI / 4);
      shape('#6ec6ff', () => x.rect(9, -7, 17, 14));
      shape('#ff9db4', () => x.rect(0, -7, 9, 14));
    } else {
      // a tipped bucket, pouring a drop that lands on the bottom-left corner
      x.save();
      x.translate(19, 13);
      x.rotate(-Math.PI / 4);
      x.beginPath();
      x.arc(0, -5, 8, Math.PI, 0);
      x.stroke();
      shape('#dfe3ea', () => { x.moveTo(-8, -5); x.lineTo(8, -5); x.lineTo(6, 11); x.lineTo(-6, 11); x.closePath(); });
      shape(color, () => x.ellipse(0, -5, 8, 3, 0, 0, Math.PI * 2));
      x.restore();
      shape(color, () => { x.moveTo(5, 16); x.quadraticCurveTo(10, 23, 8.6, 26.5); x.arc(5, 25, 4, 0.4, Math.PI - 0.4); x.quadraticCurveTo(0, 23, 5, 16); });
    }
    cursorCache[key] = cv.toDataURL('image/png');
    return cursorCache[key];
  }
  function paintCursor() {
    const c = Board.canvas;
    if (!c) return;
    const hotspot = { pen: '2 30', fill: '5 29', eraser: '5 27' }[Board.tool];
    c.style.cursor = Board.canDraw() && hotspot ? `url("${toolCursor(Board.tool, Board.color)}") ${hotspot}, crosshair` : '';
  }
  function setBanner(text) {
    const b = $('#net-banner');
    b.textContent = text;
    b.classList.toggle('show', !!text);
  }
  function showOverlay(text, canReconnect = false) {
    $('#overlay-text').textContent = text;
    $('#btn-reconnect').style.display = canReconnect ? '' : 'none';
    $('#overlay').classList.add('show');
  }
  function spawnReaction(e, from) {
    const wrap = $('.canvas-wrap');
    if (!wrap || wrap.querySelectorAll('.float-react').length >= 40) return; // keep the drawing visible
    const el = document.createElement('div');
    el.className = 'float-react';
    el.textContent = e;
    el.style.left = 6 + Math.random() * 78 + '%';
    el.style.setProperty('--sway', (Math.random() > 0.5 ? 1 : -1) * (8 + Math.random() * 22) + 'px');
    const who = document.createElement('span');
    who.textContent = from;
    el.appendChild(who);
    wrap.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    sfx.like();
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
  // Browsers copy a tab's sessionStorage when it is duplicated or opened from another tab, so
  // the copy would pretend to be the same player and push the original out of the game. Only a
  // tab that really unloaded itself (a refresh) may keep its identity: pagehide leaves a mark.
  const HOST_KEY = 'tekenraad-host';
  const JOINED_KEY = 'tekenraad-joined';
  const TOKEN_KEY = 'tekenraad-token';
  const UNLOAD_KEY = 'tekenraad-unloaded';
  function claimTabIdentity() {
    let reloaded = false;
    try {
      reloaded = sessionStorage.getItem(UNLOAD_KEY) === '1';
      sessionStorage.removeItem(UNLOAD_KEY);
      if (!reloaded) [TOKEN_KEY, HOST_KEY, JOINED_KEY].forEach((k) => sessionStorage.removeItem(k));
      window.addEventListener('pagehide', () => {
        try { Host.save(); sessionStorage.setItem(UNLOAD_KEY, '1'); } catch { /* ignore */ }
      });
      // back in view from the browser's page cache: this tab never really left
      window.addEventListener('pageshow', (e) => {
        if (e.persisted) { try { sessionStorage.removeItem(UNLOAD_KEY); } catch { /* ignore */ } }
      });
    } catch { /* storage blocked: every load is simply a new player */ }
    return reloaded;
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
    paintCursor();
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
    const reloaded = claimTabIdentity();
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
      openRoom(name);
    });
    const openRoom = (name, resume = null) => {
      Client.isHost = true;
      Host.open(name, avatar, (code) => {
        Client.code = code;
        history.replaceState(null, '', '?room=' + code);
        $('#home-error').textContent = '';
        Host.broadcast();
      }, (err) => {
        try { sessionStorage.removeItem(HOST_KEY); } catch { /* ignore */ }
        busy(false, resume
          ? 'Kon de kamer niet terugkrijgen. Maak een nieuw spel.'
          : 'Kon geen kamer aanmaken (' + err.type + '). Probeer opnieuw.');
        Client.isHost = false;
      }, resume);
    };

    const doJoin = () => {
      const name = getName();
      if (!name) return;
      const code = $('#code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) { $('#home-error').textContent = 'De code heeft 5 tekens.'; return; }
      if (noPeer()) return;
      initAudio();
      busy(true, 'Verbinden…');
      Client.join(code, name, avatar, (msg) => busy(false, msg), (status) => busy(true, status));
    };
    $('#btn-join').addEventListener('click', doJoin);
    $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ($('#code-input').value.trim().length === 5 ? doJoin() : $('#btn-create').click());
    });
    $('#btn-reconnect').addEventListener('click', () => {
      location.href = location.pathname + '?room=' + Client.code + '&rejoin=1';
    });
    // A refresh shouldn't cost anyone their place: the host reopens the same room, a guest rejoins.
    let savedRoom = null;
    let joinedRoom = null;
    try {
      savedRoom = JSON.parse(sessionStorage.getItem(HOST_KEY) || 'null');
      joinedRoom = sessionStorage.getItem(JOINED_KEY);
    } catch { /* ignore */ }
    if (reloaded && room && savedRoom && savedRoom.code === room && typeof Peer !== 'undefined') {
      const me = (savedRoom.players || []).find((p) => p.token === 'host');
      busy(true, 'Kamer opnieuw openen…');
      openRoom((me && me.name) || nameInput.value, savedRoom);
      const s = savedRoom.settings || {};
      for (const k of ['rounds', 'time', 'choices', 'hints', 'mode', 'max']) if (s[k] !== undefined) $('#set-' + k).value = String(s[k]);
    } else if (room && nameInput.value && (params.get('rejoin') || (reloaded && joinedRoom === room))) {
      history.replaceState(null, '', '?room=' + room);
      setTimeout(doJoin, 50);
    }

    // back in view (phone app switch, sleeping tab): check the connection straight away
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Client.isHost) Host.reconnectNow();
      else if (Client.conn) Client.checkHost();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);

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
    // Words go to the host while typing: the host can press start at any moment.
    let wordsTimer;
    const sendWords = () => {
      clearTimeout(wordsTimer);
      const list = parseWords($('#words-input').value);
      Client.send({ t: 'words', list });
      return list;
    };
    const saveWords = () => {
      const list = sendWords();
      Client.wordsTouched = false;
      $('#words-input').value = list.join(', ');
      toast(list.length ? `${list.length} woord${list.length === 1 ? '' : 'en'} opgeslagen` : 'Woorden gewist');
    };
    $('#btn-words').addEventListener('click', saveWords);
    $('#words-input').addEventListener('input', () => {
      Client.wordsTouched = true;
      clearTimeout(wordsTimer);
      wordsTimer = setTimeout(sendWords, 400);
    });
    $('#words-input').addEventListener('blur', () => { if (Client.wordsTouched) saveWords(); });

    const settingIds = ['rounds', 'time', 'choices', 'hints', 'mode', 'max'];
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

    // live reactions
    for (const e of REACTIONS) {
      const b = document.createElement('button');
      b.textContent = e;
      b.title = 'Reageer met ' + e;
      b.addEventListener('click', () => Client.send({ t: 'react', e }));
      $('#reactions').appendChild(b);
    }

    // replay
    $('#btn-replay-all').addEventListener('click', () => Replay.open(Client.gallery));
    $('#replay-close').addEventListener('click', () => Replay.close());
    $('#replay-restart').addEventListener('click', () => Replay.play(Replay.index));
    $('#replay-pause').addEventListener('click', () => Replay.togglePause());
    $('#replay-speed').addEventListener('click', () => Replay.cycleSpeed());
    $('#replay-next').addEventListener('click', () => Replay.play(Replay.index + 1));
    $('#replay').addEventListener('click', (e) => { if (e.target.id === 'replay') Replay.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') Replay.close(); });

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
      updateGuessCount();
    });
    $('#chat-input').addEventListener('input', updateGuessCount);

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
