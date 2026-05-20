/**
 * ZenstudyTool - Content Script
 *
 * 機能一覧:
 *   1. 「必修教材のみ」フィルタの常時・強制有効化
 *   2. 必修動画の合計時間をインライン表示
 *   3. 期限までの1日あたり必要視聴時間を自動計算・表示
 *   4. 完了済み教材の自動スキップ
 */

// 定数

const {
  STORAGE_KEYS,
  MESSAGE_TYPES,
} = globalThis.ZenstudyToolConstants;

/** CSSクラス名 */
const CSS_CLASSES = {
  wrapper: "__ZENSTUDYTOOL_wrapper",
  faint: "__ZENSTUDYTOOL_faint",
  dailyTarget: "__ZENSTUDYTOOL_dailyTarget",
  downloadButtonGroup: "__ZENSTUDYTOOL_downloadButtonGroup",
  downloadButton: "__ZENSTUDYTOOL_downloadButton",
  slideDownloadButton: "__ZENSTUDYTOOL_slideDownloadButton",
  actionRow: "__ZENSTUDYTOOL_actionRow",
  footerActionButton: "__ZENSTUDYTOOL_footerActionButton",
  fieldProofreadRow: "__ZENSTUDYTOOL_fieldProofreadRow",
  fieldProofreadRowTextarea: "__ZENSTUDYTOOL_fieldProofreadRowTextarea",
  fieldProofreadActions: "__ZENSTUDYTOOL_fieldProofreadActions",
  fieldProofreadButton: "__ZENSTUDYTOOL_fieldProofreadButton",
  answerLengthBadge: "__ZENSTUDYTOOL_answerLengthBadge",
};

/** DOM要素ID */
const ELEMENT_IDS = {
  copyButton: "__ZENSTUDYTOOL_copy_btn",
  downloadButtonGroup: "__ZENSTUDYTOOL_download_btn_group",
  downloadButton: "__ZENSTUDYTOOL_download_btn",
  slideDownloadButton: "__ZENSTUDYTOOL_slide_download_btn",
  proofreadButton: "__ZENSTUDYTOOL_proofread_btn",
};

/** ダウンロードボタン文言 */
const DOWNLOAD_BUTTON_TEXT = {
  ready: "動画保存",
  waiting: "URL取得中...",
  preparing: "準備中...",
  downloading: "ダウンロード中...",
  saving: "保存中...",
  success: "完了",
  failed: "失敗",
};

const SLIDE_DOWNLOAD_BUTTON_TEXT = {
  ready: "画像一括保存",
  preparing: "画像検出中...",
  downloading: "保存中...",
  success: "保存開始",
  failed: "失敗",
};

const PROOFREAD_BUTTON_TEXT = {
  ready: "まとめてAI校正",
  working: "まとめてAI校正中...",
  success: "校正完了",
  failed: "校正失敗",
};

const FIELD_PROOFREAD_BUTTON_TEXT = {
  ready: "AI校正",
  working: "AI校正中...",
  success: "校正完了",
  failed: "校正失敗",
};

/** DOM監視のデバウンス間隔 (ms) */
const DEBOUNCE_MS = 50;

/** フィルタボタンの連打防止間隔 (ms) */
const FILTER_CLICK_COOLDOWN_MS = 500;

/** フィルタ状態を定期チェックする間隔 (ms) */
const FILTER_POLL_INTERVAL_MS = 2000;

/** 自動スキップの遷移後に次の操作を待つ間隔 (ms) */
const AUTO_SKIP_DELAY_MS = 1500;

/** ボタンのaria-label */
const ARIA_LABELS = {
  essential: "必修教材のみ",
  nPlus: "Nプラス教材のみ",
};

/** API エンドポイント */
const API_BASE_URL = "https://api.nnn.ed.nico";

// ユーティリティ

