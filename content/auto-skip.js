class ZenstudyToolAutoSkip {
  constructor() {
    this.enabled = false;
    this.observer = null;
    this.isSkipping = false;
    this.skipTimerId = null;
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
    this.observer = createDebouncedObserver(() => this.checkAndSkip(), 500, true);
    // 初回チェック
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
    this.isSkipping = false;
    this.lastClickedName = "";
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
