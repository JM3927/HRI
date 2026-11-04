/*
 * task.js — Therapist Embodiment Study: main psiTurk state engine.
 *
 * Runs inside templates/exp.html, which defines the psiTurk globals
 * `uniqueId`, `adServerLoc`, `mode`, `condition` and `counterbalance`.
 *
 * Components
 *   Preloader        Fetches every audio clip of the condition into memory
 *                    (Blob → object URL → HTML5 Audio, awaited to
 *                    'canplaythrough') before the session may start, so no
 *                    network I/O can occur while reaction times are measured.
 *   BranchingEngine  The clinical-intake decision tree (DIALOGUE_TREE) plus
 *                    validation and traversal.
 *   AudioPlayer      Plays a clip, routes it through a Web Audio analyser for
 *                    lip-sync / visualisation, resolves on 'ended'.
 *   AvatarRenderer   Condition-specific SVG avatar driven by audio level.
 *   Visualizer       Canvas audio visualiser (identical in all conditions).
 *   DataCollector    Latency = t_click − t_options_shown, POSTed to
 *                    /api/save_trial with retries, mirrored to psiTurk.
 *   Session          Orchestrates preload → sound check → dialogue → save.
 *
 * Timing notes
 *   All times use the performance.now() monotonic clock. t_options_shown is
 *   taken in the second requestAnimationFrame after the options are inserted,
 *   i.e. after the frame containing them has been painted; the buttons only
 *   become clickable at that moment, so latency can never be negative.
 *   t_click is the click event's own high-resolution timeStamp.
 */
