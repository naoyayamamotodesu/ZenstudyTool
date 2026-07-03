class ZenstudyToolVideoEndAlert {
  constructor() {
    this.enabled = false;
    this.boundVideos = new WeakSet();
    this.lastAlertedAtByVideo = new WeakMap();
    this.observer = null;
    this.audioContext = null;
    this.audioUnlocked = false;
    this.unlockAudio = this.unlockAudio.bind(this);

    safeStorageGet(
      { [STORAGE_KEYS.videoEndAlertEnabled]: false },
      (result) => {
        this.enabled = Boolean(result[STORAGE_KEYS.videoEndAlertEnabled]);
        if (this.enabled) this.start();
      }
    );

    addSafeStorageChangeListener((changes, area) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEYS.videoEndAlertEnabled];
      if (change === undefined) return;

      this.enabled = Boolean(change.newValue);
      this.enabled ? this.start({ playEnabledSound: true }) : this.stop();
    });
  }

  start({ playEnabledSound = false } = {}) {
    this.addAudioUnlockListeners();
    this.scanVideos();
    if (!this.observer) {
      this.observer = createDebouncedObserver(() => this.scanVideos(), 250, true);
    }
    if (playEnabledSound) this.playAlertSound();
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.removeAudioUnlockListeners();
  }

  scanVideos() {
    if (!this.enabled) return;
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      this.bindVideo(video);
    }
  }

  bindVideo(video) {
    if (!video || this.boundVideos.has(video)) return;
    this.boundVideos.add(video);
    video.addEventListener("ended", () => this.handleVideoEnded(video));
  }

  handleVideoEnded(video) {
    if (!this.enabled) return;

    const now = Date.now();
    const lastAlertedAt = this.lastAlertedAtByVideo.get(video) || 0;
    if (now - lastAlertedAt < 1500) return;
    this.lastAlertedAtByVideo.set(video, now);

    this.focusCurrentTab();
    this.playAlertSound();
  }

  focusCurrentTab() {
    safeRuntimeSendMessage({
      type: MESSAGE_TYPES.focusVideoEndTab,
    });
  }

  addAudioUnlockListeners() {
    if (this.audioUnlocked) return;
    document.addEventListener("pointerdown", this.unlockAudio, true);
    document.addEventListener("keydown", this.unlockAudio, true);
  }

  removeAudioUnlockListeners() {
    document.removeEventListener("pointerdown", this.unlockAudio, true);
    document.removeEventListener("keydown", this.unlockAudio, true);
  }

  unlockAudio() {
    const audioContext = this.getAudioContext();
    if (!audioContext) return;

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    this.audioUnlocked = true;
    this.removeAudioUnlockListeners();
  }

  getAudioContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  playAlertSound() {
    try {
      const audioContext = this.getAudioContext();
      if (!audioContext) return;
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const patternStart = audioContext.currentTime;
      const alertRepeats = [0, 1.15, 2.3];

      for (const offset of alertRepeats) {
        const masterGain = audioContext.createGain();
        masterGain.gain.setValueAtTime(0.0001, patternStart + offset);
        masterGain.gain.exponentialRampToValueAtTime(0.55, patternStart + offset + 0.03);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, patternStart + offset + 0.95);
        masterGain.connect(audioContext.destination);

        const notes = [
          { frequency: 880, start: offset + 0.00, duration: 0.22 },
          { frequency: 1175, start: offset + 0.26, duration: 0.22 },
          { frequency: 1480, start: offset + 0.52, duration: 0.34 },
        ];

        for (const note of notes) {
          this.playTone(audioContext, masterGain, note);
        }
      }

    } catch (_) {
      // Audio may be blocked by the browser until the page receives a user gesture.
    }
  }

  playTone(audioContext, destination, { frequency, start, duration }) {
    const startAt = audioContext.currentTime + start;
    const endAt = startAt + duration;
    const oscillator = audioContext.createOscillator();
    const toneGain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    toneGain.gain.setValueAtTime(0.0001, startAt);
    toneGain.gain.exponentialRampToValueAtTime(0.9, startAt + 0.03);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    oscillator.connect(toneGain);
    toneGain.connect(destination);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.03);
  }

}
