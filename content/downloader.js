class ZenstudyToolDownloader {
  constructor() {
    this.downloadEnabled = true;
    this.slideDownloadEnabled = true;
    this.videoInfo = null;
    this.title = '';
    this.sectionTitle = '';
    this.lastSelectedTitle = '';
    this.buttonGroup = null;
    this.btn = null;
    this.batchBtn = null;
    this.slideBtn = null;
    this.resetTimerId = null;
    this.batchResetTimerId = null;
    this.slideResetTimerId = null;
    this.waitingPollTimerId = null;
    this.activeConversionRequestId = null;
    this.isDownloading = false;
    this.activeDownloadCompletion = null;
    this.isBatchDownloading = false;
    this.batchStopRequested = false;
    this.batchCurrentTargetKey = '';
    this.activeSlideDownloadRequestId = null;
    this.isSlideDownloading = false;
    this.nextDownloadSequence = 0;
    this.activeDownloadSequence = 0;
    this.activeLessonFingerprint = '';
    this.activeLessonChangedAt = 0;
    this.chapterDataCache = new Map();
    this.slideAvailabilityPromise = null;

    this.handlePotentialLessonSelection = this.handlePotentialLessonSelection.bind(this);
    document.addEventListener('click', this.handlePotentialLessonSelection, true);

    safeStorageGet({
      [STORAGE_KEYS.downloadEnabled]: true,
      [STORAGE_KEYS.slideDownloadEnabled]: true,
    }, (result) => {
      this.downloadEnabled = Boolean(result[STORAGE_KEYS.downloadEnabled]);
      this.slideDownloadEnabled = Boolean(result[STORAGE_KEYS.slideDownloadEnabled]);
      if (this.hasAnyDownloadEnabled()) this.checkAndShow();
    });

    addSafeStorageChangeListener((changes, area) => {
      if (area !== "local") return;
      const downloadChange = changes[STORAGE_KEYS.downloadEnabled];
      const slideDownloadChange = changes[STORAGE_KEYS.slideDownloadEnabled];
      if (downloadChange !== undefined) {
        this.downloadEnabled = Boolean(downloadChange.newValue);
      }
      if (slideDownloadChange !== undefined) {
        this.slideDownloadEnabled = Boolean(slideDownloadChange.newValue);
      }

      if (downloadChange !== undefined || slideDownloadChange !== undefined) {
        this.removeButton();
        if (this.hasAnyDownloadEnabled()) {
          this.checkAndShow();
        }
      }
    });

    addSafeRuntimeMessageListener((message) => {
      if (message.type === MESSAGE_TYPES.videoUrlDetected) {
        const didUpdate = this.applyVideoInfo(message.videoInfo);
        if (didUpdate && this.hasAnyDownloadEnabled()) this.checkAndShow();
      } else if (message.type === MESSAGE_TYPES.conversionProgress) {
        this.updateProgress(message);
      } else if (message.type === MESSAGE_TYPES.slideDownloadProgress) {
        this.updateSlideProgress(message);
      }
    });

    this.observer = createDebouncedObserver(() => {
      if (this.hasAnyDownloadEnabled()) this.checkAndShow();
    }, 150);
  }

  hasAnyDownloadEnabled() {
    return this.downloadEnabled || this.slideDownloadEnabled;
  }

  resetDownloadState() {
    this.isDownloading = false;
    this.activeDownloadSequence = 0;
    this.activeConversionRequestId = null;
  }

  resetSlideDownloadState() {
    this.isSlideDownloading = false;
    this.activeSlideDownloadRequestId = null;
  }

  getButtonGroup() {
    if (this.buttonGroup && document.body.contains(this.buttonGroup)) return this.buttonGroup;
    const existingGroup = document.getElementById(ELEMENT_IDS.downloadButtonGroup);
    this.buttonGroup = existingGroup || null;
    return this.buttonGroup;
  }

  ensureButtonGroup(buttonHost) {
    let group = this.getButtonGroup();
    if (group) return group;

    group = document.createElement('div');
    group.id = ELEMENT_IDS.downloadButtonGroup;
    group.className = CSS_CLASSES.downloadButtonGroup;
    buttonHost.appendChild(group);
    this.buttonGroup = group;
    return group;
  }

  getDownloadButton() {
    if (this.btn && document.body.contains(this.btn)) return this.btn;
    const existingBtn = document.getElementById(ELEMENT_IDS.downloadButton);
    this.btn = existingBtn || null;
    return this.btn;
  }

  getSlideDownloadButton() {
    if (this.slideBtn && document.body.contains(this.slideBtn)) return this.slideBtn;
    const existingBtn = document.getElementById(ELEMENT_IDS.slideDownloadButton);
    this.slideBtn = existingBtn || null;
    return this.slideBtn;
  }

  getBatchDownloadButton() {
    if (this.batchBtn && document.body.contains(this.batchBtn)) return this.batchBtn;
    const existingBtn = document.getElementById(ELEMENT_IDS.batchDownloadButton);
    this.batchBtn = existingBtn || null;
    return this.batchBtn;
  }

  removeBatchDownloadButton() {
    if (this.isBatchDownloading) return;

    const button = this.getBatchDownloadButton();
    if (button) button.remove();
    this.batchBtn = null;
  }

  ensureBatchDownloadButton(buttonGroup) {
    let button = this.getBatchDownloadButton();
    if (button) return button;

    this.batchBtn = document.createElement('button');
    button = this.batchBtn;
    button.id = ELEMENT_IDS.batchDownloadButton;
    button.type = 'button';
    button.className = CSS_CLASSES.batchDownloadButton;
    button.addEventListener('click', () => this.handleBatchDownloadClick());
    buttonGroup.appendChild(button);
    return button;
  }

  removeSlideDownloadButton() {
    if (this.isSlideDownloading) return;

    const button = this.getSlideDownloadButton();
    if (button) button.remove();
    this.slideBtn = null;
  }

  ensureSlideDownloadButton(buttonGroup) {
    let button = this.getSlideDownloadButton();
    if (button) return button;

    this.slideBtn = document.createElement('button');
    button = this.slideBtn;
    button.id = ELEMENT_IDS.slideDownloadButton;
    button.type = 'button';
    button.className = CSS_CLASSES.slideDownloadButton;
    button.addEventListener('click', () => this.handleSlideDownloadClick());
    buttonGroup.appendChild(button);
    return button;
  }

  setActionButtonState(button, state, text) {
    if (!button) return;
    button.dataset.state = state;
    button.textContent = text;
  }

  getCurrentLessonFingerprint() {
    const iframe = this.getModalIframe();
    const src = iframe?.getAttribute('src') || iframe?.src || '';
    if (!src) return '';

    try {
      const url = new URL(src, window.location.origin);
      return `${url.pathname}${url.search}`;
    } catch (_) {
      return src;
    }
  }

  getCurrentLessonStartedAt() {
    const iframe = this.getModalIframe();
    const candidates = [];

    try {
      const performance = iframe?.contentWindow?.performance;
      candidates.push(performance?.timeOrigin);
      candidates.push(performance?.timing?.navigationStart);
    } catch (_) {
      // Cross-origin or not-yet-ready frames fall back below.
    }

    const startedAt = candidates.find((value) => Number.isFinite(value) && value > 0);
    return startedAt || Date.now() - 15000;
  }

  syncLessonContext() {
    const nextFingerprint = this.getCurrentLessonFingerprint();
    if (nextFingerprint === this.activeLessonFingerprint) return false;

    if (this.isBatchDownloading && this.activeDownloadCompletion) {
      this.requestBatchStop();
      this.resolveActiveDownloadCompletion(false, '保存中に教材が切り替わりました');
    }

    this.activeLessonFingerprint = nextFingerprint;
    this.activeLessonChangedAt = nextFingerprint ? this.getCurrentLessonStartedAt() : 0;
    this.videoInfo = null;
    this.resetDownloadState();
    this.resetSlideDownloadState();
    this.removeSlideDownloadButton();

    if (this.resetTimerId) {
      clearTimeout(this.resetTimerId);
      this.resetTimerId = null;
    }

    if (this.slideResetTimerId) {
      clearTimeout(this.slideResetTimerId);
      this.slideResetTimerId = null;
    }

    return true;
  }

  isVideoInfoRelevant(videoInfo) {
    if (!videoInfo) return false;
    if (!this.activeLessonChangedAt) return true;
    return videoInfo.timestamp >= this.activeLessonChangedAt - 1000;
  }

  hasCurrentVideoInfo() {
    if (!this.isVideoInfoRelevant(this.videoInfo)) {
      this.videoInfo = null;
      return false;
    }
    return true;
  }

  applyVideoInfo(videoInfo) {
    if (!this.isVideoInfoRelevant(videoInfo)) return false;
    this.videoInfo = videoInfo;
    return true;
  }

  buildVideoInfoFromUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    if (/^(?:blob|data):/i.test(url)) return null;

    let href = '';
    try {
      href = new URL(url, globalThis.location?.href || 'https://www.nnn.ed.nico/').href;
    } catch (_) {
      return null;
    }

    const isM3U8 = /\.m3u8(?:[?#]|$)/i.test(href);
    const isMP4 = /\.mp4(?:[?#]|$)/i.test(href);
    if (!isM3U8 && !isMP4) return null;

    return {
      url: href,
      type: isMP4 ? 'mp4' : 'm3u8',
      timestamp: Date.now(),
    };
  }

  findVideoInfoInDocument(doc, seenDocs = new Set()) {
    if (!doc || seenDocs.has(doc)) return null;
    seenDocs.add(doc);

    const candidates = [];
    doc.querySelectorAll('video').forEach((video) => {
      candidates.push(video.currentSrc, video.src, video.getAttribute('src'));
      video.querySelectorAll('source[src]').forEach((source) => {
        candidates.push(source.currentSrc, source.src, source.getAttribute('src'));
      });
    });

    for (const candidate of candidates) {
      const videoInfo = this.buildVideoInfoFromUrl(candidate);
      if (videoInfo) return videoInfo;
    }

    for (const childFrame of doc.querySelectorAll('iframe')) {
      const videoInfo = this.findVideoInfoInDocument(this.getIframeDocument(childFrame), seenDocs);
      if (videoInfo) return videoInfo;
    }

    return null;
  }

  applyDomVideoInfo() {
    const videoInfo = this.findVideoInfoInDocument(this.getIframeDocument(this.getModalIframe()));
    return Boolean(videoInfo && this.applyVideoInfo(videoInfo));
  }

  requestLatestVideoInfo() {
    safeRuntimeSendMessage({ type: MESSAGE_TYPES.getVideoUrl }, (response, error) => {
      if (error) return;
      if (response && response.videoInfo && this.applyVideoInfo(response.videoInfo) && this.downloadEnabled) {
        this.checkAndShow();
        return;
      }
      if (this.applyDomVideoInfo() && this.downloadEnabled) {
        this.checkAndShow();
      }
    });
  }

  isUsableLessonTitle(text) {
    const normalized = ZenstudyToolDownloaderUtils.normalizeTitleText(text);
    if (!normalized) return false;
    if (normalized === '教材' || normalized === '動画' || normalized === 'ZEN Study') {
      return false;
    }

    const sectionTitle = ZenstudyToolDownloaderUtils.normalizeTitleText(this.getSectionTitle());
    if (sectionTitle && normalized === sectionTitle) {
      return false;
    }

    return true;
  }

  pickTitleFromNode(node) {
    if (!node) return '';

    const selectors = [
      '[font-size="1.5rem"]',
      '[font-size="1.6rem"]',
      'h1 span',
      'h1',
      'h2 span',
      'h2',
      'h3 span',
      'h3',
      'h4 > span',
      'h4',
    ];

    for (const selector of selectors) {
      const el = node.querySelector(selector);
      if (!el) continue;

      const text = ZenstudyToolDownloaderUtils.normalizeTitleText(el.textContent || '');
      if (this.isUsableLessonTitle(text)) return text;
    }

    return '';
  }

  handlePotentialLessonSelection(event) {
    if (!(event.target instanceof Element)) return;

    const listItem = event.target.closest('ul[aria-label="必修教材リスト"] li');
    if (!listItem) return;
    if (!listItem.querySelector('svg[type="movie-rounded"]')) return;

    if (event.isTrusted && this.isBatchDownloading) {
      this.requestBatchStop();
    }

    const title = this.pickTitleFromNode(listItem);
    if (!title) return;

    this.lastSelectedTitle = title;
  }

  getModalIframe() {
    return document.querySelector([
      '.ReactModal__Content iframe[src*="/movies/"]',
      'iframe[title="教材"][src*="/movies/"]',
    ].join(', '));
  }

  hasVideoModalOpen() {
    return Boolean(this.getModalIframe());
  }

  getIframeDocument(iframe) {
    return getAccessibleIframeDocument(iframe);
  }

  extractTitleFromDocument(doc) {
    if (!doc) return '';

    const fromBody = this.pickTitleFromNode(doc.body || doc);
    if (fromBody) return fromBody;

    const metaCandidates = [
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
      doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content') || '',
      doc.title || '',
    ];

    for (const candidate of metaCandidates) {
      const title = ZenstudyToolDownloaderUtils.normalizeTitleText(candidate);
      if (this.isUsableLessonTitle(title)) return title;
    }

    return '';
  }

  getMovieContextFromIframe() {
    const iframe = this.getModalIframe();
    const src = iframe?.getAttribute('src') || iframe?.src || '';
    if (!src) return null;

    try {
      const url = new URL(src, window.location.origin);
      const match = url.pathname.match(/^\/(?:contents\/)?courses\/(\d+)\/chapters\/(\d+)\/movies\/(\d+)/);
      if (!match) return null;

      return {
        courseId: match[1],
        chapterId: match[2],
        movieId: match[3],
      };
    } catch (_) {
      return null;
    }
  }

  fetchChapterData(courseId, chapterId) {
    const cacheKey = `${courseId}:${chapterId}`;
    if (this.chapterDataCache.has(cacheKey)) {
      return this.chapterDataCache.get(cacheKey);
    }

    const promise = fetch(`${API_BASE_URL}/v2/material/courses/${courseId}/chapters/${chapterId}`, {
      credentials: 'include',
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch((err) => {
        console.warn('[ZenstudyTool] Chapter data fetch failed', err);
        return null;
      });

    this.chapterDataCache.set(cacheKey, promise);
    return promise;
  }

  findMovieTitleInValue(value, movieId) {
    const seen = new WeakSet();
    const queue = [value];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;

      if (Array.isArray(current)) {
        for (const item of current) queue.push(item);
        continue;
      }

      if (seen.has(current)) continue;
      seen.add(current);

      const idCandidates = [current.id, current.movie_id, current.material_id, current.resource_id]
        .filter((candidate) => candidate !== undefined && candidate !== null)
        .map((candidate) => String(candidate));
      const urlCandidates = [current.url, current.href, current.path]
        .filter((candidate) => typeof candidate === 'string');

      const matchesMovie = idCandidates.includes(String(movieId))
        || urlCandidates.some((candidate) => candidate.includes(`/movies/${movieId}`));

      if (matchesMovie) {
        const title = ZenstudyToolDownloaderUtils.normalizeTitleText(
          current.name
          || current.title
          || current.display_name
          || current.resource_name
          || current.label
          || ''
        );
        if (this.isUsableLessonTitle(title)) return title;
      }

      for (const child of Object.values(current)) {
        if (child && typeof child === 'object') queue.push(child);
      }
    }

    return '';
  }

  async resolveTitle() {
    if (this.isUsableLessonTitle(this.lastSelectedTitle)) {
      return ZenstudyToolDownloaderUtils.normalizeTitleText(this.lastSelectedTitle);
    }

    const iframeDoc = this.getIframeDocument(this.getModalIframe());
    const iframeTitle = this.extractTitleFromDocument(iframeDoc);
    if (iframeTitle) return iframeTitle;

    const movieContext = this.getMovieContextFromIframe();
    if (movieContext) {
      const chapterData = await this.fetchChapterData(movieContext.courseId, movieContext.chapterId);
      const apiTitle = this.findMovieTitleInValue(chapterData?.chapter || chapterData, movieContext.movieId);
      if (apiTitle) return apiTitle;
    }

    return this.getTitle();
  }

  waitForIframeDocument(iframe, timeoutMs = 4000) {
    const existingDoc = this.getIframeDocument(iframe);
    if (existingDoc && existingDoc.readyState !== 'loading') {
      return Promise.resolve(existingDoc);
    }

    return new Promise((resolve) => {
      let settled = false;

      const finish = (doc) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(doc || null);
      };

      const onLoad = () => {
        finish(this.getIframeDocument(iframe));
      };

      const timeoutId = setTimeout(() => {
        iframe.removeEventListener('load', onLoad);
        finish(this.getIframeDocument(iframe));
      }, timeoutMs);

      iframe.addEventListener('load', onLoad, { once: true });
    });
  }

  async collectNestedFrameDocuments(frames, seenDocs = new Set()) {
    const docs = [];

    for (const frame of frames) {
      const doc = await this.waitForIframeDocument(frame);
      if (!doc || seenDocs.has(doc)) continue;

      seenDocs.add(doc);
      docs.push(doc);

      const childFrames = Array.from(doc.querySelectorAll('iframe'));
      if (childFrames.length > 0) {
        docs.push(...await this.collectNestedFrameDocuments(childFrames, seenDocs));
      }
    }

    return docs;
  }

  async getSlideDocuments() {
    const movieDoc = this.getIframeDocument(this.getModalIframe());
    if (!movieDoc) return [];

    const referenceFrames = Array.from(
      movieDoc.querySelectorAll('iframe[src*="/references/"], iframe[aria-label*="補助テキスト"], iframe[aria-label*="スライド"]')
    );

    if (referenceFrames.length === 0) {
      const fallbackFrames = Array.from(movieDoc.querySelectorAll('iframe'));
      return fallbackFrames.length > 0
        ? this.collectNestedFrameDocuments(fallbackFrames)
        : [movieDoc];
    }

    return this.collectNestedFrameDocuments(referenceFrames);
  }

  collectSlideImagesFromDocument(doc, images, seenUrls) {
    const imageElements = Array.from(doc.querySelectorAll('img'));
    let foundDirectImage = false;

    for (const image of imageElements) {
      const candidateUrl = image.currentSrc
        || image.getAttribute('src')
        || image.getAttribute('data-src')
        || image.getAttribute('data-lazy-src')
        || image.getAttribute('data-original')
        || ZenstudyToolDownloaderUtils.pickLargestSrcsetCandidate(image.getAttribute('srcset'))
        || ZenstudyToolDownloaderUtils.pickLargestSrcsetCandidate(image.getAttribute('data-srcset'));
      const url = ZenstudyToolDownloaderUtils.resolveAssetUrl(candidateUrl, doc.baseURI);

      if (!ZenstudyToolDownloaderUtils.isLikelySlideImageElement(image, url) || seenUrls.has(url)) {
        continue;
      }

      const label = image.getAttribute('alt')
        || image.getAttribute('title')
        || image.getAttribute('aria-label')
        || image.closest('[aria-label]')?.getAttribute('aria-label')
        || '';

      seenUrls.add(url);
      foundDirectImage = true;
      images.push({
        url,
        fileStem: ZenstudyToolDownloaderUtils.buildSlideFileStem(images.length, label),
      });
    }

    if (foundDirectImage) return;

    const anchorElements = Array.from(doc.querySelectorAll('a[href]'));
    for (const anchor of anchorElements) {
      const url = ZenstudyToolDownloaderUtils.resolveAssetUrl(anchor.getAttribute('href'), doc.baseURI);
      if (!ZenstudyToolDownloaderUtils.isDownloadableSlideUrl(url) || seenUrls.has(url)) continue;
      if (!/\.(?:png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.test(url)) continue;

      const label = anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '';
      seenUrls.add(url);
      images.push({
        url,
        fileStem: ZenstudyToolDownloaderUtils.buildSlideFileStem(images.length, label),
      });
    }
  }

  async collectSlideImages() {
    const docs = await this.getSlideDocuments();
    const images = [];
    const seenUrls = new Set();

    for (const doc of docs) {
      this.collectSlideImagesFromDocument(doc, images, seenUrls);
    }

    return images;
  }

  getVideoLessonItems() {
    return Array.from(
      document.querySelectorAll('ul[aria-label="必修教材リスト"] > li')
    ).filter((item) => item.querySelector('svg[type="movie-rounded"]'));
  }

  getVideoLessonTargets() {
    const occurrenceByTitle = new Map();

    return this.getVideoLessonItems().map((item, index) => {
      const title = this.pickTitleFromNode(item) || `動画 ${index + 1}`;
      const occurrence = occurrenceByTitle.get(title) || 0;
      occurrenceByTitle.set(title, occurrence + 1);

      return { title, occurrence, index };
    });
  }

  findVideoLessonItem(target) {
    const items = this.getVideoLessonItems();
    const matches = items.filter((item) => this.pickTitleFromNode(item) === target.title);
    return matches[target.occurrence] || items[target.index] || null;
  }

  getBatchTargetKey(target) {
    return `${target.title}\u0000${target.occurrence}`;
  }

  async resolveInitialBatchTargetKey(targets) {
    let title = '';
    try {
      title = await this.resolveTitle();
    } catch (_) {
      return '';
    }

    const normalizedTitle = ZenstudyToolDownloaderUtils.normalizeTitleText(title);
    const target = targets.find((item) => (
      ZenstudyToolDownloaderUtils.normalizeTitleText(item.title) === normalizedTitle
    ));
    return target ? this.getBatchTargetKey(target) : '';
  }

  waitForBatchCondition(predicate, timeoutMs = BATCH_VIDEO_READY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;

      const check = () => {
        if (!this.isBatchDownloading || this.batchStopRequested) {
          resolve(false);
          return;
        }

        if (predicate()) {
          resolve(true);
          return;
        }

        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }

        setTimeout(check, BATCH_POLL_INTERVAL_MS);
      };

      check();
    });
  }

  async selectBatchLesson(target) {
    const item = this.findVideoLessonItem(target);
    if (!item) return false;

    const targetKey = this.getBatchTargetKey(target);
    const isAlreadyOpen = targetKey === this.batchCurrentTargetKey;
    const previousFingerprint = this.getCurrentLessonFingerprint();
    const clickTarget = item.querySelector('div') || item;
    this.lastSelectedTitle = target.title;

    if (!isAlreadyOpen) {
      clickTarget.click();
      const changed = await this.waitForBatchCondition(
        () => this.getCurrentLessonFingerprint() !== previousFingerprint
      );
      if (!changed) return false;
    }

    this.batchCurrentTargetKey = targetKey;
    this.syncLessonContext();
    this.checkAndShow();
    return true;
  }

  async waitForBatchVideoInfo() {
    return this.waitForBatchCondition(() => {
      this.syncLessonContext();
      if (this.hasCurrentVideoInfo() || this.applyDomVideoInfo()) return true;
      this.requestLatestVideoInfo();
      return false;
    });
  }

  resolveActiveDownloadCompletion(success, message = '') {
    if (!this.activeDownloadCompletion) return;

    const pending = this.activeDownloadCompletion;
    this.activeDownloadCompletion = null;
    pending.resolve({ success, message });
  }

  setButtonState(state, text) {
    this.setActionButtonState(this.getDownloadButton(), state, text);
  }

  setBatchButtonState(state, text) {
    this.setActionButtonState(this.getBatchDownloadButton(), state, text);
  }

  setSlideButtonState(state, text) {
    this.setActionButtonState(this.getSlideDownloadButton(), state, text);
  }

  setBatchReadyState() {
    const btn = this.getBatchDownloadButton();
    if (!btn || this.isBatchDownloading) return;

    this.setBatchButtonState('ready', BATCH_DOWNLOAD_BUTTON_TEXT.ready);
    btn.disabled = false;
    btn.title = '';
  }

  setBatchBusyState(text) {
    const btn = this.getBatchDownloadButton();
    if (!btn) return;

    this.setBatchButtonState('loading', text);
    btn.disabled = false;
    btn.title = 'クリックで次の動画への移動を停止';
  }

  setBatchResultState(state, text) {
    const btn = this.getBatchDownloadButton();
    if (!btn) return;

    this.setBatchButtonState(state, text);
    btn.disabled = false;
    btn.title = '';

    if (this.batchResetTimerId) clearTimeout(this.batchResetTimerId);
    this.batchResetTimerId = setTimeout(() => {
      this.setBatchReadyState();
    }, 3500);
  }

  setReadyState() {
    const btn = this.getDownloadButton();
    if (!btn) return;

    this.activeConversionRequestId = null;
    if (!this.hasCurrentVideoInfo()) this.applyDomVideoInfo();

    if (this.hasCurrentVideoInfo()) {
      this.stopWaitingPoll();
      this.setButtonState('ready', DOWNLOAD_BUTTON_TEXT.ready);
      btn.disabled = this.isBatchDownloading;
    } else {
      this.setButtonState('waiting', DOWNLOAD_BUTTON_TEXT.waiting);
      btn.disabled = true;
      this.requestLatestVideoInfo();
      this.startWaitingPoll();
    }
  }

  startWaitingPoll() {
    if (this.waitingPollTimerId) return;

    this.waitingPollTimerId = setInterval(() => {
      if (!this.downloadEnabled || !this.hasVideoModalOpen()) {
        this.stopWaitingPoll();
        return;
      }

      if (this.hasCurrentVideoInfo()) {
        this.stopWaitingPoll();
        this.setReadyState();
        return;
      }

      if (this.applyDomVideoInfo()) {
        this.stopWaitingPoll();
        this.setReadyState();
        return;
      }

      this.requestLatestVideoInfo();
    }, 1200);
  }

  stopWaitingPoll() {
    if (!this.waitingPollTimerId) return;
    clearInterval(this.waitingPollTimerId);
    this.waitingPollTimerId = null;
  }

  setBusyState(text = DOWNLOAD_BUTTON_TEXT.preparing) {
    const btn = this.getDownloadButton();
    if (!btn) return;
    if (this.resetTimerId) {
      clearTimeout(this.resetTimerId);
      this.resetTimerId = null;
    }
    this.setButtonState('loading', text);
    btn.disabled = true;
  }

  setResultState(state, text, autoReset = true) {
    const btn = this.getDownloadButton();
    if (!btn) return;

    this.setButtonState(state, text);
    btn.disabled = this.isBatchDownloading || state !== 'error';

    if (this.resetTimerId) clearTimeout(this.resetTimerId);
    if (!autoReset) {
      this.resetTimerId = null;
      return;
    }

    this.resetTimerId = setTimeout(() => {
      this.setReadyState();
    }, 2500);
  }

  setSlideReadyState() {
    const btn = this.getSlideDownloadButton();
    if (!btn) return;

    this.setSlideButtonState('ready', SLIDE_DOWNLOAD_BUTTON_TEXT.ready);
    btn.disabled = this.isBatchDownloading;
  }

  setSlideBusyState(text = SLIDE_DOWNLOAD_BUTTON_TEXT.preparing) {
    const btn = this.getSlideDownloadButton();
    if (!btn) return;

    this.setSlideButtonState('loading', text);
    btn.disabled = true;
  }

  setSlideResultState(state, text) {
    const btn = this.getSlideDownloadButton();
    if (!btn) return;

    this.setSlideButtonState(state, text);
    btn.disabled = state !== 'error';

    if (this.slideResetTimerId) clearTimeout(this.slideResetTimerId);
    this.slideResetTimerId = setTimeout(() => {
      this.setSlideReadyState();
    }, 2500);
  }

  refreshSlideDownloadButton(buttonGroup) {
    if (!this.slideDownloadEnabled || this.slideAvailabilityPromise || this.isSlideDownloading) return;

    const lessonFingerprint = this.getCurrentLessonFingerprint();
    this.slideAvailabilityPromise = this.collectSlideImages()
      .then((images) => {
        if (!this.slideDownloadEnabled || lessonFingerprint !== this.getCurrentLessonFingerprint()) return;

        if (images.length === 0) {
          this.removeSlideDownloadButton();
          return;
        }

        this.ensureSlideDownloadButton(buttonGroup);
        this.setSlideReadyState();
      })
      .catch((error) => {
        console.warn('[ZenstudyTool] Slide availability check failed', error);
        this.removeSlideDownloadButton();
      })
      .finally(() => {
        const lessonChangedDuringCheck = lessonFingerprint !== this.getCurrentLessonFingerprint();
        this.slideAvailabilityPromise = null;
        if (lessonChangedDuringCheck && this.slideDownloadEnabled) {
          this.checkAndShow();
        }
      });
  }

  refreshBatchDownloadButton(buttonGroup) {
    if (!this.downloadEnabled) {
      this.removeBatchDownloadButton();
      return;
    }

    const targets = this.getVideoLessonTargets();
    if (targets.length === 0) {
      this.removeBatchDownloadButton();
      return;
    }

    this.ensureBatchDownloadButton(buttonGroup);
    this.setBatchReadyState();
  }

  getTitle() {
    if (this.isUsableLessonTitle(this.lastSelectedTitle)) {
      return ZenstudyToolDownloaderUtils.normalizeTitleText(this.lastSelectedTitle);
    }

    const iframeTitle = this.extractTitleFromDocument(this.getIframeDocument(this.getModalIframe()));
    if (iframeTitle) return iframeTitle;

    const list = document.querySelector('ul[aria-label="必修教材リスト"]');
    if (list) {
      const activeItem = Array.from(list.children).find(li => {
        const row = li.querySelector('div > div');
        return !!row && (
          row.getAttribute('aria-current') === 'true'
          || li.getAttribute('aria-current') === 'true'
        );
      });
      if (activeItem) {
        const listTitle = this.pickTitleFromNode(activeItem);
        if (listTitle) return listTitle;
      }
    }

    const breadcrumbTitle = document.querySelector('nav[aria-label="パンくずリスト"] h2 span');
    if (breadcrumbTitle && breadcrumbTitle.textContent.trim()) {
      return ZenstudyToolDownloaderUtils.normalizeTitleText(breadcrumbTitle.textContent);
    }

    const titleEl = document.querySelector('h1, [class*="title"]');
    if (titleEl) return ZenstudyToolDownloaderUtils.normalizeTitleText(titleEl.textContent);
    return ZenstudyToolDownloaderUtils.normalizeTitleText(document.title);
  }

  getSectionTitle() {
    const selectors = [
      'main h1 span',
      'main h1',
      'nav[aria-label="パンくずリスト"] h2 span',
      'h1 span',
      'h1',
      'h2 span',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const text = (el.textContent || '').trim();
      if (text) return text;
    }

    return '';
  }

  getButtonHost() {
    return document.querySelector('.ReactModal__Content') || this.getModalIframe()?.parentElement || null;
  }

  checkAndShow() {
    if (!this.hasVideoModalOpen() || !this.hasAnyDownloadEnabled()) {
      this.syncLessonContext();
      this.removeButton();
      return;
    }

    const lessonChanged = this.syncLessonContext();

    const buttonHost = this.getButtonHost();
    if (!buttonHost) return;

    const buttonGroup = this.ensureButtonGroup(buttonHost);
    let btn = this.getDownloadButton();
    if (this.slideDownloadEnabled) {
      this.refreshSlideDownloadButton(buttonGroup);
    } else {
      this.removeSlideDownloadButton();
    }

    const hasRequiredButtons = !this.downloadEnabled || Boolean(btn);
    
    if (hasRequiredButtons) {
      this.refreshBatchDownloadButton(buttonGroup);
      const needsVideoButtonRefresh = this.downloadEnabled && (
        lessonChanged
        || (!this.hasCurrentVideoInfo() && btn.dataset.state !== 'waiting')
        || (this.hasCurrentVideoInfo() && btn.dataset.state === 'waiting')
      );

      if (needsVideoButtonRefresh) {
        this.setReadyState();
      }

      return;
    }

    this.title = this.getTitle();
    this.sectionTitle = this.getSectionTitle();

    if (this.downloadEnabled && !btn) {
      this.btn = document.createElement('button');
      btn = this.btn;
      btn.id = ELEMENT_IDS.downloadButton;
      btn.type = 'button';
      btn.className = CSS_CLASSES.downloadButton;
      btn.addEventListener('click', () => this.handleDownloadClick());
      buttonGroup.appendChild(btn);
    }

    if (this.downloadEnabled) {
      this.refreshBatchDownloadButton(buttonGroup);
      this.setReadyState();
    }
  }

  async startDownload({ fromBatch = false } = {}) {
    if (!this.downloadEnabled) return false;
    if (this.isBatchDownloading && !fromBatch) return false;
    if (this.isDownloading || !this.hasCurrentVideoInfo()) return false;

    const btn = this.getDownloadButton();
    if (btn && btn.disabled && !fromBatch) return false;

    const requestedVideoInfo = this.videoInfo;
    const downloadSequence = ++this.nextDownloadSequence;
    this.activeDownloadSequence = downloadSequence;
    this.isDownloading = true;

    try {
      this.title = await this.resolveTitle();
      this.sectionTitle = this.getSectionTitle();
      this.activeConversionRequestId = null;
    } catch (error) {
      if (this.activeDownloadSequence === downloadSequence) {
        this.resetDownloadState();
        this.setResultState('error', DOWNLOAD_BUTTON_TEXT.failed, !fromBatch);
      }
      if (!fromBatch) {
        alert(`ダウンロード準備に失敗しました: ${error.message || '不明なエラー'}`);
      }
      return false;
    }

    if (this.activeDownloadSequence !== downloadSequence) {
      return false;
    }

    const completionPromise = fromBatch
      ? new Promise((resolve) => {
        this.activeDownloadCompletion = { resolve, downloadSequence };
      })
      : null;

    this.setBusyState(DOWNLOAD_BUTTON_TEXT.preparing);

    safeRuntimeSendMessage({
      type: MESSAGE_TYPES.downloadVideo,
      videoInfo: requestedVideoInfo,
      title: this.title,
      sectionTitle: this.sectionTitle,
    }, (response, error) => {
      const isActiveDownload = this.activeDownloadSequence === downloadSequence;

      const handleFailure = (message) => {
        if (isActiveDownload) {
          this.resolveActiveDownloadCompletion(false, message);
          this.resetDownloadState();
          this.setResultState('error', DOWNLOAD_BUTTON_TEXT.failed, !fromBatch);
        }

        if (!fromBatch) {
          alert('ダウンロードに失敗しました: ' + message);
        }
      };

      if (error) {
        handleFailure(error.message || '不明なエラー');
        return;
      }

      if (!response || !response.success) {
        handleFailure(response?.message || '不明なエラー');
        return;
      }

      if (!isActiveDownload) return;
    });

    return completionPromise || true;
  }

  handleDownloadClick() {
    void this.startDownload();
  }

  requestBatchStop() {
    if (!this.isBatchDownloading) return;
    this.batchStopRequested = true;
    this.setBatchBusyState(BATCH_DOWNLOAD_BUTTON_TEXT.stopping);
  }

  async startBatchDownload() {
    if (!this.downloadEnabled || this.isBatchDownloading) return false;
    if (this.isDownloading || this.isSlideDownloading) return false;

    const targets = this.getVideoLessonTargets();
    if (targets.length === 0) {
      this.setBatchResultState('error', BATCH_DOWNLOAD_BUTTON_TEXT.failed);
      return false;
    }

    this.isBatchDownloading = true;
    this.batchStopRequested = false;
    this.batchCurrentTargetKey = await this.resolveInitialBatchTargetKey(targets);
    ZENSTUDYTOOL_AUTOMATION_STATE.batchDownloadActive = true;

    let completedCount = 0;
    let successCount = 0;
    let failureMessage = '';

    try {
      for (const target of targets) {
        if (this.batchStopRequested) break;

        this.setBatchBusyState(`${completedCount}/${targets.length} 保存中`);
        const selected = await this.selectBatchLesson(target);
        if (!selected || this.batchStopRequested) {
          if (!this.batchStopRequested) {
            failureMessage = '教材の切り替えを確認できませんでした';
          }
          break;
        }

        const ready = await this.waitForBatchVideoInfo();
        if (!ready || this.batchStopRequested) {
          if (!this.batchStopRequested) {
            failureMessage = '動画URLを取得できませんでした';
          }
          break;
        }

        const result = await this.startDownload({ fromBatch: true });
        completedCount += 1;
        if (result?.success) {
          successCount += 1;
        } else {
          failureMessage = result?.message || '動画保存に失敗しました';
          break;
        }
      }
    } finally {
      this.isBatchDownloading = false;
      ZENSTUDYTOOL_AUTOMATION_STATE.batchDownloadActive = false;
      this.batchStopRequested = false;
      this.batchCurrentTargetKey = '';
      this.setReadyState();
    }

    if (completedCount === 0) {
      if (failureMessage) {
        this.setBatchResultState('error', BATCH_DOWNLOAD_BUTTON_TEXT.failed);
      } else {
        this.setBatchReadyState();
      }
      return false;
    }

    if (successCount === completedCount && completedCount === targets.length) {
      this.setBatchResultState('success', `${BATCH_DOWNLOAD_BUTTON_TEXT.success} ${successCount}/${targets.length}`);
      return true;
    }

    if (failureMessage) {
      this.setBatchResultState('error', `${successCount}/${targets.length} 成功`);
      return successCount > 0;
    }

    this.setBatchResultState('ready', `${successCount}/${targets.length} で停止`);
    return successCount > 0;
  }

  handleBatchDownloadClick() {
    if (this.isBatchDownloading) {
      this.requestBatchStop();
      return;
    }

    void this.startBatchDownload();
  }

  async startSlideDownload() {
    if (!this.slideDownloadEnabled) return false;
    if (this.isBatchDownloading) return false;
    if (this.isSlideDownloading || !this.hasVideoModalOpen()) return false;

    const btn = this.getSlideDownloadButton();
    if (btn && btn.disabled) return false;

    const lessonFingerprint = this.getCurrentLessonFingerprint();
    this.isSlideDownloading = true;
    this.activeSlideDownloadRequestId = null;

    try {
      this.title = await this.resolveTitle();
      this.sectionTitle = this.getSectionTitle();

      if (this.getCurrentLessonFingerprint() !== lessonFingerprint) {
        this.resetSlideDownloadState();
        return false;
      }

      this.setSlideBusyState(SLIDE_DOWNLOAD_BUTTON_TEXT.preparing);
      const images = await this.collectSlideImages();

      if (this.getCurrentLessonFingerprint() !== lessonFingerprint) {
        this.resetSlideDownloadState();
        return false;
      }

      if (images.length === 0) {
        this.resetSlideDownloadState();
        this.setSlideResultState('error', SLIDE_DOWNLOAD_BUTTON_TEXT.failed);
        alert('スライド画像が見つかりませんでした。補助テキストが読み込まれてからもう一度お試しください。');
        return false;
      }

      safeRuntimeSendMessage({
        type: MESSAGE_TYPES.downloadSlideImages,
        images,
        title: this.title,
        sectionTitle: this.sectionTitle,
      }, (response, error) => {
        if (error) {
          this.resetSlideDownloadState();
          this.setSlideResultState('error', SLIDE_DOWNLOAD_BUTTON_TEXT.failed);
          alert('スライド保存に失敗しました: ' + (error.message || '不明なエラー'));
          return;
        }

        if (!response || !response.success) {
          this.resetSlideDownloadState();
          this.setSlideResultState('error', SLIDE_DOWNLOAD_BUTTON_TEXT.failed);
          alert('スライド保存に失敗しました: ' + (response?.message || '不明なエラー'));
          return;
        }

        if (response.requestId && !this.activeSlideDownloadRequestId) {
          this.activeSlideDownloadRequestId = response.requestId;
        }
      });
    } catch (error) {
      this.resetSlideDownloadState();
      this.setSlideResultState('error', SLIDE_DOWNLOAD_BUTTON_TEXT.failed);
      alert(`スライド保存の準備に失敗しました: ${error.message || '不明なエラー'}`);
      return false;
    }

    return true;
  }

  handleSlideDownloadClick() {
    void this.startSlideDownload();
  }

  removeButton() {
    this.stopWaitingPoll();
    this.lastSelectedTitle = '';
    if (this.isBatchDownloading) {
      this.requestBatchStop();
    }
    this.resolveActiveDownloadCompletion(false, '教材画面が閉じられました');
    this.resetDownloadState();
    this.resetSlideDownloadState();

    if (this.resetTimerId) {
      clearTimeout(this.resetTimerId);
      this.resetTimerId = null;
    }

    if (this.slideResetTimerId) {
      clearTimeout(this.slideResetTimerId);
      this.slideResetTimerId = null;
    }

    if (this.batchResetTimerId) {
      clearTimeout(this.batchResetTimerId);
      this.batchResetTimerId = null;
    }

    const existingGroup = document.getElementById(ELEMENT_IDS.downloadButtonGroup);
    if (existingGroup) existingGroup.remove();
    this.buttonGroup = null;
    this.btn = null;
    this.batchBtn = null;
    this.slideBtn = null;
  }

  updateProgress(msg) {
    if (!this.getDownloadButton() || !this.isDownloading) return;

    if (msg && msg.requestId) {
      if (this.activeConversionRequestId && this.activeConversionRequestId !== msg.requestId) {
        return;
      }
      if (!this.activeConversionRequestId && (msg.phase === 'init' || msg.phase === 'download' || msg.phase === 'save')) {
        this.activeConversionRequestId = msg.requestId;
      }
    }
    
    if (msg.phase === 'init') {
      this.setBusyState(DOWNLOAD_BUTTON_TEXT.preparing);
    } else if (msg.phase === 'download') {
      const percentage = msg.total > 0
        ? Math.floor((msg.current / msg.total) * 100)
        : 0;
      this.setBusyState(`${DOWNLOAD_BUTTON_TEXT.downloading} ${percentage}%`);
    } else if (msg.phase === 'save') {
      if (msg.total > 0) {
        const percentage = Math.floor((msg.current / msg.total) * 100);
        this.setBusyState(`${DOWNLOAD_BUTTON_TEXT.saving} ${percentage}%`);
      } else if (msg.current > 0) {
        this.setBusyState(`${DOWNLOAD_BUTTON_TEXT.saving} ${formatByteSize(msg.current)}`);
      } else {
        this.setBusyState(DOWNLOAD_BUTTON_TEXT.saving);
      }
    } else if (msg.phase === 'done') {
      this.resolveActiveDownloadCompletion(true);
      this.resetDownloadState();
      this.setResultState('success', DOWNLOAD_BUTTON_TEXT.success, !this.isBatchDownloading);
    } else if (msg.phase === 'error') {
      this.resolveActiveDownloadCompletion(false, msg.error || 'ダウンロードに失敗しました');
      this.resetDownloadState();
      this.setResultState('error', DOWNLOAD_BUTTON_TEXT.failed, !this.isBatchDownloading);
    }
  }

  updateSlideProgress(msg) {
    if (!this.getSlideDownloadButton() || !this.isSlideDownloading) return;

    if (msg && msg.requestId) {
      if (this.activeSlideDownloadRequestId && this.activeSlideDownloadRequestId !== msg.requestId) {
        return;
      }

      if (!this.activeSlideDownloadRequestId && (msg.phase === 'prepare' || msg.phase === 'queue')) {
        this.activeSlideDownloadRequestId = msg.requestId;
      }
    }

    if (msg.phase === 'prepare') {
      this.setSlideBusyState(SLIDE_DOWNLOAD_BUTTON_TEXT.preparing);
      return;
    }

    if (msg.phase === 'queue') {
      const progressText = msg.total > 0
        ? `${SLIDE_DOWNLOAD_BUTTON_TEXT.downloading} ${Math.min(msg.current, msg.total)}/${msg.total}`
        : SLIDE_DOWNLOAD_BUTTON_TEXT.downloading;
      this.setSlideBusyState(progressText);
      return;
    }

    if (msg.phase === 'done') {
      this.resetSlideDownloadState();
      this.setSlideResultState('success', SLIDE_DOWNLOAD_BUTTON_TEXT.success);
      return;
    }

    if (msg.phase === 'error') {
      this.resetSlideDownloadState();
      this.setSlideResultState('error', SLIDE_DOWNLOAD_BUTTON_TEXT.failed);
    }
  }
}