(function () {
  'use strict';

  // ======================================================================
  // Configuration
  // ======================================================================

  const CONFIG = {
    audioBase: '/static/audio',
    audioExt: '.mp3',
    videoBase: '/static/video',
    videoExt: '.mp4',
    idleClipId: 'idle',          // video mode: silent "listening" loop shown between clips
    preloadConcurrency: 4,
    preloadTimeoutMs: 30000,     // per audio clip, network + decode
    videoPreloadTimeoutMs: 120000, // per video clip (files are much larger)
    watchdogPaddingMs: 4000,     // extra time after a clip's duration before giving up on 'ended'
    gapAfterResponseMs: 450,     // natural pause between acknowledgment and next question
    saveMaxAttempts: 6,
    saveBaseDelayMs: 500,
    simulatedMsPerWord: 330,     // debug-only simulated speech rate
  };

  /**
   * psiTurk condition index → embodiment. Must match CONDITIONS in custom.py.
   *
   * `media` selects what the participant sees and hears:
   *   'audio' — drawn avatar lip-synced to static/audio/<key>/<clip>.mp3
   *   'video' — recorded clips static/video/<key>/<clip>.mp4 (sound included),
   *             with static/video/<key>/idle.mp4 looping silently between them
   * Human and Furhat use recorded video. Peerbot is still undecided: it uses
   * the drawn avatar with .mp3 audio until its footage exists, then change its
   * `media` to 'video' (nothing else needs to change). Mixing video and a drawn
   * avatar across conditions confounds embodiment with presentation format, so
   * settle Peerbot before collecting real data.
   *
   * `portrait` (optional, audio mode only) is an image URL shown instead of
   * the drawn avatar; it is preloaded together with the audio.
   */
  const CONDITIONS = {
    0: { key: 'human',   label: 'Human therapist',              avatar: 'human',   media: 'video', portrait: null },
    1: { key: 'furhat',  label: 'Furhat social robot',          avatar: 'furhat',  media: 'video', portrait: null },
    2: { key: 'peerbot', label: 'Mechanical (Peerbot-style) robot', avatar: 'peerbot', media: 'video', portrait: null }, 
  };

  /*
   * The dialogue tree. Identical words in every condition; only the voice
   * (audio folder) and avatar differ.
   *
   *   node:   id, stage (1–6), audio (clip id), prompt (full spoken text),
   *           question (on-screen text), options[]
   *   option: text (button), code (analysis code), responseAudio (clip id),
   *           responseTranscript (spoken acknowledgment), nextNodeId (null = end)
   *
   * Media files: /static/video/<condition key>/<clip id>.mp4 (media 'video')
   *           or /static/audio/<condition key>/<clip id>.mp3 (media 'audio')
   *
   * The block between the BEGIN/END markers must stay strict JSON — it is
   * parsed by tools/audio_assets.py to produce the recording script and to
   * verify that every audio file exists.
   *
   * Paths: 6 questions, or 7 when the participant reports feeling isolated
   * (conditional follow-up n4b_connection).
   */
  const DIALOGUE_TREE = /* BEGIN_DIALOGUE_TREE */ [
    {
      "id": "n1_opening",
      "stage": 1,
      "audio": "n1_opening",
      "prompt": "Hello, and thank you for being here today. My name is Jackson, and I'll be guiding a short check-in conversation with you. There are no right or wrong answers, so just choose whatever feels closest to true for you. To start, how have you been feeling over the past few weeks?",
      "question": "How have you been feeling over the past few weeks?",
      "options": [
        { "text": "Pretty good, overall", "code": "mood_positive", "responseAudio": "n1_opening_r0",
          "responseTranscript": "I'm glad to hear that. It's still valuable to take some time to reflect on how things have been going, even if it's been going well.",
          "nextNodeId": "n2_stressor" },
        { "text": "Okay, but up and down", "code": "mood_mixed", "responseAudio": "n1_opening_r1",
          "responseTranscript": "Thank you for being honest with me. It seems like things have been a little unpredictable lately.",
          "nextNodeId": "n2_stressor" },
        { "text": "I've been really struggling", "code": "mood_low", "responseAudio": "n1_opening_r2",
          "responseTranscript": "I'm sorry things have been so difficult. Thank you for sharing that with me, and we'll take this one step at a time.",
          "nextNodeId": "n2_stressor" }
      ]
    },
    {
      "id": "n2_stressor",
      "stage": 2,
      "audio": "n2_stressor",
      "prompt": "I'd like to understand a little more about what's been on your mind. When you think about what has been weighing on you most lately, which of these feels closest?",
      "question": "What has been weighing on you most lately?",
      "options": [
        { "text": "School or work pressures", "code": "stressor_academic_work", "responseAudio": "n2_stressor_r0",
          "responseTranscript": "School and work can ask a lot of us. Deadlines, expectations, and the feeling that there's never quite enough time can really add up.",
          "nextNodeId": "n3_coping" },
        { "text": "My relationships with other people", "code": "stressor_interpersonal", "responseAudio": "n2_stressor_r1",
          "responseTranscript": "Our relationships matter so much to how we feel. When something is off with the people around us, it can affect everything else.",
          "nextNodeId": "n3_coping" },
        { "text": "General stress, uncertainty, or concerns about the future", "code": "stressor_existential_general", "responseAudio": "n2_stressor_r2",
          "responseTranscript": "That kind of stress or uncertainty can feel heavy, especially when it's difficult to identify exactly what's bothering you.",
          "nextNodeId": "n3_coping" }
      ]
    },
    {
      "id": "n3_coping",
      "stage": 3,
      "audio": "n3_coping",
      "prompt": "When that stress shows up, people handle it in very different ways. Which of these sounds most like what you tend to do?",
      "question": "When stress shows up, what do you tend to do?",
      "options": [
        { "text": "Distract myself or try not to think about it", "code": "coping_avoidant", "responseAudio": "n3_coping_r0",
          "responseTranscript": "That's a common way to cope. Taking a break can give us space to recharge before tackling what's been bothering us.",
          "nextNodeId": "n4_support" },
        { "text": "Make a plan and tackle the problem directly", "code": "coping_active", "responseAudio": "n3_coping_r1",
          "responseTranscript": "Taking action and working through a problem can be a helpful way to manage stressful situations.",
          "nextNodeId": "n4_support" },
        { "text": "Talk it through with someone I trust", "code": "coping_social", "responseAudio": "n3_coping_r2",
          "responseTranscript": "Reaching out to others is a meaningful way to cope. Talking things through can make a problem feel lighter.",
          "nextNodeId": "n4_support" }
      ]
    },
    {
      "id": "n4_support",
      "stage": 4,
      "audio": "n4_support",
      "prompt": "Let's talk about the people in your life. When things get difficult, how supported do you feel by the people around you?",
      "question": "When things get difficult, how supported do you feel?",
      "options": [
        { "text": "I have people I can count on", "code": "support_high", "responseAudio": "n4_support_r0",
          "responseTranscript": "It's really good to hear that you have people you can rely on. That kind of support can make a big difference.",
          "nextNodeId": "n5_goals" },
        { "text": "I have some support, but I don't always reach out", "code": "support_moderate", "responseAudio": "n4_support_r1",
          "responseTranscript": "That's very understandable. Even when support is there, it can be difficult to reach out.",
          "nextNodeId": "n5_goals" },
        { "text": "I often feel like I don't have anyone to talk to", "code": "support_isolated", "responseAudio": "n4_support_r2",
          "responseTranscript": "Thank you for sharing that. Feeling like you're on your own can be really hard, and I'd like to understand a little more.",
          "nextNodeId": "n4b_connection" }
      ]
    },
    {
      "id": "n4b_connection",
      "stage": 4,
      "audio": "n4b_connection",
      "prompt": "When you feel like you don't have someone to talk to, what makes it difficult to reach out?",
      "question": "What makes it hardest to reach out to others?",
      "options": [
        { "text": "I don't want to be a burden", "code": "barrier_burden", "responseAudio": "n4b_connection_r0",
          "responseTranscript": "Many people worry about that. It's understandable to not want to burden others, but it's also okay to ask for support.",
          "nextNodeId": "n5_goals" },
        { "text": "I'm not sure who I could talk to", "code": "barrier_access", "responseAudio": "n4b_connection_r1",
          "responseTranscript": "That's an honest answer. Sometimes the first step is simply knowing what options are out there.",
          "nextNodeId": "n5_goals" },
        { "text": "I prefer to keep things to myself", "code": "barrier_privacy", "responseAudio": "n4b_connection_r2",
          "responseTranscript": "That's okay. Privacy matters, and it's important that any support you choose feels comfortable to you.",
          "nextNodeId": "n5_goals" }
      ]
    },
    {
      "id": "n5_goals",
      "stage": 5,
      "audio": "n5_goals",
      "prompt": "If you were to have more conversations like this, what would you most want to get out of them?",
      "question": "What would you most want to get out of future conversations?",
      "options": [
        { "text": "Learn practical skills and strategies", "code": "goal_skills", "responseAudio": "n5_goals_r0",
          "responseTranscript": "So it sounds like you'd like some practical tools to manage stress, and handle difficult moments when they come up.",
          "nextNodeId": "n6_wrapup" },
        { "text": "Have a space to talk and be heard", "code": "goal_vent", "responseAudio": "n5_goals_r1",
          "responseTranscript": "So what matters most to you is having a space to talk openly and feel heard, without having to fix everything right away.",
          "nextNodeId": "n6_wrapup" },
        { "text": "A bit of both, or I'm not sure yet", "code": "goal_mixed", "responseAudio": "n5_goals_r2",
          "responseTranscript": "That's completely fine. Many people want some of both, and it's okay to figure that out along the way.",
          "nextNodeId": "n6_wrapup" }
      ]
    },
    {
      "id": "n6_wrapup",
      "stage": 6,
      "audio": "n6_wrapup",
      "prompt": "We're nearly at the end of our conversation. Today we talked about how you've been feeling, what has been on your mind, how you tend to cope, the support around you, and what you'd want from future conversations. Does that feel like a fair summary of what you've been experiencing? I appreciate your openness and participation in this conversation.",
      "question": "Does that feel like a fair summary of our conversation?",
      "options": [
        { "text": "Yes, that feels right", "code": "wrap_agree", "responseAudio": "n6_wrapup_r0",
          "responseTranscript": "I'm glad. Thank you again for talking with me today. In a moment, you'll be asked a few questions about our conversation. Take care.",
          "nextNodeId": null },
        { "text": "Partly", "code": "wrap_partial", "responseAudio": "n6_wrapup_r1",
          "responseTranscript": "Thank you for telling me. There's always more to someone's story than a short conversation can capture. In a moment, you'll be asked a few questions about our conversation. Take care.",
          "nextNodeId": null },
        { "text": "Not really", "code": "wrap_disagree", "responseAudio": "n6_wrapup_r2",
          "responseTranscript": "I appreciate your honesty. It's okay if this conversation didn't fully reflect what you've been experiencing. In a moment, you'll be asked a few questions about our conversation. Take care.",
          "nextNodeId": null }
      ]
    }
  ] /* END_DIALOGUE_TREE */;

  // ======================================================================
  // Small utilities
  // ======================================================================

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, k) => a + (b - a) * k;

  /** Resolves inside the frame *after* the next paint (double rAF). */
  function afterNextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
    });
  }

  /** High-resolution event time on the performance.now() clock, with a sanity fallback. */
  function eventTime(ev) {
    const now = performance.now();
    const ts = ev && ev.timeStamp;
    return (typeof ts === 'number' && ts > 0 && ts <= now + 1 && now - ts < 5000) ? ts : now;
  }

  function randomId() {
    if (window.crypto && crypto.getRandomValues) {
      const a = new Uint32Array(3);
      crypto.getRandomValues(a);
      return Array.from(a, (n) => n.toString(36)).join('');
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function formatBytes(n) {
    if (!n) return '';
    return n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  class PreloadError extends Error {
    constructor(failures) {
      super(failures.length + ' asset(s) failed to load');
      this.failures = failures;
    }
  }

  // ======================================================================
  // Preloader
  // ======================================================================

  /**
   * Loads every asset fully into memory before the session starts.
   * Audio/video: fetch → Blob → object URL → media element, awaited to
   * 'canplaythrough'. Because the source is an in-memory Blob, playback can
   * never wait on the network. Failures are collected (not fail-fast) so the
   * researcher sees the complete list of missing files at once.
   */
  class Preloader {
    /**
     * @param {Array<{id:string,url:string,kind:'audio'|'video'|'image'}>} manifest
     * @param {(p:{done:number,total:number,fraction:number,bytes:number})=>void} onProgress
     */
    constructor(manifest, onProgress) {
      this.manifest = manifest;
      this.onProgress = onProgress || (() => {});
      this.fraction = new Map();   // id → 0..1
      this.bytes = new Map();      // id → bytes received
      this.done = 0;
    }

    async load() {
      const assets = new Map();
      const failures = [];
      const queue = this.manifest.slice();

      const worker = async () => {
        while (queue.length) {
          const entry = queue.shift();
          try {
            assets.set(entry.id, entry.kind === 'image' ? await this._loadImage(entry) : await this._loadMedia(entry));
          } catch (err) {
            failures.push({ id: entry.id, url: entry.url, reason: err && err.message ? err.message : String(err) });
          } finally {
            this.fraction.set(entry.id, 1);
            this.done += 1;
            this._emit();
          }
        }
      };

      this._emit();
      const n = Math.min(CONFIG.preloadConcurrency, queue.length);
      await Promise.all(Array.from({ length: n }, worker));

      if (failures.length) {
        // Free whatever did load; the caller will retry from scratch.
        assets.forEach((a) => a.blobUrl && URL.revokeObjectURL(a.blobUrl));
        throw new PreloadError(failures);
      }
      return assets;
    }

    _emit() {
      const total = this.manifest.length;
      let sum = 0;
      this.fraction.forEach((f) => { sum += f; });
      let bytes = 0;
      this.bytes.forEach((b) => { bytes += b; });
      this.onProgress({ done: this.done, total, fraction: total ? sum / total : 1, bytes });
    }

    _timeoutMs(entry) {
      return entry.kind === 'video' ? CONFIG.videoPreloadTimeoutMs : CONFIG.preloadTimeoutMs;
    }

    async _fetchBlob(entry) {
      const controller = 'AbortController' in window ? new AbortController() : null;
      const timer = setTimeout(() => controller && controller.abort(), this._timeoutMs(entry));
      try {
        const resp = await fetch(entry.url, { cache: 'no-cache', signal: controller ? controller.signal : undefined });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const type = resp.headers.get('Content-Type') || '';
        if (/text\/html/i.test(type)) throw new Error('server returned HTML instead of media');
        const total = Number(resp.headers.get('Content-Length')) || 0;

        // Stream so the progress bar moves smoothly for large files.
        if (resp.body && resp.body.getReader) {
          const reader = resp.body.getReader();
          const chunks = [];
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            this.bytes.set(entry.id, received);
            if (total) this.fraction.set(entry.id, Math.min(0.95, received / total));
            this._emit();
          }
          return new Blob(chunks, { type: type || 'application/octet-stream' });
        }
        const blob = await resp.blob();
        this.bytes.set(entry.id, blob.size);
        return blob;
      } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('timed out');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    async _loadMedia(entry) {
      const blob = await this._fetchBlob(entry);
      if (!blob.size) throw new Error('empty file');
      const blobUrl = URL.createObjectURL(blob);
      let el;
      if (entry.kind === 'video') {
        el = document.createElement('video');
        el.playsInline = true;            // never go fullscreen on tablets
        el.disablePictureInPicture = true;
        el.muted = !!entry.muted;
        el.loop = !!entry.loop;
      } else {
        el = new Audio();
      }
      el.preload = 'auto';
      el.src = blobUrl;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => cleanup(new Error('decode timed out')), this._timeoutMs(entry));
        const ok = () => cleanup();
        const bad = () => cleanup(new Error('could not decode ' + entry.kind +
          (el.error ? ' (MediaError ' + el.error.code + ')' : '')));
        function cleanup(err) {
          clearTimeout(timer);
          el.removeEventListener('canplaythrough', ok);
          el.removeEventListener('error', bad);
          if (err) { URL.revokeObjectURL(blobUrl); reject(err); } else { resolve(); }
        }
        el.addEventListener('canplaythrough', ok);
        el.addEventListener('error', bad);
        el.load();
      });

      const durationMs = Number.isFinite(el.duration) ? el.duration * 1000 : null;
      return { kind: entry.kind, el, blobUrl, bytes: blob.size, durationMs };
    }

    async _loadImage(entry) {
      const blob = await this._fetchBlob(entry);
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.src = blobUrl;
      await img.decode();
      return { kind: 'image', el: img, blobUrl, bytes: blob.size };
    }
  }

  // ======================================================================
  // BranchingEngine
  // ======================================================================

  class BranchingEngine {
    constructor(tree) {
      this.nodes = new Map(tree.map((n) => [n.id, n]));
      this.rootId = tree[0].id;
      this.validate();
    }

    /** Structural checks: dangling links, cycles, stage order, path length 5–7. */
    validate() {
      const problems = [];
      this.nodes.forEach((node) => {
        if (!node.options || node.options.length < 2 || node.options.length > 4) {
          problems.push(node.id + ': needs 2–4 options');
        }
        (node.options || []).forEach((opt, i) => {
          if (opt.nextNodeId !== null && !this.nodes.has(opt.nextNodeId)) {
            problems.push(node.id + '[' + i + '] → unknown node ' + opt.nextNodeId);
          } else if (opt.nextNodeId && this.nodes.get(opt.nextNodeId).stage < node.stage) {
            problems.push(node.id + '[' + i + '] goes back to an earlier stage');
          }
        });
      });

      // Depth-first enumeration of every root→leaf path.
      const lengths = [];
      const reached = new Set();
      const walk = (id, depth, onPath) => {
        if (onPath.has(id)) { problems.push('cycle through ' + id); return; }
        reached.add(id);
        onPath.add(id);
        this.nodes.get(id).options.forEach((opt) => {
          if (opt.nextNodeId === null) lengths.push(depth);
          else if (this.nodes.has(opt.nextNodeId)) walk(opt.nextNodeId, depth + 1, onPath);
        });
        onPath.delete(id);
      };
      if (!problems.length) walk(this.rootId, 1, new Set());
      this.nodes.forEach((_, id) => { if (!reached.has(id)) problems.push(id + ' is unreachable'); });
      if (lengths.some((l) => l < 5 || l > 7)) problems.push('every path must contain 5–7 questions');

      if (problems.length) throw new Error('Dialogue tree invalid: ' + problems.join('; '));
      this.pathLengths = { min: Math.min(...lengths), max: Math.max(...lengths) };
    }

    get(id) { return this.nodes.get(id); }
    root() { return this.nodes.get(this.rootId); }

    /** Every clip id (prompts + responses) — all are preloaded because the path is unknown in advance. */
    clipIds() {
      const ids = new Set();
      this.nodes.forEach((n) => {
        ids.add(n.audio);
        n.options.forEach((o) => ids.add(o.responseAudio));
      });
      return Array.from(ids);
    }

    /** Spoken text for each clip id (used for simulated debug playback). */
    transcripts() {
      const map = new Map();
      this.nodes.forEach((n) => {
        map.set(n.audio, n.prompt);
        n.options.forEach((o) => map.set(o.responseAudio, o.responseTranscript));
      });
      return map;
    }
  }

  // ======================================================================
  // AudioPlayer
  // ======================================================================

  /**
   * Plays preloaded clips and exposes their loudness/spectrum for animation.
   * Works the same for audio and video clips (the soundtrack of a <video> is
   * routed through the analyser); showing the picture is AvatarRenderer's job.
   */
  class AudioPlayer {
    /**
     * @param {Map<string,{el:HTMLMediaElement,durationMs:number}>} bank  preloaded clips
     * @param {{simulated:boolean, transcripts:Map<string,string>}} opts
     */
    constructor(bank, opts) {
      this.bank = bank;
      this.simulated = !!opts.simulated;
      this.transcripts = opts.transcripts;
      this.ctx = null;
      this.analyser = null;
      this.sources = new WeakMap();
      this.speaking = false;
      this.timeData = null;
      this.freqData = null;
      this._simStart = 0;
    }

    /** Create the AudioContext lazily (must follow a user gesture to be allowed to run). */
    ensureContext() {
      if (this.ctx || !(window.AudioContext || window.webkitAudioContext)) return this.ctx;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.55;
        this.analyser.connect(this.ctx.destination);
        this.timeData = new Uint8Array(this.analyser.fftSize);
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      } catch (err) {
        console.warn('Web Audio unavailable; playing without analysis.', err);
        this.ctx = null;
      }
      return this.ctx;
    }

    async unlock() {
      const ctx = this.ensureContext();
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    }

    /** Short sine tone for the sound check (no audio file needed). */
    async playTestTone() {
      await this.unlock();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.05);
      gain.gain.setValueAtTime(0.18, t0 + 1.1);
      gain.gain.linearRampToValueAtTime(0, t0 + 1.2);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 1.25);
    }

    _route(el) {
      if (!this.ctx || this.sources.has(el)) return;
      // A media element can be wrapped only once; cache the node.
      const src = this.ctx.createMediaElementSource(el);
      src.connect(this.analyser);
      this.sources.set(el, src);
    }

    /**
     * Play a clip and resolve when it has finished.
     * Rejects with name 'NotAllowedError' if the browser blocks playback.
     * @returns {Promise<{durationMs:number|null, onsetMs:number|null, watchdogFired:boolean, simulated:boolean}>}
     */
    play(clipId) {
      if (this.simulated) return this._playSimulated(clipId);

      const clip = this.bank.get(clipId);
      if (!clip) return Promise.reject(new Error('clip not preloaded: ' + clipId));
      const el = clip.el;
      this._route(el);

      return new Promise((resolve, reject) => {
        let tCall = 0;
        let tPlaying = null;
        let watchdog = null;
        let settled = false;

        const finish = (watchdogFired) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          el.removeEventListener('playing', onPlaying);
          el.removeEventListener('ended', onEnded);
          el.removeEventListener('error', onError);
          this.speaking = false;
          if (watchdogFired) el.pause();
          const tEnd = performance.now();
          resolve({
            durationMs: tPlaying === null ? null : tEnd - tPlaying,
            onsetMs: tPlaying === null ? null : tPlaying - tCall,
            watchdogFired,
            simulated: false,
          });
        };
        const onPlaying = () => {
          if (tPlaying === null) tPlaying = performance.now();
          this.speaking = true;
        };
        const onEnded = () => finish(false);
        const onError = () => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          this.speaking = false;
          reject(new Error('playback error for ' + clipId));
        };

        el.addEventListener('playing', onPlaying);
        el.addEventListener('ended', onEnded);
        el.addEventListener('error', onError);
        el.currentTime = 0;

        const limit = (clip.durationMs || 60000) + CONFIG.watchdogPaddingMs;
        watchdog = setTimeout(() => {
          console.warn('Audio watchdog fired for', clipId);
          finish(true);
        }, limit);

        tCall = performance.now();
        const p = el.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            el.removeEventListener('playing', onPlaying);
            el.removeEventListener('ended', onEnded);
            el.removeEventListener('error', onError);
            this.speaking = false;
            reject(err);
          });
        }
      });
    }

    /** Debug-only: no audio files, timing proportional to the transcript length. */
    async _playSimulated(clipId) {
      const text = this.transcripts.get(clipId) || '';
      const words = text.split(/\s+/).filter(Boolean).length;
      const ms = Math.max(1200, words * CONFIG.simulatedMsPerWord);
      this.speaking = true;
      this._simStart = performance.now();
      await sleep(ms);
      this.speaking = false;
      return { durationMs: ms, onsetMs: 0, watchdogFired: false, simulated: true };
    }

    /**
     * Current loudness (0..1) and `nBands` spectral bands (0..1) for animation.
     * Simulated mode synthesises a speech-like envelope.
     */
    sample(nBands) {
      const bands = new Float32Array(nBands);
      if (!this.speaking) return { level: 0, bands };

      if (this.simulated || !this.analyser) {
        const t = (performance.now() - this._simStart) / 1000;
        const syll = Math.abs(Math.sin(t * 9.1)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 1.1));
        const level = clamp(0.15 + 0.7 * syll, 0, 1);
        for (let i = 0; i < nBands; i++) {
          const shape = Math.exp(-Math.pow((i / nBands - 0.3) * 2.6, 2));
          bands[i] = clamp(level * shape * (0.7 + 0.3 * Math.sin(t * 13 + i)), 0, 1);
        }
        return { level, bands };
      }

      this.analyser.getByteTimeDomainData(this.timeData);
      let sum = 0;
      for (let i = 0; i < this.timeData.length; i++) {
        const v = (this.timeData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.timeData.length);
      const level = clamp((rms - 0.008) * 5.5, 0, 1);

      // Speech energy lives below ~5 kHz; spread those bins over nBands on a log-ish scale.
      this.analyser.getByteFrequencyData(this.freqData);
      const nyquist = this.ctx.sampleRate / 2;
      const maxBin = Math.min(this.freqData.length - 1, Math.floor(5000 / nyquist * this.freqData.length));
      for (let b = 0; b < nBands; b++) {
        const lo = Math.max(1, Math.floor(Math.pow(maxBin, b / nBands)));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(maxBin, (b + 1) / nBands)));
        let peak = 0;
        for (let i = lo; i < hi && i < this.freqData.length; i++) peak = Math.max(peak, this.freqData[i]);
        bands[b] = peak / 255;
      }
      return { level, bands };
    }
  }

  // ======================================================================
  // AvatarRenderer — condition-specific SVG avatars
  // ======================================================================

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Human therapist: warm illustrated portrait with breathing, blinking, lip-sync. */
  function buildHuman() {
    const markup = `
<svg viewBox="0 0 400 400" xmlns="${SVG_NS}" class="avatar-svg">
  <defs>
    <radialGradient id="h-skin" cx="50%" cy="38%" r="65%">
      <stop offset="0" stop-color="#f0c4a4"/><stop offset="1" stop-color="#d39a77"/>
    </radialGradient>
    <linearGradient id="h-hair" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4b3527"/><stop offset="1" stop-color="#2d1f16"/>
    </linearGradient>
    <linearGradient id="h-top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b6c88"/><stop offset="1" stop-color="#3e4b63"/>
    </linearGradient>
  </defs>
  <g id="h-body">
    <path d="M62 400 C 70 326, 136 294, 200 294 C 264 294, 330 326, 338 400 Z" fill="url(#h-top)"/>
    <path d="M164 296 L200 336 L236 296 L226 292 L200 318 L174 292 Z" fill="#ece6dd"/>
  </g>
  <g id="h-head">
    <path d="M176 226 L176 300 Q200 314 224 300 L224 226 Z" fill="#cf9472"/>
    <path d="M116 176 C 104 92, 156 58, 204 60 C 256 62, 298 100, 286 180 L 282 236 C 270 206, 268 168, 262 146 L 140 146 C 132 168, 130 206, 120 236 Z" fill="url(#h-hair)"/>
    <ellipse cx="128" cy="180" rx="11" ry="18" fill="#d59c7b"/>
    <ellipse cx="272" cy="180" rx="11" ry="18" fill="#d59c7b"/>
    <ellipse cx="200" cy="174" rx="72" ry="88" fill="url(#h-skin)"/>
    <ellipse cx="160" cy="200" rx="14" ry="8" fill="#e58f7b" opacity="0.22"/>
    <ellipse cx="240" cy="200" rx="14" ry="8" fill="#e58f7b" opacity="0.22"/>
    <path d="M128 146 C 136 94, 190 78, 224 86 C 258 94, 280 122, 274 154 C 252 126, 214 112, 180 118 C 158 122, 140 132, 128 146 Z" fill="url(#h-hair)"/>
    <g id="h-brows">
      <path d="M150 142 Q167 132 184 139" stroke="#3a281c" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M216 139 Q233 132 250 142" stroke="#3a281c" stroke-width="5" fill="none" stroke-linecap="round"/>
    </g>
    <g id="h-eye-l">
      <ellipse cx="168" cy="164" rx="13" ry="8.5" fill="#fbf8f4"/>
      <g class="iris"><circle cx="168" cy="164" r="6.5" fill="#5a3c29"/><circle cx="168" cy="164" r="3" fill="#1b120c"/><circle cx="170.5" cy="161.5" r="1.6" fill="#fff"/></g>
      <path d="M154.5 162 Q168 152 181.5 162" stroke="#5e3f2e" stroke-width="2" fill="none" stroke-linecap="round"/>
    </g>
    <g id="h-eye-r">
      <ellipse cx="232" cy="164" rx="13" ry="8.5" fill="#fbf8f4"/>
      <g class="iris"><circle cx="232" cy="164" r="6.5" fill="#5a3c29"/><circle cx="232" cy="164" r="3" fill="#1b120c"/><circle cx="234.5" cy="161.5" r="1.6" fill="#fff"/></g>
      <path d="M218.5 162 Q232 152 245.5 162" stroke="#5e3f2e" stroke-width="2" fill="none" stroke-linecap="round"/>
    </g>
    <path d="M200 172 Q195 194 190 201 Q200 207 210 201" stroke="#b67a5b" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <g id="h-mouth">
      <ellipse id="h-mouth-inner" cx="200" cy="229" rx="18" ry="1.5" fill="#5b2a2a"/>
      <rect id="h-teeth" x="189" y="225" width="22" height="4" rx="2" fill="#f4efe9" opacity="0"/>
      <path d="M180 228 Q190 221 200 224.5 Q210 221 220 228 Q200 231 180 228 Z" fill="#b65d57"/>
      <path id="h-lower-lip" d="M182 230 Q200 241 218 230 Q200 235 182 230 Z" fill="#c4675f"/>
    </g>
  </g>
</svg>`;
    return {
      markup,
      bind(root) {
        const q = (s) => root.querySelector(s);
        return {
          head: q('#h-head'), body: q('#h-body'), brows: q('#h-brows'),
          eyes: [q('#h-eye-l'), q('#h-eye-r')], irises: root.querySelectorAll('.iris'),
          inner: q('#h-mouth-inner'), teeth: q('#h-teeth'), lower: q('#h-lower-lip'),
          eyeCenters: [[168, 164], [232, 164]],
        };
      },
      update(r, s) {
        const open = s.level;
        r.body.setAttribute('transform', `translate(0 ${(Math.sin(s.t * 1.6) * 1.2).toFixed(2)})`);
        const tilt = Math.sin(s.t * 0.5) * 1.2 + (s.speaking ? Math.sin(s.t * 3.1) * open * 1.6 : 0);
        r.head.setAttribute('transform', `rotate(${tilt.toFixed(2)} 200 290) translate(0 ${(Math.sin(s.t * 1.6) * 0.8).toFixed(2)})`);
        r.brows.setAttribute('transform', `translate(0 ${(-open * 3).toFixed(2)})`);
        r.eyes.forEach((g, i) => {
          const [cx, cy] = r.eyeCenters[i];
          g.setAttribute('transform', `translate(${cx} ${cy}) scale(1 ${s.blink.toFixed(3)}) translate(${-cx} ${-cy})`);
        });
        r.irises.forEach((g) => g.setAttribute('transform', `translate(${s.gaze[0].toFixed(2)} ${s.gaze[1].toFixed(2)})`));
        r.inner.setAttribute('ry', (1.5 + open * 11).toFixed(2));
        r.inner.setAttribute('rx', (18 - open * 3).toFixed(2));
        r.inner.setAttribute('cy', (229 + open * 4).toFixed(2));
        r.teeth.setAttribute('opacity', open > 0.18 ? '0.85' : '0');
        r.lower.setAttribute('transform', `translate(0 ${(open * 9).toFixed(2)})`);
      },
    };
  }

  /** Furhat: back-projected face on a translucent mask, fur hat, neck on a base. */
  function buildFurhat() {
    // Fur tufts along the hat brim, generated so the outline looks organic.
    let tufts = '';
    for (let i = 0; i <= 22; i++) {
      const u = i / 22;
      const x = 116 + u * 168;
      const y = 140 - Math.sin(u * Math.PI) * 26 + (i % 2) * 3;
      tufts += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(10 + (i % 3) * 1.6).toFixed(1)}"/>`;
    }
    const markup = `
<svg viewBox="0 0 400 400" xmlns="${SVG_NS}" class="avatar-svg">
  <defs>
    <radialGradient id="f-mask" cx="50%" cy="44%" r="62%">
      <stop offset="0" stop-color="#fbf8f3"/><stop offset="0.7" stop-color="#ebe4db"/><stop offset="1" stop-color="#c9c0b5"/>
    </radialGradient>
    <radialGradient id="f-light" cx="50%" cy="50%" r="55%">
      <stop offset="0" stop-color="#d8e8ff" stop-opacity="0.55"/><stop offset="1" stop-color="#d8e8ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="f-base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b4049"/><stop offset="1" stop-color="#1f232a"/>
    </linearGradient>
    <linearGradient id="f-hat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a08164"/><stop offset="1" stop-color="#6c543f"/>
    </linearGradient>
    <filter id="f-proj" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.9"/></filter>
    <filter id="f-fur" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="7"/>
    </filter>
  </defs>
  <path d="M108 400 C 118 334, 160 320, 200 320 C 240 320, 282 334, 292 400 Z" fill="url(#f-base)"/>
  <ellipse cx="200" cy="322" rx="48" ry="9" fill="#4a505b"/>
  <g id="f-head">
    <rect x="174" y="262" width="52" height="62" rx="10" fill="#2b3038"/>
    <path id="f-mask-shape" d="M200 72 C 262 72, 282 128, 280 180 C 278 238, 244 282, 200 284 C 156 282, 122 238, 120 180 C 118 128, 138 72, 200 72 Z" fill="url(#f-mask)"/>
    <path d="M200 72 C 262 72, 282 128, 280 180 C 278 238, 244 282, 200 284 C 156 282, 122 238, 120 180 C 118 128, 138 72, 200 72 Z" fill="url(#f-light)"/>
    <g id="f-face" filter="url(#f-proj)">
      <g id="f-brows" opacity="0.8">
        <path d="M152 150 Q168 141 185 147" stroke="#7d726b" stroke-width="4.5" fill="none" stroke-linecap="round"/>
        <path d="M215 147 Q232 141 248 150" stroke="#7d726b" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      </g>
      <g id="f-eye-l">
        <ellipse cx="168" cy="172" rx="15" ry="10.5" fill="#fdfcfa"/>
        <g class="iris"><circle cx="168" cy="172" r="8" fill="#6f8aa7"/><circle cx="168" cy="172" r="3.8" fill="#1c2734"/><circle cx="171" cy="169" r="1.8" fill="#fff"/></g>
      </g>
      <g id="f-eye-r">
        <ellipse cx="232" cy="172" rx="15" ry="10.5" fill="#fdfcfa"/>
        <g class="iris"><circle cx="232" cy="172" r="8" fill="#6f8aa7"/><circle cx="232" cy="172" r="3.8" fill="#1c2734"/><circle cx="235" cy="169" r="1.8" fill="#fff"/></g>
      </g>
      <path d="M200 182 Q196 200 192 206 Q200 211 208 206" stroke="#cdbfb2" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <ellipse id="f-mouth-inner" cx="200" cy="233" rx="17" ry="1.5" fill="#7a3a3e"/>
      <path d="M182 232 Q200 226 218 232 Q200 235 182 232 Z" fill="#d08a84"/>
      <path id="f-lower-lip" d="M184 234 Q200 243 216 234 Q200 238 184 234 Z" fill="#d9958e"/>
    </g>
    <g filter="url(#f-fur)" fill="url(#f-hat)">
      <path d="M116 142 C 110 80, 150 38, 200 36 C 250 38, 290 80, 284 142 C 262 120, 232 110, 200 110 C 168 110, 138 120, 116 142 Z"/>
      ${tufts}
    </g>
  </g>
</svg>`;
    return {
      markup,
      bind(root) {
        const q = (s) => root.querySelector(s);
        return {
          head: q('#f-head'), brows: q('#f-brows'),
          eyes: [q('#f-eye-l'), q('#f-eye-r')], irises: root.querySelectorAll('.iris'),
          inner: q('#f-mouth-inner'), lower: q('#f-lower-lip'),
          eyeCenters: [[168, 172], [232, 172]],
        };
      },
      update(r, s) {
        const open = s.level;
        // Furhat's neck servo: slow sway, small nods while speaking.
        const tilt = Math.sin(s.t * 0.45) * 2 + (s.speaking ? Math.sin(s.t * 2.2) * 1.4 : 0);
        const nod = s.speaking ? Math.sin(s.t * 4.2) * open * 2.4 : 0;
        r.head.setAttribute('transform', `rotate(${tilt.toFixed(2)} 200 300) translate(0 ${nod.toFixed(2)})`);
        r.brows.setAttribute('transform', `translate(0 ${(-open * 4).toFixed(2)})`);
        r.eyes.forEach((g, i) => {
          const [cx, cy] = r.eyeCenters[i];
          g.setAttribute('transform', `translate(${cx} ${cy}) scale(1 ${s.blink.toFixed(3)}) translate(${-cx} ${-cy})`);
        });
        r.irises.forEach((g) => g.setAttribute('transform', `translate(${(s.gaze[0] * 1.3).toFixed(2)} ${(s.gaze[1] * 1.3).toFixed(2)})`));
        r.inner.setAttribute('ry', (1.5 + open * 10).toFixed(2));
        r.inner.setAttribute('cy', (233 + open * 4).toFixed(2));
        r.lower.setAttribute('transform', `translate(0 ${(open * 8.5).toFixed(2)})`);
      },
    };
  }

  /** Mechanical (Peerbot-style) robot: metal head, camera-lens eyes, LED-matrix mouth. */
  function buildPeerbot() {
    const COLS = 13, ROWS = 5, CW = 7, CH = 5, GAP = 3;
    const x0 = 200 - (COLS * (CW + GAP) - GAP) / 2;
    const y0 = 190;
    let leds = '';
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        leds += `<rect class="led" data-c="${c}" data-r="${r}" x="${(x0 + c * (CW + GAP)).toFixed(1)}" y="${y0 + r * (CH + GAP)}" width="${CW}" height="${CH}" rx="1.2"/>`;
      }
    }
    const markup = `
<svg viewBox="0 0 400 400" xmlns="${SVG_NS}" class="avatar-svg">
  <defs>
    <linearGradient id="p-metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d3d9e0"/><stop offset="0.55" stop-color="#9aa4b0"/><stop offset="1" stop-color="#6d7783"/>
    </linearGradient>
    <linearGradient id="p-dark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#363d47"/><stop offset="1" stop-color="#1d2128"/>
    </linearGradient>
    <radialGradient id="p-lens" cx="42%" cy="38%" r="70%">
      <stop offset="0" stop-color="#3fb7e6"/><stop offset="0.45" stop-color="#0d4566"/><stop offset="1" stop-color="#04111b"/>
    </radialGradient>
    <filter id="p-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g id="p-body">
    <rect x="108" y="304" width="184" height="110" rx="14" fill="url(#p-metal)" stroke="#5b6470" stroke-width="3"/>
    <rect x="132" y="324" width="70" height="44" rx="6" fill="url(#p-dark)"/>
    <g stroke="#7b8692" stroke-width="3" stroke-linecap="round">
      <line x1="222" y1="330" x2="270" y2="330"/><line x1="222" y1="340" x2="270" y2="340"/>
      <line x1="222" y1="350" x2="270" y2="350"/><line x1="222" y1="360" x2="270" y2="360"/>
    </g>
    <circle id="p-status-1" cx="146" cy="346" r="5" fill="#2bd98b"/>
    <circle id="p-status-2" cx="166" cy="346" r="5" fill="#3a434e"/>
    <circle id="p-status-3" cx="186" cy="346" r="5" fill="#3a434e"/>
  </g>
  <g id="p-neck">
    <rect x="178" y="262" width="9" height="46" rx="3" fill="#4a525d"/>
    <rect x="213" y="262" width="9" height="46" rx="3" fill="#4a525d"/>
    <rect x="193" y="268" width="14" height="40" rx="3" fill="#69727e"/>
  </g>
  <g id="p-head">
    <line x1="200" y1="72" x2="200" y2="40" stroke="#5b6470" stroke-width="4"/>
    <circle id="p-antenna" cx="200" cy="36" r="6" fill="#ff5a4f"/>
    <rect x="86" y="138" width="20" height="58" rx="6" fill="url(#p-dark)"/>
    <rect x="294" y="138" width="20" height="58" rx="6" fill="url(#p-dark)"/>
    <rect x="104" y="72" width="192" height="196" rx="22" fill="url(#p-metal)" stroke="#5b6470" stroke-width="3"/>
    <g fill="#6d7783">
      <circle cx="118" cy="86" r="3.5"/><circle cx="282" cy="86" r="3.5"/>
      <circle cx="118" cy="254" r="3.5"/><circle cx="282" cy="254" r="3.5"/>
    </g>
    <rect x="122" y="94" width="156" height="150" rx="14" fill="url(#p-dark)"/>
    <g id="p-eye-l">
      <circle cx="164" cy="142" r="23" fill="#14181e" stroke="#8d97a3" stroke-width="3"/>
      <circle cx="164" cy="142" r="16" fill="url(#p-lens)"/>
      <circle cx="164" cy="142" r="10" fill="none" stroke="#2fc4ff" stroke-width="1.5" opacity="0.6"/>
      <circle class="pupil" cx="164" cy="142" r="5" fill="#9cecff" filter="url(#p-glow)"/>
    </g>
    <g id="p-eye-r">
      <circle cx="236" cy="142" r="23" fill="#14181e" stroke="#8d97a3" stroke-width="3"/>
      <circle cx="236" cy="142" r="16" fill="url(#p-lens)"/>
      <circle cx="236" cy="142" r="10" fill="none" stroke="#2fc4ff" stroke-width="1.5" opacity="0.6"/>
      <circle class="pupil" cx="236" cy="142" r="5" fill="#9cecff" filter="url(#p-glow)"/>
    </g>
    <g id="p-mouth">${leds}</g>
  </g>
</svg>`;
    return {
      markup,
      bind(root) {
        const leds = Array.from(root.querySelectorAll('.led')).map((el) => ({
          el, c: Number(el.getAttribute('data-c')), r: Number(el.getAttribute('data-r')), on: null,
        }));
        return {
          head: root.querySelector('#p-head'), antenna: root.querySelector('#p-antenna'),
          pupils: root.querySelectorAll('.pupil'), leds, cols: COLS, rows: ROWS,
          status: [root.querySelector('#p-status-2'), root.querySelector('#p-status-3')],
          servo: { angle: 0, target: 0, next: 0 },
        };
      },
      update(r, s) {
        // Servo-like motion: discrete targets approached quickly, then held.
        if (s.t > r.servo.next) {
          r.servo.target = s.speaking ? (Math.random() * 5 - 2.5) : (Math.random() * 2 - 1);
          r.servo.next = s.t + (s.speaking ? 0.6 + Math.random() * 0.6 : 1.8 + Math.random() * 1.5);
        }
        r.servo.angle = lerp(r.servo.angle, r.servo.target, 0.25);
        r.head.setAttribute('transform', `rotate(${r.servo.angle.toFixed(2)} 200 268)`);

        r.antenna.setAttribute('fill', (Math.floor(s.t * 1.25) % 2 === 0) ? '#ff5a4f' : '#5c2a28');
        r.status[0].setAttribute('fill', s.speaking ? '#ffb020' : '#3a434e');
        r.status[1].setAttribute('fill', s.awaitingInput ? '#39d0ff' : '#3a434e');

        const glow = 4 + s.level * 3;
        r.pupils.forEach((p) => {
          p.setAttribute('r', glow.toFixed(2));
          p.setAttribute('transform', `translate(${(s.gaze[0] * 1.6).toFixed(2)} ${(s.gaze[1] * 1.2).toFixed(2)})`);
        });

        // LED equaliser mouth: each column follows one band, lit symmetrically around the centre row.
        const mid = (r.rows - 1) / 2;
        r.leds.forEach((led) => {
          const band = s.bands[Math.min(s.bands.length - 1, Math.abs(led.c - (r.cols - 1) / 2) | 0)] || 0;
          const amp = s.speaking ? clamp(band * 1.2 * (0.5 + s.level), 0, 1) : 0;
          const lit = s.speaking ? Math.abs(led.r - mid) <= amp * (mid + 0.5) : led.r === mid;
          const state = lit ? (s.speaking ? 'on' : 'idle') : 'off';
          if (state !== led.on) {
            led.el.setAttribute('fill', state === 'on' ? '#39d0ff' : state === 'idle' ? '#1f6f8f' : '#10303c');
            led.on = state;
          }
        });
      },
    };
  }

  const AVATAR_BUILDERS = { human: buildHuman, furhat: buildFurhat, peerbot: buildPeerbot };

  class AvatarRenderer {
    /**
     * @param {HTMLElement} stage
     * @param {{avatar:string, key:string}} cond
     * @param {HTMLImageElement|null} portrait  preloaded image, replaces the drawn avatar
     * @param {HTMLVideoElement} [idleVideo]    video mode: preloaded idle loop, replaces the drawn avatar
     */
    constructor(stage, cond, portrait, idleVideo) {
      this.stage = stage;
      this.stage.setAttribute('data-avatar', cond.avatar);
      this.level = 0;
      this.blinkStart = -1;
      this.nextBlink = 1.5;
      this.gaze = [0, 0];
      this.gazeTarget = [0, 0];
      this.nextSaccade = 1;
      this.clip = null;

      if (idleVideo) {
        // The idle loop runs (muted) for the whole session as the backdrop;
        // clip videos are layered on top while they play.
        idleVideo.className = 'avatar-video';
        this.stage.replaceChildren(idleVideo);
        this.idle = idleVideo;
        const p = idleVideo.play();   // muted, so autoplay is permitted
        if (p && typeof p.catch === 'function') p.catch((err) => console.warn('Idle loop did not start', err));
        return;
      }
      if (portrait) {
        portrait.className = 'avatar-portrait';
        portrait.alt = '';
        this.stage.replaceChildren(portrait);
        this.portrait = true;
        return;
      }
      this.impl = AVATAR_BUILDERS[cond.avatar]();
      this.stage.innerHTML = this.impl.markup;   // static markup, no user data
      this.refs = this.impl.bind(this.stage);
    }

    /**
     * Video mode: put a clip's <video> over the idle loop. It becomes visible
     * on its first 'playing' event, so the idle frame stays up until the clip
     * actually has a picture (no black flash).
     */
    showClip(el) {
      if (!this.idle) return;
      this.hideClip();
      el.className = 'avatar-video avatar-clip';
      el.addEventListener('playing', () => el.classList.add('is-visible'), { once: true });
      this.stage.appendChild(el);
      this.clip = el;
    }

    /** Video mode: remove the finished clip, revealing the idle loop again. */
    hideClip() {
      if (!this.clip) return;
      this.clip.classList.remove('is-visible');
      this.clip.remove();
      this.clip = null;
    }

    frame(tSec, sample, speaking, awaitingInput) {
      // Asymmetric smoothing: mouths open fast and close a little slower.
      const k = sample.level > this.level ? 0.55 : 0.22;
      this.level = lerp(this.level, sample.level, k);
      this.stage.style.setProperty('--level', this.level.toFixed(3));

      if (this.portrait || this.idle) return;

      // Blinks every 2.5–6 s, ~150 ms long.
      if (tSec > this.nextBlink && this.blinkStart < 0) this.blinkStart = tSec;
      let blink = 1;
      if (this.blinkStart >= 0) {
        const p = (tSec - this.blinkStart) / 0.15;
        if (p >= 1) { this.blinkStart = -1; this.nextBlink = tSec + 2.5 + Math.random() * 3.5; }
        else blink = 1 - Math.sin(p * Math.PI) * 0.92;
      }
      // Small gaze shifts; steadier eye contact while speaking.
      if (tSec > this.nextSaccade) {
        const range = speaking ? 1.2 : 2.6;
        this.gazeTarget = [(Math.random() * 2 - 1) * range, (Math.random() * 2 - 1) * range * 0.6];
        this.nextSaccade = tSec + 0.8 + Math.random() * 2.2;
      }
      this.gaze = [lerp(this.gaze[0], this.gazeTarget[0], 0.2), lerp(this.gaze[1], this.gazeTarget[1], 0.2)];

      this.impl.update(this.refs, {
        t: tSec, level: this.level, bands: sample.bands, speaking, awaitingInput, blink, gaze: this.gaze,
      });
    }
  }

  // ======================================================================
  // Visualizer — identical neutral styling across conditions
  // ======================================================================

  class Visualizer {
    constructor(canvas, nBars) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.n = nBars;
      this.smooth = new Float32Array(nBars);
      this.resize = this.resize.bind(this);
      window.addEventListener('resize', this.resize);
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, rect.width);
      this.h = Math.max(1, rect.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    draw(bands, speaking) {
      const { ctx, w, h, n } = this;
      ctx.clearRect(0, 0, w, h);
      const gap = 3;
      const bw = (w - gap * (n - 1)) / n;
      const mid = h / 2;
      ctx.fillStyle = speaking ? '#6b7f99' : '#b9c3cf';
      for (let i = 0; i < n; i++) {
        // Mirror the spectrum so low frequencies sit in the centre.
        const src = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
        const b = bands[Math.min(bands.length - 1, Math.floor(src * bands.length))] || 0;
        this.smooth[i] = lerp(this.smooth[i], speaking ? b : 0, 0.35);
        const bh = Math.max(2, this.smooth[i] * (h - 6));
        const x = i * (bw + gap);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, bw, bh, Math.min(bw / 2, 3));
        else ctx.rect(x, mid - bh / 2, bw, bh);
        ctx.fill();
      }
    }
  }

  // ======================================================================
  // DataCollector
  // ======================================================================

  class DataCollector {
    constructor({ uniqueId, condition, conditionLabel, mode, psiTurk, onConnectivity }) {
      this.uniqueId = uniqueId;
      this.condition = condition;
      this.conditionLabel = conditionLabel;
      this.mode = mode;
      this.psiTurk = psiTurk;
      this.runId = randomId();
      this.trialIndex = 0;
      this.pending = new Set();
      this.failed = [];
      this.onConnectivity = onConnectivity || (() => {});
      this.tOptionsShown = null;
    }

    /** Called when the options have been painted and enabled. */
    markOptionsShown(t) { this.tOptionsShown = t; }

    /** Latency in ms: t_click − t_options_shown. */
    latency(tEvent) { return tEvent - this.tOptionsShown; }

    /**
     * Build, mirror to psiTurk, and send one trial record. Returns immediately;
     * the request runs in the background and is awaited by flush().
     */
    record(fields) {
      const payload = Object.assign({
        unique_id: this.uniqueId,
        run_id: this.runId,
        condition: this.condition,
        condition_label: this.conditionLabel,
        trial_index: this.trialIndex++,
        options_shown_epoch_ms: performance.timeOrigin + this.tOptionsShown,
        client_timestamp: new Date().toISOString(),
      }, fields);

      if (this.psiTurk) {
        try { this.psiTurk.recordTrialData(Object.assign({ phase: 'dialogue' }, payload)); }
        catch (err) { console.warn('psiTurk.recordTrialData failed', err); }
      }
      const p = this._send(payload).finally(() => this.pending.delete(p));
      this.pending.add(p);
      return payload;
    }

    async _send(payload) {
      for (let attempt = 1; attempt <= CONFIG.saveMaxAttempts; attempt++) {
        try {
          const resp = await fetch('/api/save_trial', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (resp.ok) { this.onConnectivity(true); return true; }
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
            // Validation errors will not succeed on retry; keep for diagnosis.
            const body = await resp.text();
            console.error('Trial rejected by server', resp.status, body, payload);
            this.failed.push({ payload, permanent: true, reason: resp.status + ' ' + body });
            return false;
          }
        } catch (err) {
          console.warn('save_trial attempt', attempt, 'failed', err);
        }
        this.onConnectivity(false);
        await sleep(CONFIG.saveBaseDelayMs * Math.pow(2, attempt - 1));
      }
      this.failed.push({ payload, permanent: false });
      return false;
    }

    /** Wait for in-flight saves, retry transient failures once more. Resolves true when everything is stored. */
    async flush() {
      await Promise.allSettled(Array.from(this.pending));
      const retry = this.failed.filter((f) => !f.permanent);
      this.failed = this.failed.filter((f) => f.permanent);
      const results = await Promise.all(retry.map((f) => this._send(f.payload)));
      return results.every(Boolean) && this.failed.length === 0;
    }

    /** psiTurk's own datastring save (Promise wrapper). Failure is non-fatal: the custom tables are primary. */
    savePsiTurk() {
      return new Promise((resolve) => {
        if (!this.psiTurk) return resolve(false);
        try {
          this.psiTurk.saveData({ success: () => resolve(true), error: () => resolve(false) });
        } catch (err) {
          console.warn('psiTurk.saveData failed', err);
          resolve(false);
        }
      });
    }
  }

  // ======================================================================
  // Session — orchestration and UI
  // ======================================================================

  class Session {
    constructor() {
      this.cond = CONDITIONS[condition];
      this.engine = null;
      this.player = null;
      this.avatar = null;
      this.visualizer = null;
      this.collector = null;
      this.psiTurk = null;
      this.assets = null;
      this.awaitingInput = false;
      this.path = [];
      this.t0 = performance.now();
      this.ui = {
        modal: $('preload-modal'), loading: $('preload-loading'), fill: $('preload-fill'),
        progress: $('preload-progress'), count: $('preload-count'), bytes: $('preload-bytes'),
        error: $('preload-error'), errorText: $('preload-error-text'), missing: $('preload-missing'),
        retry: $('preload-retry'), simulate: $('preload-simulate'),
        soundcheck: $('soundcheck'), tone: $('tone-btn'), toneOk: $('tone-ok'), begin: $('begin-btn'),
        card: $('question-card'), eyebrow: $('question-eyebrow'), question: $('question-text'),
        caption: $('caption'), options: $('options'), resume: $('resume'), resumeBtn: $('resume-btn'),
        pill: $('status-pill'), status: $('status-text'), track: $('stage-track'),
        saveWarning: $('save-warning'),
        finish: $('finish-modal'), finishTitle: $('finish-title'), finishMsg: $('finish-message'),
        finishSpinner: $('finish-spinner'), finishActions: $('finish-actions'), finishRetry: $('finish-retry'),
      };
    }

    // ---------------------------------------------------------------- setup

    async init() {
      if (!this.cond) {
        return this.fatal('This session has an invalid condition (' + condition + '). ' +
          'Check that config.txt sets num_conds = 3, then start a new session.');
      }
      try {
        this.engine = new BranchingEngine(DIALOGUE_TREE);
      } catch (err) {
        return this.fatal(err.message);
      }

      if (typeof PsiTurk === 'function') {
        try {
          this.psiTurk = new PsiTurk(uniqueId, adServerLoc, mode);
          this.psiTurk.recordUnstructuredData('condition_label', this.cond.key);
          this.psiTurk.recordUnstructuredData('user_agent', navigator.userAgent);
        } catch (err) {
          console.warn('psiTurk client unavailable; continuing with custom endpoints only.', err);
        }
      } else {
        console.warn('psiturk.js not loaded; continuing with custom endpoints only.');
      }

      this.video = this.cond.media === 'video';
      if (this.psiTurk) this.psiTurk.recordUnstructuredData('media_mode', this.video ? 'video' : 'audio');

      this.collector = new DataCollector({
        uniqueId, condition, conditionLabel: this.cond.key, mode, psiTurk: this.psiTurk,
        onConnectivity: (ok) => { this.ui.saveWarning.hidden = ok; },
      });

      this.visualizer = new Visualizer($('visualizer'), 28);
      this.ui.retry.addEventListener('click', () => this.preload());
      this.ui.simulate.addEventListener('click', () => this.enterSoundcheck(new Map(), true));
      this.ui.tone.addEventListener('click', () => this.player && this.player.playTestTone());
      this.ui.toneOk.addEventListener('change', () => { this.ui.begin.disabled = !this.ui.toneOk.checked; });
      this.ui.begin.addEventListener('click', () => this.begin());

      // Audio mode: draw the avatar immediately so participants see the same
      // scene while loading. Video mode: the stage stays empty until the idle
      // loop has loaded (a drawn avatar would be a different embodiment).
      if (this.video) {
        $('preload-message').textContent = 'Loading the video so the conversation plays smoothly. This can take up to a minute.';
      } else {
        this.avatar = new AvatarRenderer($('avatar-stage'), this.cond, null);
      }
      requestAnimationFrame((t) => this.loop(t));

      await this.preload();
    }

    manifest() {
      if (this.video) {
        const dir = CONFIG.videoBase + '/' + this.cond.key + '/';
        const list = this.engine.clipIds().map((id) => ({ id, url: dir + id + CONFIG.videoExt, kind: 'video' }));
        list.push({ id: '__idle', url: dir + CONFIG.idleClipId + CONFIG.videoExt, kind: 'video', muted: true, loop: true });
        return list;
      }
      const dir = CONFIG.audioBase + '/' + this.cond.key + '/';
      const list = this.engine.clipIds().map((id) => ({ id, url: dir + id + CONFIG.audioExt, kind: 'audio' }));
      if (this.cond.portrait) list.push({ id: '__portrait', url: this.cond.portrait, kind: 'image' });
      return list;
    }

    async preload() {
      const ui = this.ui;
      ui.error.hidden = true;
      ui.loading.hidden = false;
      ui.soundcheck.hidden = true;

      const preloader = new Preloader(this.manifest(), (p) => {
        const pct = Math.round(p.fraction * 100);
        ui.fill.style.width = pct + '%';
        ui.progress.setAttribute('aria-valuenow', String(pct));
        ui.count.textContent = p.done + ' of ' + p.total + ' files';
        ui.bytes.textContent = formatBytes(p.bytes);
      });

      try {
        const assets = await preloader.load();
        const portrait = assets.get('__portrait');
        const idle = assets.get('__idle');
        if (idle) this.avatar = new AvatarRenderer($('avatar-stage'), this.cond, null, idle.el);
        else if (portrait) this.avatar = new AvatarRenderer($('avatar-stage'), this.cond, portrait.el);
        this.enterSoundcheck(assets, false);
      } catch (err) {
        ui.loading.hidden = true;
        ui.error.hidden = false;
        ui.missing.replaceChildren();
        const failures = err instanceof PreloadError ? err.failures : [{ url: '', reason: String(err) }];
        // A short list keeps the dialog within the window (it never scrolls).
        failures.slice(0, 8).forEach((f) => {
          const li = document.createElement('li');
          li.textContent = f.url + ' — ' + f.reason;
          ui.missing.appendChild(li);
        });
        if (failures.length > 8) {
          const li = document.createElement('li');
          li.textContent = '… and ' + (failures.length - 8) + ' more';
          ui.missing.appendChild(li);
        }
        ui.simulate.hidden = mode !== 'debug';
        console.error('Preload failed', failures);
      }
    }

    enterSoundcheck(assets, simulated) {
      this.assets = assets;
      this.player = new AudioPlayer(assets, { simulated, transcripts: this.engine.transcripts() });
      this.simulated = simulated;
      if (this.psiTurk) this.psiTurk.recordUnstructuredData('audio_simulated', simulated);
      // Debug fallback in video mode: no clips, so show the drawn avatar instead.
      if (!this.avatar) this.avatar = new AvatarRenderer($('avatar-stage'), this.cond, null);
      this.ui.loading.hidden = true;
      this.ui.error.hidden = true;
      this.ui.soundcheck.hidden = false;
      if (simulated) {
        this.ui.tone.disabled = true;
        this.ui.toneOk.checked = true;
        this.ui.begin.disabled = false;
      }
    }

    async begin() {
      this.ui.begin.disabled = true;
      try { await this.player.unlock(); } catch (err) { console.warn('AudioContext resume failed', err); }
      this.ui.modal.hidden = true;
      window.addEventListener('beforeunload', this.onBeforeUnload);
      if (this.psiTurk) {
        this.psiTurk.recordUnstructuredData('session_started_at', new Date().toISOString());
        // psiTurk lifecycle: POST /inexp marks the participant STARTED (no restarting
        // outside debug mode) and, outside debug mode, arms psiTurk's quitter handler.
        this.psiTurk.finishInstructions();
      }
      await sleep(600);
      this.run().catch((err) => this.fatal('Unexpected error: ' + (err && err.message ? err.message : err)));
    }

    onBeforeUnload(ev) {
      ev.preventDefault();
      ev.returnValue = 'Your conversation is still in progress.';
      return ev.returnValue;
    }

    // ---------------------------------------------------------------- loop

    loop(tNow) {
      const speaking = !!(this.player && this.player.speaking);
      const sample = this.player ? this.player.sample(16) : { level: 0, bands: new Float32Array(16) };
      const t = (tNow - this.t0) / 1000;
      if (this.avatar) this.avatar.frame(t, sample, speaking, this.awaitingInput);
      if (this.visualizer) this.visualizer.draw(sample.bands, speaking);
      requestAnimationFrame((tt) => this.loop(tt));
    }

    setStatus(state, text) {
      this.ui.pill.setAttribute('data-state', state);
      this.ui.status.textContent = text;
    }

    setStage(stage) {
      this.ui.track.querySelectorAll('li').forEach((li) => {
        const s = Number(li.getAttribute('data-stage'));
        li.classList.toggle('is-done', s < stage);
        li.classList.toggle('is-current', s === stage);
      });
    }

    // ---------------------------------------------------------------- dialogue

    async run() {
      let node = this.engine.root();
      while (node) {
        node = await this.runNode(node);
      }
      await this.finish();
    }

    /** One node: prompt audio → options → choice → acknowledgment audio. Returns the next node or null. */
    async runNode(node) {
      this.path.push(node.id);
      this.setStage(node.stage);

      // 1. Therapist speaks the prompt; no options are visible yet.
      this.ui.card.setAttribute('data-state', 'listening');
      this.ui.eyebrow.textContent = 'The therapist is speaking…';
      this.ui.question.textContent = '';
      this.ui.options.replaceChildren();
      this.showCaption(node.prompt);
      this.setStatus('speaking', 'Speaking');
      const prompt = await this.playWithRecovery(node.audio);

      // 2. Options appear only after 'ended'.
      const choice = await this.presentOptions(node);
      const option = node.options[choice.index];

      // 3. Persist the trial (background request; flushed before leaving the page).
      this.collector.record({
        stage: node.stage,
        node_id: node.id,
        question_text: node.question,
        selected_choice_index: choice.index,
        choice_code: option.code,
        choice_text: option.text,
        next_node_id: option.nextNodeId,
        path_so_far: this.path.join('>'),
        choice_latency_ms: choice.latencyMs,
        pointerdown_latency_ms: choice.pointerLatencyMs,
        prompt_audio_duration_ms: prompt.durationMs,
        prompt_audio_onset_ms: prompt.onsetMs,
        input_modality: choice.modality,
        tab_hidden_during_choice: choice.tabHidden,
        audio_simulated: prompt.simulated,
        audio_watchdog_fired: prompt.watchdogFired,
      });

      // 4. Therapist acknowledges the answer.
      this.ui.card.setAttribute('data-state', 'responding');
      this.ui.eyebrow.textContent = 'The therapist is responding…';
      this.showCaption(option.responseTranscript);
      this.setStatus('speaking', 'Speaking');
      await this.playWithRecovery(option.responseAudio);
      this.showCaption(null);
      this.setStatus('idle', 'Listening');

      if (option.nextNodeId === null) return null;
      await sleep(CONFIG.gapAfterResponseMs);
      return this.engine.get(option.nextNodeId);
    }

    /** Captions are only shown in simulated (debug) mode, where there is no sound. */
    showCaption(text) {
      if (!this.simulated || !text) { this.ui.caption.hidden = true; return; }
      this.ui.caption.textContent = '“' + text + '”';
      this.ui.caption.hidden = false;
    }

    /** Play a clip; if the browser blocks playback, ask for a click and retry within that gesture. */
    async playWithRecovery(clipId) {
      const clip = this.assets && this.assets.get(clipId);
      const isVideo = !!(clip && clip.kind === 'video' && this.avatar);
      for (;;) {
        try {
          if (isVideo) this.avatar.showClip(clip.el);
          return await this.player.play(clipId);
        } catch (err) {
          if (!err || err.name !== 'NotAllowedError') throw err;
          this.setStatus('idle', 'Paused');
          this.ui.resume.hidden = false;
          await new Promise((resolve) => this.ui.resumeBtn.addEventListener('click', resolve, { once: true }));
          this.ui.resume.hidden = true;
          await this.player.unlock();
          this.setStatus('speaking', 'Speaking');
        } finally {
          // Clip finished (or failed): reveal the idle loop again.
          if (isVideo) this.avatar.hideClip();
        }
      }
    }

    /**
     * Render the question and buttons, wait for paint, then enable them and
     * start the latency clock. Resolves with the participant's choice.
     */
    async presentOptions(node) {
      const ui = this.ui;
      ui.card.setAttribute('data-state', 'choosing');
      ui.eyebrow.textContent = 'Choose the answer that feels closest to true for you.';
      ui.question.textContent = node.question;
      this.showCaption(null);
      this.setStatus('waiting', 'Your turn');

      const buttons = node.options.map((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'option-btn';
        b.disabled = true;
        b.setAttribute('data-index', String(i));
        const key = document.createElement('span');
        key.className = 'option-key';
        key.textContent = String.fromCharCode(65 + i);
        const label = document.createElement('span');
        label.className = 'option-label';
        label.textContent = opt.text;
        b.append(key, label);
        return b;
      });
      ui.options.replaceChildren(...buttons);

      const tShown = await afterNextPaint();
      this.collector.markOptionsShown(tShown);
      buttons.forEach((b) => { b.disabled = false; });
      this.awaitingInput = true;

      return new Promise((resolve) => {
        let tabHidden = document.hidden;
        let press = null;
        const onVis = () => { if (document.hidden) tabHidden = true; };
        const onDown = (ev) => {
          const btn = ev.target.closest('.option-btn');
          if (btn && !btn.disabled) press = { t: eventTime(ev), type: ev.pointerType || 'mouse', btn };
        };
        const onClick = (ev) => {
          const btn = ev.target.closest('.option-btn');
          if (!btn || btn.disabled) return;
          const tClick = eventTime(ev);
          ui.options.removeEventListener('pointerdown', onDown);
          ui.options.removeEventListener('click', onClick);
          document.removeEventListener('visibilitychange', onVis);
          this.awaitingInput = false;

          const index = Number(btn.getAttribute('data-index'));
          const pressed = press && press.btn === btn;
          // detail === 0 means the click was synthesised by Enter/Space.
          const modality = ev.detail === 0 && !pressed ? 'keyboard' : (pressed ? press.type : 'mouse');

          buttons.forEach((b) => {
            b.disabled = true;
            b.classList.toggle('is-selected', b === btn);
            b.classList.toggle('is-dimmed', b !== btn);
          });

          resolve({
            index,
            latencyMs: this.collector.latency(tClick),
            pointerLatencyMs: pressed ? Math.max(0, this.collector.latency(press.t)) : null,
            modality,
            tabHidden,
          });
        };
        ui.options.addEventListener('pointerdown', onDown);
        ui.options.addEventListener('click', onClick);
        document.addEventListener('visibilitychange', onVis);
      });
    }

    // ---------------------------------------------------------------- end

    async finish() {
      const ui = this.ui;
      this.setStage(7);
      this.setStatus('idle', 'Session complete');
      ui.card.setAttribute('data-state', 'done');
      ui.eyebrow.textContent = 'The conversation has ended.';
      ui.question.textContent = 'Thank you.';
      ui.options.replaceChildren();

      ui.finish.hidden = false;
      ui.finishActions.hidden = true;
      ui.finishSpinner.hidden = false;
      ui.finishTitle.textContent = 'Saving your conversation…';
      ui.finishMsg.textContent = 'One moment, please.';

      if (this.psiTurk) {
        this.psiTurk.recordUnstructuredData('session_finished_at', new Date().toISOString());
        this.psiTurk.recordUnstructuredData('dialogue_path', this.path.join('>'));
      }
      const [stored] = await Promise.all([this.collector.flush(), this.collector.savePsiTurk()]);

      if (!stored) {
        ui.finishSpinner.hidden = true;
        ui.finishTitle.textContent = 'We could not save your answers yet';
        ui.finishMsg.textContent = 'Please check the network connection or ask the researcher for help, then try again.';
        ui.finishActions.hidden = false;
        ui.finishRetry.onclick = () => this.finish();
        return;
      }

      window.removeEventListener('beforeunload', this.onBeforeUnload);
      if (this.psiTurk) this.psiTurk.teardownTask();   // unbinds psiTurk's quitter handler
      ui.finishTitle.textContent = 'Saved';
      ui.finishMsg.textContent = 'Taking you to the final questionnaire…';
      await sleep(700);
      window.location.assign('/posttest?' + new URLSearchParams({ uniqueId, mode }).toString());
    }

    fatal(message) {
      console.error(message);
      this.ui.modal.hidden = false;
      this.ui.loading.hidden = true;
      this.ui.soundcheck.hidden = true;
      this.ui.error.hidden = false;
      this.ui.errorText.textContent = message + ' Please tell the researcher.';
      this.ui.missing.replaceChildren();
      this.ui.retry.hidden = true;
      this.ui.simulate.hidden = true;
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
  }

  // ======================================================================
  // Boot
  // ======================================================================

  function boot() {
    const session = new Session();
    window.__therapistSession = session;   // handy for debugging from the console
    session.init();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
