class ZenstudyToolAutoSkip {
  constructor() {
    this.enabled = false;
    this.observer = null;
    this.isSkipping = false;
    this.skipTimerId = null;
    this.quickActionTimerId = null;
    this.lastQuickActionKey = "";
    /** 直前にクリックした教材名（連打防止） */
    this.lastClickedName = "";

    // ストレージから初期状態を読み込み
    safeStorageGet(
      { [STORAGE_KEYS.autoSkipEnabled]: false },
      (result) => {
        this.enabled = result[STORAGE_KEYS.autoSkipEnabled];
        if (this.enabled) this.start();
      }
    );

    // ストレージ変更をリアルタイムに反映
    addSafeStorageChangeListener((changes, area) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEYS.autoSkipEnabled];
      if (change === undefined) return;
      this.enabled = change.newValue;
      change.newValue ? this.start() : this.stop();
    });
  }

  start() {
    if (this.observer) return;
    this.lastClickedName = "";
    // DOM変更と属性変更（SVGのcolor変化）を監視
    this.observer = createDebouncedObserver(() => {
      this.checkExerciseResultAction();
      this.checkAndSkip();
    }, 100, true);
    // 初回チェック
    this.checkExerciseResultAction();
    this.checkAndSkip();
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.skipTimerId) {
      clearTimeout(this.skipTimerId);
      this.skipTimerId = null;
    }
    if (this.quickActionTimerId) {
      clearTimeout(this.quickActionTimerId);
      this.quickActionTimerId = null;
    }
    this.isSkipping = false;
    this.lastClickedName = "";
    this.lastQuickActionKey = "";
  }

  /**
   * 教材リストを上から見て、最初の「緑じゃない行」をクリックする。
   */
  checkAndSkip() {
    if (this.isSkipping || isBatchDownloadActive()) return;

    // 教材リスト・レポートリストをDOM順にまとめて取得
    const items = Array.from(
      document.querySelectorAll('ul[aria-label$="リスト"] > li')
    );
    if (items.length === 0) return;

    // 上から順に、最初の緑じゃない対象教材を探す。
    // レポートは自動操作しない。
    for (const item of items) {
      if (this.isReportItem(item)) continue;

      if (!this.isGreen(item)) {
        // この行が緑じゃない = まだ未完了 → ここをクリックすべき先
        const name = this.getItemName(item);

        // 既にこの教材をクリック済みなら何もしない（視聴中）
        if (name && name === this.lastClickedName) return;

        // クリック実行
        this.isSkipping = true;
        this.lastClickedName = name;

        this.skipTimerId = setTimeout(() => {
          this.skipTimerId = null;
          if (!this.enabled || isBatchDownloadActive()) {
            this.isSkipping = false;
            return;
          }

          const clickTarget = item.querySelector("div");
          if (clickTarget) clickTarget.click();
          this.isSkipping = false;
        }, AUTO_SKIP_DELAY_MS);

        return;
      }
    }
    // 全部緑 → 何もしない
  }

  /**
   * 確認テストの結果表示後だけ、次の操作を素早く実行する。
   * 選択肢の自動回答はしない。
   */
  checkExerciseResultAction() {
    if (!this.enabled || isBatchDownloadActive()) return;
    if (!this.isExercisePage()) return;

    const retryButton = this.findActionButtonByLabels([
      "再受講する",
      "再受講",
      "もう一度",
      "もう一度解く",
      "やり直す",
    ]);
    if (retryButton && this.hasIncorrectResult()) {
      this.scheduleQuickClick(retryButton, `retry:${location.href}`);
      return;
    }

    if (this.hasCorrectResult()) {
      const nextButton = this.findActionButtonByLabels([
        "次へ",
        "次の教材へ",
        "次の動画へ",
        "次の動画",
        "次に進む",
        "次へ進む",
        "次のレッスンへ",
        "次の章へ",
      ]);

      if (nextButton) {
        this.scheduleQuickClick(nextButton, `next-button:${location.href}`);
        return;
      }

      const nextItem = this.findNextIncompleteItem();
      if (!nextItem) return;

      const nextItemName = this.getItemName(nextItem);
      if (!nextItemName || nextItemName !== this.lastClickedName) {
        const clickTarget = nextItem.querySelector("div") || nextItem;
        this.scheduleQuickClick(clickTarget, `next-item:${nextItemName}`);
      }
    }
  }

  isExercisePage() {
    if (/\/exercise\//.test(location.pathname)) return true;

    const text = this.getVisibleResultText();
    if (/確認テスト|答え合わせ|再受講/.test(text)) return true;
    return Boolean(this.findActionButtonByLabels(["答え合わせ", "再受講"]));
  }

  findActionButtonByLabels(labels) {
    return this.getCandidateDocuments()
      .flatMap((doc) => Array.from(
        doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
      ))
      .find((element) => {
        const label = normalizeButtonLabel(element);
        if (!label || !labels.some((expected) => label.includes(expected))) return false;
        if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
        return this.isElementVisible(element);
      });
  }

  hasIncorrectResult() {
    const text = this.getVisibleResultText();
    return /不正解|不合格|間違|残念|再受講|もう一度|やり直/.test(text);
  }

  hasCorrectResult() {
    const text = this.getVisibleResultText();
    if (this.hasIncorrectResult()) return false;
    return /正解|合格|完了|クリア|おめでとう|全問正解|満点/.test(text);
  }

  getVisibleResultText() {
    return this.getCandidateDocuments()
      .map((doc) => {
        const main = doc.querySelector('main, [role="main"], .exercise, section') || doc.body;
        return main?.textContent || "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  scheduleQuickClick(target, key) {
    if (!target || key === this.lastQuickActionKey) return;
    this.lastQuickActionKey = key;

    if (this.quickActionTimerId) clearTimeout(this.quickActionTimerId);
    this.quickActionTimerId = setTimeout(() => {
      this.quickActionTimerId = null;
      if (!this.enabled || isBatchDownloadActive()) return;
      target.click();
    }, 100);
  }

  getCandidateDocuments() {
    const docs = [document];
    for (const iframe of document.querySelectorAll("iframe")) {
      const iframeDoc = getAccessibleIframeDocument(iframe);
      if (iframeDoc && !docs.includes(iframeDoc)) docs.push(iframeDoc);
    }
    return docs;
  }

  isElementVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none";
  }

  findNextIncompleteItem() {
    const items = Array.from(
      document.querySelectorAll('ul[aria-label$="リスト"] > li')
    );
    return items.find((item) => !this.isReportItem(item) && !this.isGreen(item));
  }

  /**
   * 行が「緑」（視聴済み）かどうか
   * @param {HTMLElement} item - <li>要素
   * @returns {boolean}
   */
  isGreen(item) {
    return item.querySelector('svg[color="#00c541"]') !== null;
  }

  /**
   * 行から教材名を取得
   * @param {HTMLElement} item - <li>要素
   * @returns {string}
   */
  getItemName(item) {
    const span = item.querySelector('span[font-size="1.5rem"]');
    return span ? span.textContent.trim() : "";
  }

  /**
   * レポート行かどうかを判定する。
   * 自動スキップではレポートを開いたり提出画面を操作したりしない。
   * @param {HTMLElement} item - <li>要素
   * @returns {boolean}
   */
  isReportItem(item) {
    const text = item.textContent || "";
    if (/レポート|report/i.test(text)) return true;

    const reportLink = item.querySelector(
      'a[href*="/reports/"], a[href*="/report/"], a[href*="/evaluation_reports/"], a[href*="/evaluation_report/"], a[href*="/essay_reports/"], a[href*="/essay_report/"], a[aria-label*="レポート"]'
    );
    return Boolean(reportLink);
  }
}
