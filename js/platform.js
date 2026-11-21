/* Pouvoir 2026 — couche « plateforme » pour la version application.
   Elle recrée l'interface window.claude.use(...) utilisée par le jeu dans Claude :
   - "sample"    → IA LOCALE dans le téléphone (WebLLM, aucun service extérieur) si l'appareil
                   le permet (WebGPU), sinon ton serveur (server/worker.js) s'il est configuré ;
   - "tts"       → voix du téléphone (plugin Capacitor) ou du navigateur ;
   - "dictation" → micro du téléphone (plugin Capacitor) ou reconnaissance vocale du navigateur.
   Réglages : www/js/config.js */
(function () {
  const CFG = window.POUVOIR_CONFIG || {};
  const API = String(CFG.apiUrl || '').replace(/\/+$/, '');
  const Plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};

  // Identifiant anonyme de l'appareil (sert au quota quotidien côté serveur)
  const device = (() => {
    try {
      let d = localStorage.getItem('p26device');
      if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); localStorage.setItem('p26device', d); }
      return d;
    } catch (e) { return 'anon'; }
  })();

  // ---------- IA ----------
  async function callAI(input, opts = {}) {
    const body = {
      prompt: typeof input === 'string' ? input : undefined,
      messages: Array.isArray(input) ? input : undefined,
      tier: opts.modelTier || 'default',
      stream: typeof opts.onText === 'function'
    };
    let r;
    try {
      r = await fetch(API + '/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device': device, 'x-app-token': CFG.appToken || '' },
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) { throw { code: 'network', message: 'Serveur injoignable' }; }
    if (r.status === 429) throw { code: 'rate_limited', message: 'Quota quotidien atteint' };
    if (r.status === 401 || r.status === 403) throw { code: 'not_granted', message: 'Accès refusé par le serveur' };
    if (!r.ok) throw { code: 'error', message: 'Erreur serveur ' + r.status };

    if (!body.stream) {
      const j = await r.json();
      return { text: String(j.text || ''), truncated: !!j.truncated };
    }
    // Lecture du flux (Server-Sent Events renvoyés tels quels par l'API d'Anthropic)
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '', truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
            text += ev.delta.text;
            opts.onText({ text, delta: ev.delta.text });
          } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') truncated = true;
          else if (ev.type === 'error') throw { code: 'error', message: (ev.error && ev.error.message) || 'Erreur IA' };
        } catch (e) { if (e && e.code) throw e; }
      }
    }
    return { text, truncated };
  }
  function parseJSON(t) {
    t = String(t || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
  }
  // ---------- IA locale (dans le téléphone, sans service extérieur) ----------
  const SYSTEM = "Tu es le moteur narratif et diplomatique du jeu de simulation géopolitique « Pouvoir 2026 ». Tu réponds toujours en français. Quand on te demande du JSON, tu réponds uniquement avec un objet JSON valide. Tu restes réaliste et nuancé.";
  const MODEL = CFG.localModel || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
  const hasGPU = !!navigator.gpu;
  const MODE = CFG.aiMode === 'server' ? 'server' : CFG.aiMode === 'local' ? (hasGPU ? 'local' : (API ? 'server' : 'none')) : (hasGPU ? 'local' : (API ? 'server' : 'none'));
  let engine = null, loading = null, box = null;
  function showProgress(txt, pct) {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:99;background:rgba(10,26,30,.94);color:#eaf4f2;padding:12px 16px;border-radius:14px;font:14px/1.4 system-ui,sans-serif;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,0,0,.4)';
      document.body.appendChild(box);
    }
    box.innerHTML = '<b>IA du jeu</b><div style="opacity:.85;margin:4px 0 8px">' + txt + '</div><div style="height:8px;border-radius:4px;background:rgba(255,255,255,.15);overflow:hidden"><i style="display:block;height:100%;width:' + Math.round((pct || 0) * 100) + '%;background:#ffd166"></i></div>';
  }
  function hideProgress() { if (box) { box.remove(); box = null; } }
  async function getEngine() {
    if (engine) return engine;
    if (!loading) loading = (async () => {
      const webllm = await import(CFG.webllmUrl || 'https://esm.run/@mlc-ai/web-llm@0.2');
      showProgress('Préparation de l\'IA… (premier lancement : téléchargement d\'environ 1 Go, une seule fois, de préférence en wifi)', 0);
      engine = await webllm.CreateMLCEngine(MODEL, {
        initProgressCallback: p => showProgress(p.text && /cache|Loading/i.test(p.text) && p.progress > 0.99 ? 'Chargement en mémoire…' : 'Téléchargement et préparation : ' + Math.round((p.progress || 0) * 100) + ' %', p.progress)
      });
      hideProgress();
      return engine;
    })().catch(e => { loading = null; hideProgress(); throw { code: 'error', message: 'IA locale indisponible : ' + (e && e.message || e) }; });
    return loading;
  }
  async function callLocal(input, opts = {}, json) {
    const eng = await getEngine();
    const messages = [{ role: 'system', content: SYSTEM }].concat(typeof input === 'string' ? [{ role: 'user', content: input }] : input);
    if (opts.onText && !json) {
      const chunks = await eng.chat.completions.create({ messages, stream: true, temperature: 0.7, max_tokens: 1400 });
      let text = '';
      for await (const ch of chunks) { const d = (ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content) || ''; if (d) { text += d; opts.onText({ text, delta: d }); } }
      return { text, truncated: false };
    }
    let r;
    try { r = await eng.chat.completions.create({ messages, temperature: json ? 0.5 : 0.7, max_tokens: 900, ...(json ? { response_format: { type: 'json_object' } } : {}) }); }
    catch (e) { if (!json) throw e; r = await eng.chat.completions.create({ messages, temperature: 0.5, max_tokens: 900 }); }
    return { text: (r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '', truncated: false };
  }

  const sample = (input, opts) => MODE === 'local' ? callLocal(input, opts) : callAI(input, opts);
  sample.json = async (input, opts) => {
    const p = typeof input === 'string' ? input + '\n\nRéponds uniquement avec un objet JSON valide, sans aucun texte autour.' : input;
    const r = MODE === 'local' ? await callLocal(p, { ...(opts || {}), onText: undefined }, true) : await callAI(p, { ...(opts || {}), onText: undefined });
    return parseJSON(r.text);
  };
  sample.mode = MODE;
  if (MODE === 'none' && CFG.aiMode !== 'server') setTimeout(() => { showProgress('Ce navigateur ne permet pas de faire tourner l\'IA gratuite (WebGPU absent). Le jeu fonctionne sans IA. Essayez Chrome sur ordinateur ou Android, ou Safari à jour sur iPhone.', 0); setTimeout(hideProgress, 9000); }, 2500);
  // Prépare l'IA locale dès l'ouverture (le téléchargement se fait une seule fois)
  if (MODE === 'local' && CFG.preloadAI !== false) setTimeout(() => { getEngine().catch(() => {}); }, 1500);
  sample.limits = async () => ({ images: false });

  // ---------- Voix (synthèse) ----------
  function makeTTS() {
    const cap = Plugins().TextToSpeech;
    const web = window.speechSynthesis;
    if (!cap && !web) return null;
    const subs = [];
    const emit = (state, reason) => subs.forEach(f => { try { f({ state, reason }); } catch (e) {} });
    // 4 « voix » du jeu → hauteur de voix différente (et voix française différente si disponible)
    const PITCH = { buttery: 1.0, airy: 1.2, glassy: 0.85, rounded: 0.95 };
    let frVoices = [];
    const loadVoices = () => { try { frVoices = (web ? web.getVoices() : []).filter(v => /^fr/i.test(v.lang)); } catch (e) {} };
    if (web) { loadVoices(); web.onvoiceschanged = loadVoices; }
    return {
      async speak(text, o = {}) {
        const t = String(Array.isArray(text) ? text.map(x => x.text).join(' ') : text).slice(0, 2000);
        const pitch = PITCH[o.voice] || 1, rate = o.rate || 1;
        emit('speaking');
        try {
          if (cap) {
            await cap.speak({ text: t, lang: 'fr-FR', rate, pitch, volume: 1, category: 'ambient' });
          } else {
            await new Promise((ok, ko) => {
              web.cancel();
              const u = new SpeechSynthesisUtterance(t);
              u.lang = 'fr-FR'; u.rate = rate; u.pitch = pitch;
              if (frVoices.length) u.voice = frVoices[Object.keys(PITCH).indexOf(o.voice || 'buttery') % frVoices.length] || frVoices[0];
              u.onend = ok; u.onerror = e => ko({ code: 'error', message: e.error });
              web.speak(u);
            });
          }
          emit('idle', 'completed');
        } catch (e) { emit('idle', 'error'); throw e && e.code ? e : { code: 'error' }; }
      },
      stop() { try { cap ? cap.stop() : web.cancel(); } catch (e) {} emit('idle', 'viewer_stopped'); },
      onState(f) { subs.push(f); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; }
    };
  }

  // ---------- Micro (dictée) ----------
  function makeDictation() {
    const cap = Plugins().SpeechRecognition;
    const W = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!cap && !W) return null;
    const P = [], F = [], St = [];
    const fire = (arr, v) => arr.forEach(f => { try { f(v); } catch (e) {} });
    let last = '', rec = null, capSub = null;
    const setState = s => fire(St, { state: s });
    return {
      onPartial(f) { P.push(f); }, onFinal(f) { F.push(f); }, onState(f) { St.push(f); },
      async start() {
        last = '';
        if (cap) {
          const perm = await cap.requestPermissions().catch(() => null);
          if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') throw { code: 'not_granted' };
          capSub = await cap.addListener('partialResults', d => { const m = d && d.matches && d.matches[0]; if (m) { last = m; fire(P, { text: m }); } });
          setState('listening');
          cap.start({ language: 'fr-FR', partialResults: true, popup: false, maxResults: 1 }).catch(() => {});
          return;
        }
        rec = new W(); rec.lang = 'fr-FR'; rec.interimResults = true; rec.continuous = true;
        rec.onresult = e => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) fire(F, { text: t }); else interim += t;
          }
          if (interim) fire(P, { text: interim });
        };
        rec.onerror = e => { if (e.error === 'not-allowed') setState('idle'); };
        rec.onend = () => setState('idle');
        rec.start(); setState('listening');
      },
      async stop() {
        if (cap) {
          try { await cap.stop(); } catch (e) {}
          try { capSub && capSub.remove(); } catch (e) {}
          if (last) fire(F, { text: last });
          setState('idle'); return;
        }
        try { rec && rec.stop(); } catch (e) {}
      }
    };
  }

  let ttsInst, dictInst;
  window.claude = {
    async use(name) {
      if (name === 'sample') return MODE === 'none' ? null : sample;
      if (name === 'tts') { if (ttsInst === undefined) ttsInst = makeTTS(); return ttsInst; }
      if (name === 'dictation') { if (dictInst === undefined) dictInst = makeDictation(); return dictInst; }
      return null;
    }
  };
})();
