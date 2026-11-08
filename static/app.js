(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const code = (location.pathname.split("/").pop() || "").toUpperCase();

  const overlay = $("#join");
  const nameInput = $("#name");
  const joinBtn = $("#joinBtn");
  const playersEl = $("#players");
  const countEl = $("#count");
  const stepsEl = $("#steps");
  const padsEl = $("#pads");
  const statusEl = $("#status");
  const joinCodeEl = $("#code");
  const invitePanel = $("#invitePanel");
  const qrImg = $("#qr");
  const shareLink = $("#shareLink");

  if (joinCodeEl) joinCodeEl.textContent = code;

  const ADJ = ["warm", "wild", "lucky", "brave", "sunny", "quiet", "rapid", "golden", "cosmic", "fuzzy", "electric", "midnight", "velvet", "neon", "salty", "crimson", "amber", "lunar", "breezy", "spicy"];
  const NOUN = ["otter", "comet", "ember", "panda", "harbor", "falcon", "cactus", "mango", "koala", "river", "sparrow", "pepper", "gecko", "willow", "tiger", "pixel", "raven", "maple", "orca", "fox"];
  const randomName = () => ADJ[Math.floor(Math.random() * ADJ.length)] + "-" + NOUN[Math.floor(Math.random() * NOUN.length)];

  let name = (localStorage.getItem("campfire.name") || "").trim() || randomName();
  if (nameInput) nameInput.value = name;

  let ws = null;
  let joined = false;
  let myId = null;
  let bpm = 120;
  let loopMs = 2000;
  let stepMs = 125;
  let offset = 0;
  let bestRtt = Infinity;
  let synced = false;
  let pingTimer = null;
  let reconnectTimer = null;
  let lastStep = -1;

  // ---------- audio ----------
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  const sfx = [];

  function ensureAudio() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -14;
    master.knee.value = 20;
    master.ratio.value = 8;
    master.attack.value = 0.003;
    master.release.value = 0.25;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    master.connect(out).connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    sfx.push(kick, snare, hat, clap, tom, zap);
    if (ctx.state === "suspended") ctx.resume();
  }

  function env(t, peak, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    return g;
  }

  function noiseSrc() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    return src;
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.32);
  }

  function snare(t) {
    const n = noiseSrc();
    const bp = ctx.createBiquadFilter();
    const g = env(t, 0.6, 0.2);
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    n.connect(bp).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.22);

    const o = ctx.createOscillator();
    const g2 = env(t, 0.35, 0.12);
    o.type = "triangle";
    o.frequency.setValueAtTime(190, t);
    o.connect(g2).connect(master);
    o.start(t);
    o.stop(t + 0.14);
  }

  function hat(t) {
    const n = noiseSrc();
    const hp = ctx.createBiquadFilter();
    const g = env(t, 0.28, 0.06);
    hp.type = "highpass";
    hp.frequency.value = 7500;
    n.connect(hp).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.08);
  }

  function clap(t) {
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.012;
      const n = noiseSrc();
      const bp = ctx.createBiquadFilter();
      const g = env(at, 0.45, 0.08);
      bp.type = "bandpass";
      bp.frequency.value = 1250;
      bp.Q.value = 1.4;
      n.connect(bp).connect(g).connect(master);
      n.start(at);
      n.stop(at + 0.1);
    }
  }

  function tom(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(250, t);
    o.frequency.exponentialRampToValueAtTime(105, t + 0.2);
    g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.28);
  }

  function zap(t) {
    const o = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(1300, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.13);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.8;
    o.connect(bp).connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.18);
  }

  function play(inst, at) {
    if (!ctx) return;
    const delay = Math.max(0, at - (Date.now() + offset)) / 1000;
    const fn = sfx[inst] || kick;
    fn(ctx.currentTime + delay);
  }

  // ---------- steps strip ----------
  for (let i = 0; i < 16; i++) {
    const dot = document.createElement("div");
    dot.className = "step";
    stepsEl.appendChild(dot);
  }
  const stepDots = Array.from(stepsEl.children);

  function tick() {
    if (synced) {
      const serverNow = Date.now() + offset;
      const phase = ((serverNow % loopMs) + loopMs) % loopMs;
      const idx = Math.floor(phase / stepMs);
      if (idx !== lastStep) {
        stepDots.forEach((dot, i) => dot.classList.toggle("on", i === idx));
        lastStep = idx;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- networking ----------
  function setStatus(text) {
    statusEl.textContent = text;
  }

  function ping() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
    }
  }

  function connect() {
    if (!joined) return;
    clearTimeout(reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`;
    ws = new WebSocket(url);
    setStatus("connecting…");

    ws.onopen = () => {
      setStatus("");
      ping();
      setTimeout(ping, 150);
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 3000);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(msg);
    };

    ws.onclose = (event) => {
      clearInterval(pingTimer);
      bestRtt = Infinity;
      synced = false;
      if (!joined) return;
      if (event.code === 1013) {
        setStatus("room is full — try another code");
        return;
      }
      setStatus("reconnecting…");
      reconnectTimer = setTimeout(connect, 1200 + Math.random() * 800);
    };

    ws.onerror = () => {};
  }

  function handle(msg) {
    switch (msg.type) {
      case "welcome":
        myId = msg.id;
        bpm = msg.bpm || bpm;
        loopMs = msg.loopMs || loopMs;
        stepMs = msg.stepMs || stepMs;
        renderPlayers(msg.players || []);
        break;
      case "players":
        renderPlayers(msg.players || []);
        break;
      case "note":
        onNote(msg);
        break;
      case "pong": {
        const t2 = Date.now();
        const rtt = t2 - msg.t0;
        if (rtt >= 0 && rtt < bestRtt) {
          bestRtt = rtt;
          offset = msg.t1 - (msg.t0 + rtt / 2);
          synced = true;
        }
        break;
      }
    }
  }

  function renderPlayers(list) {
    playersEl.innerHTML = "";
    for (const p of list) {
      const chip = document.createElement("div");
      chip.className = "player" + (p.id === myId ? " me" : "");
      chip.dataset.id = p.id;
      chip.style.setProperty("--hue", p.hue);
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = p.id === myId ? "you" : p.name;
      chip.append(dot, label);
      playersEl.appendChild(chip);
    }
    countEl.textContent = list.length + " here";
  }

  function onNote(msg) {
    if (!synced || !ctx) return;
    const delay = Math.max(0, msg.at - (Date.now() + offset));
    play(msg.inst, msg.at);

    setTimeout(() => {
      const pad = padsEl.querySelector(`[data-inst="${msg.inst}"]`);
      if (pad) {
        pad.style.setProperty("--hue", msg.hue);
        pad.classList.remove("hit");
        void pad.offsetWidth;
        pad.classList.add("hit");
      }
      const chip = playersEl.querySelector(`[data-id="${msg.by}"]`);
      if (chip) {
        chip.classList.remove("pulse");
        void chip.offsetWidth;
        chip.classList.add("pulse");
      }
      const phase = ((msg.at % loopMs) + loopMs) % loopMs;
      const dot = stepDots[Math.floor(phase / stepMs)];
      if (dot) {
        dot.style.setProperty("--hue", msg.hue);
        dot.classList.add("hitdot");
        setTimeout(() => dot.classList.remove("hitdot"), 260);
      }
    }, delay);
  }

  function hit(inst) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ctx && ctx.state === "suspended") ctx.resume();
    if (navigator.vibrate) navigator.vibrate(8);
    ws.send(JSON.stringify({ type: "hit", inst }));
    const pad = padsEl.querySelector(`[data-inst="${inst}"]`);
    if (pad) {
      pad.classList.remove("press");
      void pad.offsetWidth;
      pad.classList.add("press");
    }
  }

  padsEl.addEventListener("pointerdown", (event) => {
    const pad = event.target.closest(".pad");
    if (!pad) return;
    event.preventDefault();
    hit(Number(pad.dataset.inst));
  });

  window.addEventListener("keydown", (event) => {
    const idx = "123456".indexOf(event.key);
    if (idx >= 0) {
      event.preventDefault();
      hit(idx);
    }
  });

  // ---------- invite ----------
  const roomURL = () => location.origin + "/r/" + code;

  function openInvite() {
    const url = roomURL();
    shareLink.value = url;
    qrImg.src = "/qr?d=" + encodeURIComponent(url);
    invitePanel.classList.remove("gone");
  }

  $("#invite").addEventListener("click", openInvite);
  $("#codeChip").addEventListener("click", openInvite);
  $("#closeInvite").addEventListener("click", () => invitePanel.classList.add("gone"));

  let toastEl = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  async function copyLink() {
    const url = roomURL();
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      shareLink.value = url;
      shareLink.select();
      document.execCommand("copy");
      toast("Link copied");
    }
  }

  $("#copyBtn").addEventListener("click", copyLink);

  // ---------- join ----------
  joinBtn.addEventListener("click", () => {
    if (joined) return;
    const typed = nameInput.value.trim().slice(0, 16);
    name = typed || randomName();
    localStorage.setItem("campfire.name", name);
    ensureAudio();
    if (ctx && ctx.state === "suspended") ctx.resume();
    overlay.classList.add("gone");
    joined = true;
    connect();
    setTimeout(() => overlay.remove(), 500);
  });

  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinBtn.click();
  });
})();