/**
 * DOM要素を簡易生成する
 * @param {string} tag  - タグ名
 * @param {Object} props - 要素に設定するプロパティ
 * @param {Array<string|Node>} children - 子要素
 * @returns {HTMLElement}
 */
const createElement = (tag, props = {}, children = []) => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const child of children) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else if (child) {
      el.appendChild(child);
    }
  }
  return el;
};

/**
 * 秒数を "H:MM:SS" 形式にフォーマットする
 * @param {number} seconds
 * @returns {string}
 */
const formatTime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const minuteStr = `${h ? String(m).padStart(2, "0") : m}:`;
  const secondStr = String(s).padStart(2, "0");
  return `${h ? `${h}:` : ""}${minuteStr}${secondStr}`;
};

/**
 * バイト数を読みやすい単位に整形する
 * @param {number} bytes
 * @returns {string}
 */
const formatByteSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value >= 100 || unitIndex === 0
    ? 0
    : value >= 10
      ? 1
      : 2;

  return `${value.toFixed(fractionDigits)}${units[unitIndex]}`;
};

const normalizeCharacterRuleText = (text) => {
  return String(text || "")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const parseCharacterCountRule = (text) => {
  const normalized = normalizeCharacterRuleText(text);
  const rule = { min: null, max: null };

  const explicitMin = normalized.match(/(\d{1,5})\s*(?:字|文字)\s*以上/);
  if (explicitMin) rule.min = Number.parseInt(explicitMin[1], 10) || null;

  const explicitMax = normalized.match(/(\d{1,5})\s*(?:字|文字)\s*(?:以内|以下)/);
  if (explicitMax) rule.max = Number.parseInt(explicitMax[1], 10) || null;

  const range = normalized.match(/(\d{1,5})\s*[~〜～\-－]\s*\d{1,5}\s*(?:字|文字)/);
  if (range) {
    const rangeMax = normalized.match(/\d{1,5}\s*[~〜～\-－]\s*(\d{1,5})\s*(?:字|文字)/);
    rule.min = rule.min || Number.parseInt(range[1], 10) || null;
    rule.max = rule.max || Number.parseInt(rangeMax?.[1] || "", 10) || null;
  }

  if (rule.min && rule.max && rule.min > rule.max) {
    return { min: rule.max, max: rule.min };
  }

  return rule;
};

const collectQuestionTextForField = (field) => {
  const item = field.closest("li.exercise-item, .exercise-item, .answer-area") || field.closest("section.exercise");
  const section = field.closest("section.exercise");
  const parts = [
    section?.querySelector(".statement")?.textContent || "",
    item?.querySelector(".question")?.textContent || "",
    item && !item.querySelector(".question") ? item.textContent || "" : "",
  ];

  return normalizeCharacterRuleText(parts.join(" "));
};

const getAnswerLengthRuleForField = (field) => {
  const rule = parseCharacterCountRule(collectQuestionTextForField(field));
  return rule.min || rule.max ? rule : null;
};

const countAnswerCharacters = (value) => {
  return String(value || "").replace(/\r\n/g, "\n").length;
};

const formatCharacterCountRule = (rule) => {
  if (!rule?.min && !rule?.max) return "";
  if (rule.min && rule.max) return `${rule.min}字以上${rule.max}字以内`;
  if (rule.min) return `${rule.min}字以上`;
  return `${rule.max}字以内`;
};

/**
 * 日割り秒数を "X時間Y分" 形式にフォーマットする
 * @param {number} seconds
 * @returns {string}
 */
const formatDailyTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0秒";
  }

  const totalSeconds = Math.ceil(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  let res = "";
  if (h > 0) res += `${h}時間`;
  if (m > 0 || h > 0) res += `${m}分`;
  res += `${s}秒`;
  return res;
};

/**
 * 残り秒数と期限日から1日あたりの必要視聴時間を計算する
 * @param {number} remainingSeconds - 残りの視聴時間（秒）
 * @param {Date} deadlineDate - 期限日（この日の0:00が締切）
 * @returns {{secondsPerDay:number, daysRemaining:number}|{expired:true}|null}
 */
