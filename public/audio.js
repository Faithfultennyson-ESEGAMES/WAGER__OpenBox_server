(function () {
  const MANIFEST = Object.freeze({
    bgMusic: '/assets/BGMusic.mp3',
    win: '/assets/GameWon.mp3',
    lose: '/assets/GameLost.mp3'
  });
  const VOLUMES = Object.freeze({ bgMusic: 0.18, win: 0.82, lose: 0.78 });
  const DUCKED_MUSIC_VOLUME = 0.045;
  const LOOPING = new Set(['bgMusic']);
  const UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'];
  const MUTE_KEY = 'open-box.muted';

  class AudioManager {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.musicGain = null;
      this.sfxGain = null;
      this.buffers = {};
      this.elements = {};
      this.musicSource = null;
      this.musicWanted = true;
      this.unlocked = false;
      this.initialized = false;
      this.musicRetryAttached = false;
      this.musicDuckTimer = null;
      this.musicDucking = false;
      this.muted = this.readMutedPreference();
      this.debug = { playCounts: {}, lastPlayed: '', musicStarts: 0, musicDucks: 0, unlockAttempts: 0 };
      this.ready = Promise.resolve();
    }

    readMutedPreference() {
      try {
        return localStorage.getItem(MUTE_KEY) === '1';
      } catch {
        return false;
      }
    }

    async init() {
      if (this.initialized) return this.ready;
      this.initialized = true;
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) {
        try {
          this.ctx = new Context();
          this.masterGain = this.ctx.createGain();
          this.musicGain = this.ctx.createGain();
          this.sfxGain = this.ctx.createGain();
          this.masterGain.gain.value = this.muted ? 0 : 1;
          this.musicGain.gain.value = VOLUMES.bgMusic;
          this.sfxGain.gain.value = 1;
          this.musicGain.connect(this.masterGain);
          this.sfxGain.connect(this.masterGain);
          this.masterGain.connect(this.ctx.destination);
        } catch {
          this.ctx = null;
          this.masterGain = null;
          this.musicGain = null;
          this.sfxGain = null;
        }
      }

      this.setupUnlock();
      this.attachMusicRetry();
      this.ready = Promise.all(Object.entries(MANIFEST).map(([name, src]) => this.preload(name, src)));
      await this.ready;
      if (this.unlocked) this.startMusic();
      this.emitState();
      return this.ready;
    }

    async preload(name, src) {
      const element = new Audio();
      element.preload = 'auto';
      element.src = src;
      element.loop = LOOPING.has(name);
      element.volume = VOLUMES[name] ?? 0.9;
      element.muted = this.muted;
      element.load();
      this.elements[name] = element;

      if (!this.ctx) return;
      try {
        const response = await fetch(src, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`Audio request failed: ${response.status}`);
        this.buffers[name] = await this.decode(await response.arrayBuffer());
      } catch (error) {
        console.warn(`[open-box-audio] Falling back to HTML audio for ${name}:`, error?.message || error);
      }
    }

    decode(arrayBuffer) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const succeed = (buffer) => {
          if (settled) return;
          settled = true;
          resolve(buffer);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const result = this.ctx.decodeAudioData(arrayBuffer, succeed, fail);
        if (result?.then) result.then(succeed, fail);
      });
    }

    setupUnlock() {
      this.unlockHandler = () => {
        this.debug.unlockAttempts += 1;
        this.resume().then(() => {
          if (!this.ctx || this.ctx.state === 'running') this.finishUnlock();
        });
        if (!this.ctx) this.finishUnlock();
      };
      UNLOCK_EVENTS.forEach((eventName) => window.addEventListener(eventName, this.unlockHandler, { passive: true }));
      this.ctx?.addEventListener('statechange', () => {
        if (this.ctx.state === 'running') this.finishUnlock();
      });
    }

    attachMusicRetry() {
      if (this.musicRetryAttached) return;
      this.musicRetryAttached = true;
      this.musicRetryHandler = () => {
        this.resume();
        if (this.musicWanted && !this.muted && !this.isMusicSourceActive()) this.startMusic();
      };
      UNLOCK_EVENTS.forEach((eventName) => window.addEventListener(eventName, this.musicRetryHandler, { passive: true }));
    }

    detachMusicRetry() {
      if (!this.musicRetryAttached) return;
      this.musicRetryAttached = false;
      UNLOCK_EVENTS.forEach((eventName) => window.removeEventListener(eventName, this.musicRetryHandler));
    }

    isMusicSourceActive() {
      const fallback = this.elements.bgMusic;
      return Boolean(this.musicSource) || Boolean(fallback && !fallback.paused);
    }

    finishUnlock() {
      if (this.unlocked) return;
      this.unlocked = true;
      Object.entries(this.elements).forEach(([name, element]) => {
        if (LOOPING.has(name)) return;
        const wasMuted = element.muted;
        element.muted = true;
        const restore = () => {
          try {
            element.pause();
            element.currentTime = 0;
          } catch {
            // Older WebViews may reject seeking before metadata is ready.
          }
          element.muted = wasMuted;
        };
        const playResult = element.play();
        if (playResult?.then) playResult.then(restore, () => { element.muted = wasMuted; });
        else restore();
      });
      this.startMusic();
      UNLOCK_EVENTS.forEach((eventName) => window.removeEventListener(eventName, this.unlockHandler));
      this.emitState();
    }

    resume() {
      if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume().catch(() => {});
      return Promise.resolve();
    }

    markPlayed(name) {
      this.debug.lastPlayed = name;
      this.debug.playCounts[name] = (this.debug.playCounts[name] || 0) + 1;
      this.emitState();
    }

    play(name, options = {}) {
      if (this.muted) return false;
      if (this.ctx && this.buffers[name]) {
        this.resume();
        const source = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        source.buffer = this.buffers[name];
        if (options.duckMusic) this.duckMusic(source.buffer.duration);
        gain.gain.value = VOLUMES[name] ?? 0.9;
        source.connect(gain);
        gain.connect(this.sfxGain || this.ctx.destination);
        source.start(0);
        this.markPlayed(name);
        return true;
      }

      const element = this.elements[name];
      if (!element) return false;
      const node = element.cloneNode(true);
      node.loop = false;
      node.muted = false;
      node.volume = VOLUMES[name] ?? 0.9;
      if (options.duckMusic) {
        const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 4;
        this.duckMusic(duration);
      }
      node.play()?.catch(() => {});
      this.markPlayed(name);
      return true;
    }

    startMusic() {
      this.musicWanted = true;
      if (this.ctx && this.buffers.bgMusic) {
        if (this.musicSource) return;
        const fallback = this.elements.bgMusic;
        if (fallback) {
          fallback.pause();
          fallback.currentTime = 0;
        }
        this.resume();
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffers.bgMusic;
        source.loop = true;
        source.connect(this.musicGain || this.masterGain || this.ctx.destination);
        source.addEventListener('ended', () => {
          if (this.musicSource === source) this.musicSource = null;
        });
        source.start(0);
        this.musicSource = source;
        this.detachMusicRetry();
        this.debug.musicStarts += 1;
        this.markPlayed('bgMusic');
        return;
      }

      const element = this.elements.bgMusic;
      if (!element || this.muted) return;
      element.loop = true;
      element.muted = false;
      element.play()?.then(() => {
        this.detachMusicRetry();
        this.debug.musicStarts += 1;
        this.markPlayed('bgMusic');
      }).catch(() => {});
    }

    stopMusic() {
      this.musicWanted = false;
      this.detachMusicRetry();
      if (this.musicSource) {
        try { this.musicSource.stop(0); } catch { /* source may already be stopped */ }
        this.musicSource = null;
      }
      this.elements.bgMusic?.pause();
      this.emitState();
    }

    duckMusic(durationSeconds = 4) {
      const holdSeconds = Math.max(0.5, Math.min(12, Number(durationSeconds) || 4));
      this.musicDucking = true;
      this.debug.musicDucks += 1;
      clearTimeout(this.musicDuckTimer);

      if (this.ctx && this.musicGain) {
        const now = this.ctx.currentTime;
        const gain = this.musicGain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value), now);
        gain.linearRampToValueAtTime(DUCKED_MUSIC_VOLUME, now + 0.12);
        gain.setValueAtTime(DUCKED_MUSIC_VOLUME, now + holdSeconds);
        gain.linearRampToValueAtTime(VOLUMES.bgMusic, now + holdSeconds + 0.45);
      }

      const fallback = this.elements.bgMusic;
      if (fallback && !this.musicSource) fallback.volume = DUCKED_MUSIC_VOLUME;
      this.musicDuckTimer = setTimeout(() => {
        this.musicDucking = false;
        if (fallback) fallback.volume = VOLUMES.bgMusic;
        this.emitState();
      }, (holdSeconds + 0.45) * 1000);
      this.emitState();
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* storage can be unavailable */ }
      if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : 1;
      Object.values(this.elements).forEach((element) => { element.muted = this.muted; });
      if (!this.muted && this.musicWanted) {
        this.attachMusicRetry();
        this.startMusic();
      }
      this.emitState();
      return this.muted;
    }

    toggleMuted() {
      return this.setMuted(!this.muted);
    }

    playClick() {
      if (this.muted || !this.ctx || !this.sfxGain) return false;
      this.resume();
      const now = this.ctx.currentTime;
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(660, now);
      oscillator.frequency.exponentialRampToValueAtTime(440, now + 0.05);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      oscillator.connect(gain);
      gain.connect(this.sfxGain);
      oscillator.start(now);
      oscillator.stop(now + 0.1);
      this.markPlayed('click');
      return true;
    }

    playBoxTravel() {
      if (this.muted || !this.ctx || !this.sfxGain) return false;
      this.resume();
      const now = this.ctx.currentTime;
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(125, now);
      oscillator.frequency.exponentialRampToValueAtTime(520, now + 0.48);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(700, now);
      filter.frequency.exponentialRampToValueAtTime(2400, now + 0.48);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.14, now + 0.045);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);
      oscillator.start(now);
      oscillator.stop(now + 0.54);
      this.markPlayed('boxTravel');
      return true;
    }

    playBoxLand() {
      if (this.muted || !this.ctx || !this.sfxGain) return false;
      this.resume();
      const now = this.ctx.currentTime;
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(180, now);
      oscillator.frequency.exponentialRampToValueAtTime(62, now + 0.14);
      gain.gain.setValueAtTime(0.27, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      oscillator.connect(gain);
      gain.connect(this.sfxGain);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
      this.markPlayed('boxLand');
      return true;
    }

    playContainerMove() {
      if (this.muted || !this.ctx || !this.sfxGain) return false;
      this.resume();
      const now = this.ctx.currentTime;
      const motor = this.ctx.createOscillator();
      const motorGain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      const latch = this.ctx.createOscillator();
      const latchGain = this.ctx.createGain();

      motor.type = 'sawtooth';
      motor.frequency.setValueAtTime(92, now);
      motor.frequency.exponentialRampToValueAtTime(48, now + 0.42);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(850, now);
      filter.frequency.exponentialRampToValueAtTime(320, now + 0.42);
      motorGain.gain.setValueAtTime(0.0001, now);
      motorGain.gain.exponentialRampToValueAtTime(0.095, now + 0.035);
      motorGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);

      latch.type = 'triangle';
      latch.frequency.setValueAtTime(360, now + 0.3);
      latch.frequency.exponentialRampToValueAtTime(145, now + 0.43);
      latchGain.gain.setValueAtTime(0.0001, now);
      latchGain.gain.setValueAtTime(0.0001, now + 0.29);
      latchGain.gain.exponentialRampToValueAtTime(0.075, now + 0.315);
      latchGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

      motor.connect(filter);
      filter.connect(motorGain);
      motorGain.connect(this.sfxGain);
      latch.connect(latchGain);
      latchGain.connect(this.sfxGain);
      motor.start(now);
      motor.stop(now + 0.48);
      latch.start(now);
      latch.stop(now + 0.47);
      this.markPlayed('containerMove');
      return true;
    }

    snapshot() {
      const fallbackMusic = this.elements.bgMusic;
      return {
        initialized: this.initialized,
        ready: Object.keys(this.elements).length === Object.keys(MANIFEST).length,
        contextState: this.ctx?.state || 'html-audio',
        unlocked: this.unlocked,
        muted: this.muted,
        musicWanted: this.musicWanted,
        musicPlaying: !this.muted && this.isMusicSourceActive() && (!this.ctx || this.ctx.state === 'running'),
        musicSourceActive: this.isMusicSourceActive(),
        decoded: Object.keys(this.buffers),
        playCounts: { ...this.debug.playCounts },
        lastPlayed: this.debug.lastPlayed,
        musicStarts: this.debug.musicStarts,
        musicDucking: this.musicDucking,
        musicDucks: this.debug.musicDucks,
        unlockAttempts: this.debug.unlockAttempts
      };
    }

    emitState() {
      window.dispatchEvent(new CustomEvent('openboxaudiochange', { detail: this.snapshot() }));
    }
  }

  const audio = new AudioManager();
  window.OpenBoxAudio = audio;
  window.__audio = {
    ready: () => audio.ready,
    snapshot: () => audio.snapshot(),
    setMuted: (muted) => audio.setMuted(muted),
    toggleMuted: () => audio.toggleMuted(),
    play: (name, options) => audio.play(name, options),
    duckMusic: (durationSeconds) => audio.duckMusic(durationSeconds),
    playContainerMove: () => audio.playContainerMove(),
    playBoxTravel: () => audio.playBoxTravel(),
    playBoxLand: () => audio.playBoxLand()
  };

  audio.init().catch((error) => {
    console.warn('[open-box-audio] Audio initialization failed:', error?.message || error);
  });
})();
