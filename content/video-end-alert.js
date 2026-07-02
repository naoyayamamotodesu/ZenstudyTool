class ZenstudyToolVideoEndAlert {
  constructor() {
    this.enabled = false;
    this.boundVideos = new WeakSet();
    this.lastAlertedAtByVideo = new WeakMap();
    this.toastTimerId = null;
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
      this.enabled ? this.start() : this.stop();
    });
  }

  start() {
    this.addAudioUnlockListeners();
    this.scanVideos();
    if (this.observer) return;
    this.observer = createDebouncedObserver(() => this.scanVideos(), 250, true);
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.removeAudioUnlockListeners();
    this.removeToast();
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
    video.addEventListener("play", this.unlockAudio, { once: true });
    video.addEventListener("playing", this.unlockAudio, { once: true });
    video.addEventListener("ended", () => this.handleVideoEnded(video));
  }

  handleVideoEnded(video) {
    if (!this.enabled) return;

    const now = Date.now();
    const lastAlertedAt = this.lastAlertedAtByVideo.get(video) || 0;
    if (now - lastAlertedAt < 1500) return;
    this.lastAlertedAtByVideo.set(video, now);

    const title = this.getLessonTitle();
    const message = title
      ? `動画が終了しました: ${title}`
      : "動画が終了しました";

    this.showToast(message);
    this.playAlertSound();
    window.setTimeout(() => {
      if (this.enabled) window.alert(message);
    }, 1900);
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

      const masterGain = audioContext.createGain();
      masterGain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      masterGain.gain.exponentialRampToValueAtTime(0.28, audioContext.currentTime + 0.03);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 1.85);
      masterGain.connect(audioContext.destination);

      const notes = [
        { frequency: 784, start: 0.00, duration: 0.34 },
        { frequency: 988, start: 0.38, duration: 0.34 },
        { frequency: 1175, start: 0.76, duration: 0.52 },
      ];

      for (const note of notes) {
        this.playTone(audioContext, masterGain, note);
      }

    } catch (_) {
      // Audio may be blocked by the browser; the visual alert still runs.
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

  getLessonTitle() {
    const selectors = [
      '[role="dialog"] h1',
      '[role="dialog"] h2',
      '[role="dialog"] h3',
      "main h1",
      "main h2",
      "h1",
      "h2",
    ];

    for (const selector of selectors) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text) return text.replace(/\s+/g, " ");
    }
    return "";
  }

  showToast(message) {
    let toast = document.getElementById("__ZENSTUDYTOOL_video_end_alert_toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__ZENSTUDYTOOL_video_end_alert_toast";
      toast.className = "__ZENSTUDYTOOL_videoEndAlertToast";
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(this.toastTimerId);
    this.toastTimerId = window.setTimeout(() => this.removeToast(), 7000);
  }

  removeToast() {
    window.clearTimeout(this.toastTimerId);
    this.toastTimerId = null;
    const toast = document.getElementById("__ZENSTUDYTOOL_video_end_alert_toast");
    if (toast) toast.remove();
  }
}