const calculateDailyTarget = (remainingSeconds, deadlineDate) => {
  if (remainingSeconds <= 0) return null;
  const now = new Date();
  const msRemaining = deadlineDate.getTime() - now.getTime();
  if (msRemaining <= 0) return { expired: true };
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
  const secondsPerDay = remainingSeconds / daysRemaining;
  return { secondsPerDay, daysRemaining };
};

/**
 * デバウンス付き MutationObserver を生成・開始する
 * @param {Function} callback  - デバウンス後に実行されるコールバック
 * @param {number}   delayMs   - デバウンス間隔
 * @returns {MutationObserver}
 */
const createDebouncedRootObserver = (root, callback, delayMs = DEBOUNCE_MS, observeAttributes = false) => {
  if (!root) return null;

  let timeoutId = null;
  const observer = new MutationObserver(() => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(callback, delayMs);
  });
  const config = { childList: true, subtree: true };
  if (observeAttributes) config.attributes = true;
  observer.observe(root, config);
  const disconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    disconnect();
  };
  return observer;
};

const createDebouncedObserver = (callback, delayMs = DEBOUNCE_MS, observeAttributes = false) => (
  createDebouncedRootObserver(document.body, callback, delayMs, observeAttributes)
);

const getAccessibleIframeDocument = (iframe) => {
  if (!iframe) return null;

  try {
    return iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch (err) {
    console.warn('[ZenstudyTool] iframe document access failed', err);
    return null;
  }
};

const normalizeButtonLabel = (element) => String(
  element?.textContent
  || element?.value
  || element?.getAttribute?.("aria-label")
  || ""
).replace(/\s+/g, " ").trim();

const findActionButtonWrapper = (doc) => {
  const explicitWrapper = doc?.querySelector?.(".evaluate-button");
  if (explicitWrapper) return explicitWrapper;

  const actionLabels = new Set(["答え合わせ", "提出", "再受講する"]);
  const actionButton = Array.from(
    doc?.querySelectorAll?.('button, a[role="button"], input[type="button"], input[type="submit"]') || []
  ).find((element) => actionLabels.has(normalizeButtonLabel(element)));

  return actionButton?.parentElement || null;
};

/**
 * 時間データの配列を合算する
 * @param {Array<{goal:number, current:number}|null>} results
 * @returns {{goal:number, current:number}}
 */
const sumTimeResults = (results) => {
  const sums = { goal: 0, current: 0 };
  for (const result of results) {
    if (result) {
      sums.goal += result.goal;
      sums.current += result.current;
    }
  }
  return sums;
};

const isExtensionContextInvalidatedError = (value) => {
  const message = typeof value === "string" ? value : value?.message || "";
  return /Extension context invalidated/i.test(message);
};

const safeStorageGet = (defaults, callback) => {
  try {
    chrome.storage.local.get(defaults, (result) => {
      const lastError = chrome.runtime?.lastError || null;
      if (lastError) {
        if (!isExtensionContextInvalidatedError(lastError)) {
          console.warn("[ZenstudyTool] chrome.storage.local.get failed", lastError);
        }
        callback(defaults);
        return;
      }

      callback(result);
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      callback(defaults);
      return;
    }

    throw error;
  }
};

const addSafeStorageChangeListener = (listener) => {
  try {
    chrome.storage.onChanged.addListener(listener);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }

    throw error;
  }
};

const addSafeRuntimeMessageListener = (listener) => {
  try {
    chrome.runtime.onMessage.addListener(listener);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }

    throw error;
  }
};

const safeRuntimeSendMessage = (message, callback = () => {}) => {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime?.lastError || null;
      if (lastError && isExtensionContextInvalidatedError(lastError)) {
        callback(undefined, lastError);
        return;
      }

      callback(response, lastError);
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      callback(undefined, error);
      return;
    }

    throw error;
  }
};

