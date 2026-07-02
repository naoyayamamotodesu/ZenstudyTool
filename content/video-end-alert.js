class ZenstudyToolVideoEndAlert {
  constructor() {
    this.enabled = false;
    this.boundVideos = new WeakSet();
    this.lastAlertedAtByVideo = new WeakMap();
    this.toastTimerId = null;
    this.observer = null;

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
    this.scanVideos();
    if (this.observer) return;
    this.observer = createDebouncedObserver(() => this.scanVideos(), 250, true);
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
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
    window.setTimeout(() => {
      if (this.enabled) window.alert(message);
    }, 0);
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
