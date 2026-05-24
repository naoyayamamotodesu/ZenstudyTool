/**
 * ZenstudyTool - Background Service Worker
 *
 * 機能:
 *   1. chrome.webRequest で .m3u8 / .mp4 URL を傍受し content.js に通知
 *   2. ダウンロードリクエスト受信時に offscreen document + ffmpeg.wasm で変換
 *   3. MP4/TS のダウンロード
 */

importScripts('shared/constants.js');

const {
  GEMINI_MODEL_MODES,
  GEMINI_MODEL_MANUAL_OPTIONS: GEMINI_PROOFREAD_MODELS,
  GEMINI_MODEL_FALLBACK_ORDERS: GEMINI_PROOFREAD_FALLBACK_ORDERS,
  DEFAULT_GEMINI_MODEL: DEFAULT_GEMINI_PROOFREAD_MODEL,
  MESSAGE_TYPES,
  STORAGE_KEYS,
} = globalThis.ZenstudyToolConstants;

// タブごとに最新の動画URLを保持
const tabVideoUrls = new Map();
const CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_PROGRESS_THROTTLE_MS = 250;
const GEMINI_REQUEST_TIMEOUT_MS = 30 * 1000;
const GEMINI_MODEL_PROBE_TIMEOUT_MS = 12 * 1000;
const GEMINI_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROOFREAD_MIN_OUTPUT_TOKENS = 2048;
const PROOFREAD_MAX_OUTPUT_TOKENS = 8192;
const GEMINI_THINKING_PROFILES = Object.freeze({
  fastest: 'fastest',
  standard: 'standard',
  highest: 'highest',
});
const GEMINI_25_THINKING_BUDGETS = Object.freeze({
  'gemini-2.5-pro': {
    fastest: 128,
    standard: -1,
    highest: 32768,
  },
  'gemini-2.5-flash': {
    fastest: 0,
    standard: -1,
    highest: 24576,
  },
  'gemini-2.5-flash-lite': {
    fastest: 0,
    standard: -1,
    highest: 24576,
  },
});
const VIDEO_REQUEST_URL_PATTERNS = Object.freeze([
  '*://*.nnn.ed.nico/*',
  '*://*.nicovideo.jp/*',
  '*://*.dmc.nico/*',
  '*://*.cdn.nnn.ed.nico/*',
  '<all_urls>',
]);
const DOWNLOAD_PATH_SEGMENT_MAX_LENGTH = 100;
const WINDOWS_RESERVED_FILE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PROOFREAD_SYSTEM_INSTRUCTION = 'You are a proofreading engine for student submissions. Only rewrite the student text itself. Never add explanations, labels, greetings, bullet points, quotations, or any extra text that is not meant to be submitted. Preserve the original meaning and language, and if the text is already acceptable, return it unchanged.';
const PROOFREAD_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['correctedText'],
  properties: {
    correctedText: {
      type: 'string',
      description: 'The corrected submission text only. No headings, notes, explanations, labels, or quotation marks unless the submission itself requires them.',
    },
  },
  propertyOrdering: ['correctedText'],
});
const GEMINI_PROOFREAD_MODEL_CONFIGS = Object.freeze({
  'gemini-3.1-pro-preview': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: true,
  },
  'gemini-3.5-flash': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: true,
  },
  'gemini-3-flash-preview': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: true,
  },
  'gemini-3.1-flash-lite': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: true,
  },
  'gemini-3.1-flash-lite-preview': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: false,
    preserveDefaultTemperature: true,
  },
  'gemini-2.5-flash': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: false,
  },
  'gemini-2.5-flash-lite': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: false,
  },
  'gemini-2.5-pro': {
    supportsSystemInstruction: true,
    supportsStructuredOutput: true,
    preserveDefaultTemperature: false,
  },
  'gemma-4-31b-it': {
    supportsSystemInstruction: false,
    supportsStructuredOutput: false,
    preserveDefaultTemperature: false,
  },
  'gemma-4-26b-a4b-it': {
    supportsSystemInstruction: false,
    supportsStructuredOutput: false,
    preserveDefaultTemperature: false,
  },
});
const trackedDownloads = new Map();
const geminiGenerateContentModelsCache = {
  apiKey: '',
  fetchedAt: 0,
  models: [],
};

function normalizeDownloadPathSegment(value, fallback = '') {
  const normalized = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, DOWNLOAD_PATH_SEGMENT_MAX_LENGTH)
    .replace(/[. ]+$/g, '');

  if (!normalized) {
    return fallback;
  }

  return WINDOWS_RESERVED_FILE_NAME_RE.test(normalized)
    ? `${normalized}_`
    : normalized;
}

function buildDownloadFilename({ title, sectionTitle = '', extension }) {
  const safeTitle = normalizeDownloadPathSegment(title, 'video');
  const safeSection = normalizeDownloadPathSegment(sectionTitle, '');
  return safeSection
    ? `${safeSection}/${safeTitle}.${extension}`
    : `${safeTitle}.${extension}`;
}

function buildDownloadDirectory({ title, sectionTitle = '', suffix = '' }) {
  const safeTitle = normalizeDownloadPathSegment(title, 'video');
  const safeSection = normalizeDownloadPathSegment(sectionTitle, '');
  const safeSuffix = normalizeDownloadPathSegment(suffix, '');
  const leafDirectory = safeSuffix ? `${safeTitle}_${safeSuffix}` : safeTitle;

  return safeSection
    ? `${safeSection}/${leafDirectory}`
    : leafDirectory;
}

function getDownloadExtensionFromUrl(url, fallback = 'jpg') {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
    if (match) return match[1].toLowerCase();
  } catch (_) {
    // URL parse failure falls back below.
  }

  return fallback;
}

function normalizeSlideImageEntries(images) {
  if (!Array.isArray(images)) {
    return [];
  }

  const normalizedImages = [];
  const seenUrls = new Set();

  for (const [index, item] of images.entries()) {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      continue;
    }

    let url;
    try {
      url = new URL(rawUrl).href;
    } catch (_) {
      continue;
    }

    if (seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);

    const rawFileStem = typeof item === 'object' && item
      ? (item.fileStem || item.name || '')
      : '';
    const sanitizedFileStem = normalizeDownloadPathSegment(rawFileStem, '')
      .replace(/\.[^.]+$/u, '');

    normalizedImages.push({
      url,
      fileStem: sanitizedFileStem || `slide_${String(index + 1).padStart(3, '0')}`,
    });
  }

  return normalizedImages;
}

function normalizeVideoInfo(videoInfo) {
  if (!videoInfo || typeof videoInfo !== 'object') {
    return null;
  }

  if (videoInfo.type !== 'mp4' && videoInfo.type !== 'm3u8') {
    return null;
  }

  if (typeof videoInfo.url !== 'string' || !videoInfo.url.trim()) {
    return null;
  }

  try {
    new URL(videoInfo.url);
  } catch (_) {
    return null;
  }

  return {
    url: videoInfo.url,
    type: videoInfo.type,
    timestamp: Number.isFinite(videoInfo.timestamp) ? videoInfo.timestamp : Date.now(),
  };
}

function createRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `zst-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function requestBlobRevoke(requestId, blobUrl) {
  if (!blobUrl) return;
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.revokeBlobUrl,
    requestId,
    blobUrl,
  }).catch(() => {});
}

function cleanupTrackedDownload(downloadId) {
  const tracked = trackedDownloads.get(downloadId);
  if (!tracked) return null;

  trackedDownloads.delete(downloadId);

  if (tracked.blobUrl) {
    requestBlobRevoke(tracked.requestId, tracked.blobUrl);
  }

  return tracked;
}

function sendTrackedDownloadProgress(tracked, force = false) {
  if (!tracked) return;

  const now = Date.now();
  const total = Number.isFinite(tracked.totalBytes) && tracked.totalBytes > 0
    ? tracked.totalBytes
    : 0;
  const current = Number.isFinite(tracked.bytesReceived) && tracked.bytesReceived > 0
    ? tracked.bytesReceived
    : 0;
  const percentage = total > 0
    ? Math.floor((current / total) * 100)
    : -1;

  if (!force) {
    if (percentage >= 0 && percentage === tracked.lastSentPercentage && (now - tracked.lastSentAt) < DOWNLOAD_PROGRESS_THROTTLE_MS) {
      return;
    }
    if (percentage < 0 && (now - tracked.lastSentAt) < DOWNLOAD_PROGRESS_THROTTLE_MS) {
      return;
    }
  }

  tracked.lastSentAt = now;
  tracked.lastSentPercentage = percentage;

  sendConversionProgress({
    type: MESSAGE_TYPES.conversionProgress,
    phase: 'save',
    current,
    total,
    requestId: tracked.requestId,
    outputType: tracked.outputType,
  }, tracked.sourceTabId);
}

function getLocalStorage(defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaults, (result) => {
      const lastError = chrome.runtime?.lastError || null;
      if (lastError) {
        reject(new Error(lastError.message || 'ストレージの読み込みに失敗しました'));
        return;
      }

      resolve(result);
    });
  });
}

function createProofreadError(message, code, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

function getProofreadMaxOutputTokens(originalText) {
  const textLength = String(originalText || '').length;
  const estimatedTokens = Math.ceil(textLength * 1.5) + 512;
  return Math.min(
    PROOFREAD_MAX_OUTPUT_TOKENS,
    Math.max(PROOFREAD_MIN_OUTPUT_TOKENS, estimatedTokens)
  );
}

function normalizeProofreadModelMode(value) {
  return Object.values(GEMINI_MODEL_MODES).includes(value) ? value : GEMINI_MODEL_MODES.auto;
}

function normalizeProofreadModelName(value) {
  return GEMINI_PROOFREAD_MODELS.includes(value)
    ? value
    : DEFAULT_GEMINI_PROOFREAD_MODEL;
}

function getProofreadModelAliasCandidates(modelName) {
  const normalizedModelName = normalizeProofreadModelName(modelName);
  return normalizedModelName ? [normalizedModelName] : [];
}

function getProofreadModelLookupKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getModelIdFromResourceName(resourceName) {
  return typeof resourceName === 'string' ? resourceName.replace(/^models\//i, '') : '';
}

function doesApiModelMatchCandidate(apiModel, candidateName) {
  const candidateKey = getProofreadModelLookupKey(candidateName);
  if (!candidateKey) return false;

  const lookupKeys = [
    getProofreadModelLookupKey(apiModel?.baseModelId),
    getProofreadModelLookupKey(getModelIdFromResourceName(apiModel?.name)),
  ].filter(Boolean);

  return lookupKeys.some((lookupKey) => lookupKey === candidateKey || lookupKey.startsWith(`${candidateKey}-`));
}

function getApiModelRequestName(apiModel) {
  if (typeof apiModel?.baseModelId === 'string' && apiModel.baseModelId.trim()) {
    return apiModel.baseModelId.trim();
  }

  return getModelIdFromResourceName(apiModel?.name);
}

async function listGenerateContentModels(apiKey) {
  const now = Date.now();
  if (
    geminiGenerateContentModelsCache.apiKey === apiKey
    && (now - geminiGenerateContentModelsCache.fetchedAt) < GEMINI_MODELS_CACHE_TTL_MS
    && Array.isArray(geminiGenerateContentModelsCache.models)
  ) {
    return geminiGenerateContentModelsCache.models;
  }

  const models = [];
  let pageToken = '';

  do {
    const url = new URL(`${GEMINI_API_BASE_URL}/models`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
    });
    const responseJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiMessage = responseJson?.error?.message || `Gemini models.list error (${response.status})`;
      throw createProofreadError(apiMessage, `HTTP_${response.status}`, {
        status: response.status,
        apiStatus: responseJson?.error?.status || '',
      });
    }

    const pageModels = Array.isArray(responseJson?.models) ? responseJson.models : [];
    models.push(
      ...pageModels.filter((model) => Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
    );
    pageToken = typeof responseJson?.nextPageToken === 'string' ? responseJson.nextPageToken : '';
  } while (pageToken);

  geminiGenerateContentModelsCache.apiKey = apiKey;
  geminiGenerateContentModelsCache.fetchedAt = now;
  geminiGenerateContentModelsCache.models = models;
  return models;
}

async function resolveProofreadRequestModelName(apiKey, modelName) {
  const aliasCandidates = getProofreadModelAliasCandidates(modelName);

  try {
    const availableModels = await listGenerateContentModels(apiKey);
    return findAvailableProofreadModel(availableModels, modelName);
  } catch (error) {
    if (isAuthOrPermissionError(error)) {
      throw error;
    }

    console.warn('[ZenstudyTool BG] Failed to list Gemini API models. Falling back to alias candidate.', {
      modelName,
      error: error.message,
    });
    return aliasCandidates[0] || null;
  }
}

function findAvailableProofreadModel(availableModels, modelName) {
  const aliasCandidates = getProofreadModelAliasCandidates(modelName);
  for (const candidateName of aliasCandidates) {
    const matchedModel = availableModels.find((apiModel) => doesApiModelMatchCandidate(apiModel, candidateName));
    const requestModelName = getApiModelRequestName(matchedModel);
    if (requestModelName) {
      return requestModelName;
    }
  }

  return null;
}

function getProofreadModelConfig(modelName) {
  const modelKey = getProofreadModelConfigKey(modelName);
  return GEMINI_PROOFREAD_MODEL_CONFIGS[modelKey] || {
    supportsSystemInstruction: false,
    supportsStructuredOutput: false,
    preserveDefaultTemperature: false,
  };
}

function getProofreadModelCandidates(mode, selectedModel) {
  if (mode === GEMINI_MODEL_MODES.manual) {
    return [normalizeProofreadModelName(selectedModel)];
  }

  const fallbackOrder = GEMINI_PROOFREAD_FALLBACK_ORDERS[mode] || GEMINI_PROOFREAD_FALLBACK_ORDERS[GEMINI_MODEL_MODES.auto];
  return [...fallbackOrder];
}

function getProofreadThinkingProfile(mode) {
  if (mode === GEMINI_MODEL_MODES.autoSpeed) {
    return GEMINI_THINKING_PROFILES.fastest;
  }
  if (mode === GEMINI_MODEL_MODES.autoQuality) {
    return GEMINI_THINKING_PROFILES.highest;
  }

  return GEMINI_THINKING_PROFILES.standard;
}

function getProofreadModelConfigKey(modelName) {
  const normalizedModelName = typeof modelName === 'string' ? modelName.trim() : '';
  if (GEMINI_PROOFREAD_MODEL_CONFIGS[normalizedModelName]) {
    return normalizedModelName;
  }

  const withoutVersionSuffix = normalizedModelName.replace(/-\d{3,}$/i, '');
  if (GEMINI_PROOFREAD_MODEL_CONFIGS[withoutVersionSuffix]) {
    return withoutVersionSuffix;
  }

  return normalizedModelName;
}

function getGemini3ThinkingLevel(modelName, thinkingProfile) {
  const isProModel = modelName.includes('-pro');
  if (thinkingProfile === GEMINI_THINKING_PROFILES.highest) {
    return 'HIGH';
  }
  if (thinkingProfile === GEMINI_THINKING_PROFILES.fastest) {
    return isProModel ? 'LOW' : 'MINIMAL';
  }
  if (isProModel) {
    return null;
  }

  return 'MEDIUM';
}

function getProofreadThinkingConfig(modelName, thinkingProfile) {
  const modelKey = getProofreadModelConfigKey(modelName);
  if (modelKey.startsWith('gemini-3')) {
    const thinkingLevel = getGemini3ThinkingLevel(modelKey, thinkingProfile);
    if (!thinkingLevel) {
      return null;
    }

    return {
      thinkingLevel,
    };
  }

  const gemini25Budget = GEMINI_25_THINKING_BUDGETS[modelKey]?.[thinkingProfile];
  if (Number.isFinite(gemini25Budget)) {
    return {
      thinkingBudget: gemini25Budget,
    };
  }

  return null;
}

function buildProofreadPrompt(originalText, promptContext, strategy) {
  const lines = [
    '以下は提出前の学生の文章です。文章校正だけを行ってください。',
    '厳守事項:',
    '- 誤字、脱字、文法、句読点、不自然な言い回しだけを必要最小限で直すこと。',
    '- 元の意味、主張、文量、改行、言語をできるだけ維持すること。',
    '- 設問に対する新しい内容、補足、例、説明、見出し、箇条書き、前置き、後書き、引用符を追加しないこと。',
    '- 文章が短すぎたり不完全でも、勝手に内容を補完せず、校正だけを行うこと。',
    '- 返す内容は実際に提出欄へそのまま入れられる文章のみとすること。',
  ];

  if (strategy === 'plain_text') {
    lines.push('- 出力は必ず <final>校正後の本文</final> の形式 1 個だけにすること。<final> の外には何も書かないこと。');
    lines.push('- JSON、コードブロック、見出し、注釈、ラベル、引用符だけの装飾、思考過程、自己確認、箇条書きを書かないこと。');
  } else {
    lines.push('- correctedText に入る本文以外の情報を混ぜないこと。');
  }

  lines.push(
    '',
    '設問コンテキスト:',
    promptContext || 'なし',
    '',
    '提出文:',
    originalText,
  );

  return lines.join('\n');
}

function extractGeminiText(responseJson) {
  const candidate = responseJson?.candidates?.[0] || null;
  if (!candidate) {
    const blockReason = responseJson?.promptFeedback?.blockReason || '';
    throw createProofreadError(
      blockReason ? `Geminiによりブロックされました: ${blockReason}` : 'Geminiの応答が空でした',
      blockReason || 'EMPTY_RESPONSE'
    );
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    throw createProofreadError('Geminiの応答が途中で打ち切られました', 'MAX_TOKENS');
  }

  if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'MALFORMED_RESPONSE'].includes(candidate.finishReason)) {
    throw createProofreadError(
      `Geminiの応答を利用できません: ${candidate.finishReason}`,
      candidate.finishReason
    );
  }

  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  if (!text) {
    throw createProofreadError('Geminiの応答本文を取得できませんでした', 'EMPTY_RESPONSE_TEXT');
  }

  return text;
}

function unwrapCodeFence(text) {
  const trimmed = (text || '').trim();
  const match = trimmed.match(/^```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : trimmed;
}

function stripProofreadControlMarkup(text) {
  return String(text || '')
    .replace(/<\|think\|>/gi, '')
    .replace(/<\|channel\|>thought\s*[\s\S]*?<channel\|>/gi, '')
    .replace(/<\|channel\|>analysis\s*[\s\S]*?<channel\|>/gi, '')
    .trim();
}

function extractTaggedProofreadText(text) {
  const match = String(text || '').match(/<final>\s*([\s\S]*?)\s*<\/final>/i);
  return match?.[1]?.trim() || '';
}

function isProofreadMetaLine(line) {
  const trimmedLine = String(line || '').trim();
  if (!trimmedLine) return false;

  if (/^[*\-]\s+/.test(trimmedLine)) return true;
  if (/^\d+\.\s+/.test(trimmedLine)) return true;
  if (/^["'“].+["'”]\s*->\s*["'“].+["'”]$/.test(trimmedLine)) return true;
  if (/^(Role|Task|Constraints|Context|Question|Student'?s text|Corrected|Punctuation|Wait|No extra text|Thought|Reasoning)\s*:/i.test(trimmedLine)) {
    return true;
  }

  return false;
}

function extractNonMetaBlockText(text) {
  const keptLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isProofreadMetaLine(line));

  return keptLines.join('\n').trim();
}

function hasJapaneseText(text) {
  return /[\u3040-\u30ff\u4e00-\u9faf]/.test(String(text || ''));
}

function scoreProofreadCandidate(candidateText, originalText) {
  const candidate = String(candidateText || '').trim();
  const original = String(originalText || '').trim();
  if (!candidate) return Number.NEGATIVE_INFINITY;

  let score = candidate.length;

  if (original) {
    score -= Math.abs(candidate.length - original.length) * 0.35;
    if (hasJapaneseText(candidate) === hasJapaneseText(original)) {
      score += 18;
    }
  }

  if (/^(Role|Task|Constraints|Context|Question|Student|Corrected)\s*:/im.test(candidate)) {
    score -= 500;
  }
  if (/^[*\-]\s+/m.test(candidate)) {
    score -= 300;
  }

  return score;
}

function removeRepeatedSentenceBlocks(text) {
  const sentences = String(text || '')
    .match(/[^。！？!?\n]+[。！？!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];

  if (sentences.length >= 2 && sentences.length % 2 === 0) {
    const half = sentences.length / 2;
    const firstHalf = sentences.slice(0, half).join('');
    const secondHalf = sentences.slice(half).join('');
    if (firstHalf && firstHalf === secondHalf) {
      return firstHalf.trim();
    }
  }

  return String(text || '').trim();
}

function removeRepeatedWholeText(text) {
  const trimmedText = String(text || '').trim();
  if (!trimmedText) return '';

  const compactText = trimmedText.replace(/\s+/g, '');
  if (compactText.length % 2 !== 0) {
    return trimmedText;
  }

  const compactHalfLength = compactText.length / 2;
  const compactFirstHalf = compactText.slice(0, compactHalfLength);
  const compactSecondHalf = compactText.slice(compactHalfLength);
  if (compactFirstHalf !== compactSecondHalf) {
    return trimmedText;
  }

  const paragraphs = trimmedText.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length >= 2 && paragraphs.length % 2 === 0) {
    const half = paragraphs.length / 2;
    const firstHalf = paragraphs.slice(0, half).join('\n\n');
    const secondHalf = paragraphs.slice(half).join('\n\n');
    if (firstHalf && firstHalf === secondHalf) {
      return firstHalf.trim();
    }
  }

  return removeRepeatedSentenceBlocks(trimmedText);
}

function sanitizePlainTextProofreadResponse(responseText, originalText) {
  const strippedText = stripProofreadControlMarkup(unwrapCodeFence(responseText));
  const taggedText = extractTaggedProofreadText(strippedText);
  const preferredText = taggedText || strippedText;

  const rawBlocks = preferredText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const candidateBlocks = rawBlocks
    .map((block) => extractNonMetaBlockText(block))
    .filter(Boolean);

  const fallbackCandidate = extractNonMetaBlockText(preferredText) || preferredText.trim();
  const candidates = candidateBlocks.length ? candidateBlocks : [fallbackCandidate];
  const bestCandidate = candidates
    .slice()
    .sort((left, right) => scoreProofreadCandidate(right, originalText) - scoreProofreadCandidate(left, originalText))[0];

  return removeRepeatedWholeText(bestCandidate);
}

function parseStructuredProofreadText(responseText) {
  let parsed;

  try {
    parsed = JSON.parse(responseText);
  } catch (_) {
    throw createProofreadError('Geminiの校正結果をJSONとして解釈できませんでした', 'INVALID_JSON_RESPONSE');
  }

  const correctedText = typeof parsed?.correctedText === 'string'
    ? parsed.correctedText.trim()
    : '';

  if (!correctedText) {
    throw createProofreadError('Geminiの校正結果が空でした', 'EMPTY_CORRECTED_TEXT');
  }

  return correctedText;
}

function parsePlainTextProofreadText(responseText, originalText) {
  const trimmedText = sanitizePlainTextProofreadResponse(responseText, originalText);
  if (!trimmedText) {
    throw createProofreadError('Geminiの校正結果が空でした', 'EMPTY_CORRECTED_TEXT');
  }

  try {
    const parsed = JSON.parse(trimmedText);
    if (typeof parsed === 'string' && parsed.trim()) {
      return parsed.trim();
    }
    if (typeof parsed?.correctedText === 'string' && parsed.correctedText.trim()) {
      return parsed.correctedText.trim();
    }
  } catch (_) {
    // Plain text response expected.
  }

  return trimmedText;
}

function buildProofreadRequestBody({ modelName, strategy, originalText, promptContext, thinkingProfile, disableThinkingConfig = false }) {
  const modelConfig = getProofreadModelConfig(getProofreadModelConfigKey(modelName));
  const generationConfig = {
    candidateCount: 1,
    maxOutputTokens: getProofreadMaxOutputTokens(originalText),
  };
  const thinkingConfig = disableThinkingConfig ? null : getProofreadThinkingConfig(modelName, thinkingProfile);

  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  if (!modelConfig.preserveDefaultTemperature) {
    generationConfig.temperature = 0;
  }

  if (strategy === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = PROOFREAD_RESPONSE_JSON_SCHEMA;
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: buildProofreadPrompt(originalText, promptContext, strategy),
          },
        ],
      },
    ],
    generationConfig,
  };

  if (modelConfig.supportsSystemInstruction) {
    requestBody.systemInstruction = {
      parts: [
        {
          text: PROOFREAD_SYSTEM_INSTRUCTION,
        },
      ],
    };
  }

  return requestBody;
}

function buildProofreadModelProbeRequestBody({ modelName, thinkingProfile, disableThinkingConfig = false }) {
  const generationConfig = {
    candidateCount: 1,
    maxOutputTokens: 16,
    temperature: 0,
  };
  const thinkingConfig = disableThinkingConfig ? null : getProofreadThinkingConfig(modelName, thinkingProfile);

  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: '接続確認です。OK とだけ返してください。',
          },
        ],
      },
    ],
    generationConfig,
  };
}

function isInvalidApiKeyError(error) {
  return /api[_\s-]*key|key not valid|invalid key|API_KEY_INVALID/i.test(error?.message || '');
}

function isAuthOrPermissionError(error) {
  if (error?.status === 401 || error?.status === 403) return true;
  if (['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(error?.apiStatus)) return true;
  return isInvalidApiKeyError(error);
}

function isSafetyStopError(error) {
  return ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(error?.code);
}

function isThinkingConfigError(error) {
  if (error?.status !== 400) return false;
  return /thinkingConfig|thinking config|thinkingLevel|thinkingBudget|thinking/i.test(error?.message || '');
}

function shouldRetryWithoutThinkingConfig(error, hadThinkingConfig) {
  return hadThinkingConfig && isThinkingConfigError(error);
}

async function sendProofreadGenerateContentRequest({ apiKey, modelName, strategy, originalText, promptContext, thinkingProfile, disableThinkingConfig = false }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  try {
    const requestBody = buildProofreadRequestBody({
      modelName,
      strategy,
      originalText,
      promptContext,
      thinkingProfile,
      disableThinkingConfig,
    });

    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      }
    );

    const responseJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiMessage = responseJson?.error?.message || `Gemini API error (${response.status})`;
      throw createProofreadError(apiMessage, `HTTP_${response.status}`, {
        status: response.status,
        apiStatus: responseJson?.error?.status || '',
        modelName,
        strategy,
        hadThinkingConfig: Boolean(requestBody.generationConfig?.thinkingConfig),
      });
    }

    const responseText = extractGeminiText(responseJson);
    const correctedText = strategy === 'json_schema'
      ? parseStructuredProofreadText(responseText)
      : parsePlainTextProofreadText(responseText, originalText);

    return { correctedText, strategy };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createProofreadError('Gemini APIの応答がタイムアウトしました', 'TIMEOUT', {
        modelName,
        strategy,
      });
    }

    if (!error?.code) {
      throw createProofreadError(error?.message || 'AI校正に失敗しました', 'REQUEST_FAILED', {
        modelName,
        strategy,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestProofreadFromModel({ apiKey, modelName, strategy, originalText, promptContext, thinkingProfile }) {
  let disableThinkingConfig = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sendProofreadGenerateContentRequest({
        apiKey,
        modelName,
        strategy,
        originalText,
        promptContext,
        thinkingProfile,
        disableThinkingConfig,
      });
    } catch (error) {
      if (!shouldRetryWithoutThinkingConfig(error, error?.hadThinkingConfig)) {
        throw error;
      }

      disableThinkingConfig = true;
      console.warn('[ZenstudyTool BG] Retrying proofreading without thinkingConfig', {
        modelName,
        strategy,
        reason: error.message,
      });
    }
  }

  return sendProofreadGenerateContentRequest({
    apiKey,
    modelName,
    strategy,
    originalText,
    promptContext,
    thinkingProfile,
    disableThinkingConfig: true,
  });
}

async function sendProofreadModelProbeRequest({ apiKey, modelName, thinkingProfile, disableThinkingConfig = false }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_MODEL_PROBE_TIMEOUT_MS);

  try {
    const requestBody = buildProofreadModelProbeRequestBody({
      modelName,
      thinkingProfile,
      disableThinkingConfig,
    });
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      }
    );
    const responseJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiMessage = responseJson?.error?.message || `Gemini API error (${response.status})`;
      throw createProofreadError(apiMessage, `HTTP_${response.status}`, {
        status: response.status,
        apiStatus: responseJson?.error?.status || '',
        modelName,
        hadThinkingConfig: Boolean(requestBody.generationConfig?.thinkingConfig),
      });
    }

    if (!responseJson?.candidates?.[0]) {
      throw createProofreadError('Geminiの応答が空でした', 'EMPTY_RESPONSE', {
        modelName,
      });
    }

    return true;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createProofreadError('Gemini APIの接続確認がタイムアウトしました', 'TIMEOUT', {
        modelName,
      });
    }

    if (!error?.code) {
      throw createProofreadError(error?.message || 'モデル接続テストに失敗しました', 'REQUEST_FAILED', {
        modelName,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeProofreadModel({ apiKey, modelName, resolvedModel, thinkingProfile }) {
  let disableThinkingConfig = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendProofreadModelProbeRequest({
        apiKey,
        modelName: resolvedModel,
        thinkingProfile,
        disableThinkingConfig,
      });
      return {
        modelName,
        resolvedModel,
        available: true,
        tested: true,
        message: '',
      };
    } catch (error) {
      if (shouldRetryWithoutThinkingConfig(error, error?.hadThinkingConfig)) {
        disableThinkingConfig = true;
        continue;
      }

      return {
        modelName,
        resolvedModel,
        available: false,
        tested: true,
        message: error.message || '利用できません',
        code: error.code || '',
        status: error.status || 0,
      };
    }
  }

  return {
    modelName,
    resolvedModel,
    available: false,
    tested: true,
    message: 'thinkingConfig なしの接続確認にも失敗しました',
    code: 'PROBE_FAILED',
    status: 0,
  };
}

function shouldRetryPlainTextStrategy(error, strategy) {
  if (strategy !== 'json_schema') return false;
  if (isAuthOrPermissionError(error) || isSafetyStopError(error)) return false;

  if (error?.status === 400) return true;

  return ['INVALID_JSON_RESPONSE', 'EMPTY_CORRECTED_TEXT', 'MALFORMED_RESPONSE'].includes(error?.code);
}

function shouldTryNextProofreadModel(error) {
  if (['EMPTY_TEXT', 'MISSING_API_KEY', 'MODEL_NOT_AVAILABLE'].includes(error?.code)) return false;
  if (isAuthOrPermissionError(error) || isSafetyStopError(error)) return false;
  if (error?.status === 400) return false;
  return true;
}

function buildProofreadFailureMessage(mode, attempts) {
  if (!attempts.length) return 'AI校正に失敗しました';

  const lastAttempt = attempts[attempts.length - 1];
  if (mode === GEMINI_MODEL_MODES.manual) {
    return `${lastAttempt.modelName} でAI校正に失敗しました（${lastAttempt.message}）`;
  }

  const triedModels = attempts.map((attempt) => attempt.modelName).join(' → ');
  return `自動モデル選択でAI校正に失敗しました（試行: ${triedModels} / 最後のエラー: ${lastAttempt.message}）`;
}

async function proofreadWithGemini({ originalText, promptContext }) {
  const trimmedOriginalText = typeof originalText === 'string' ? originalText.trim() : '';
  if (!trimmedOriginalText) {
    throw createProofreadError('校正対象の文章が空です', 'EMPTY_TEXT');
  }

  const {
    [STORAGE_KEYS.geminiApiKey]: geminiApiKey = '',
    [STORAGE_KEYS.geminiModelMode]: geminiModelMode = GEMINI_MODEL_MODES.auto,
    [STORAGE_KEYS.geminiSelectedModel]: geminiSelectedModel = DEFAULT_GEMINI_PROOFREAD_MODEL,
  } = await getLocalStorage({
    [STORAGE_KEYS.geminiApiKey]: '',
    [STORAGE_KEYS.geminiModelMode]: GEMINI_MODEL_MODES.auto,
    [STORAGE_KEYS.geminiSelectedModel]: DEFAULT_GEMINI_PROOFREAD_MODEL,
  });
  const apiKey = geminiApiKey.trim();
  if (!apiKey) {
    throw createProofreadError('Gemini APIキーが未設定です。ポップアップから設定してください。', 'MISSING_API_KEY');
  }

  const mode = normalizeProofreadModelMode(geminiModelMode);
  const selectedModel = normalizeProofreadModelName(geminiSelectedModel);
  const modelCandidates = getProofreadModelCandidates(mode, selectedModel);
  const thinkingProfile = getProofreadThinkingProfile(mode);
  const attempts = [];

  for (const modelName of modelCandidates) {
    const requestModelName = await resolveProofreadRequestModelName(apiKey, modelName);
    if (!requestModelName) {
      const message = `${modelName} に対応するGemini APIの利用可能モデルが ListModels に見つかりませんでした`;
      attempts.push({
        modelName,
        message,
      });

      if (mode === GEMINI_MODEL_MODES.manual) {
        throw createProofreadError(message, 'MODEL_NOT_AVAILABLE', { modelName });
      }

      console.warn('[ZenstudyTool BG] Skipping unresolved proofread model', {
        modelName,
      });
      continue;
    }

    const modelConfig = getProofreadModelConfig(modelName);
    const strategies = modelConfig.supportsStructuredOutput
      ? ['json_schema', 'plain_text']
      : ['plain_text'];

    for (const strategy of strategies) {
      try {
        const result = await requestProofreadFromModel({
          apiKey,
          modelName: requestModelName,
          strategy,
          originalText: trimmedOriginalText,
          promptContext,
          thinkingProfile,
        });

        return {
          correctedText: result.correctedText,
          model: modelName,
          resolvedModel: requestModelName,
          strategy: result.strategy,
        };
      } catch (error) {
        if (shouldRetryPlainTextStrategy(error, strategy)) {
          console.warn('[ZenstudyTool BG] Retrying proofreading with plain text mode', {
            modelName,
            requestModelName,
            reason: error.message,
          });
          continue;
        }

        attempts.push({
          modelName,
          message: error.message || '不明なエラー',
        });

        console.warn('[ZenstudyTool BG] Proofread attempt failed', {
          modelName,
          requestModelName,
          strategy,
          error: error.message,
        });

        if (!shouldTryNextProofreadModel(error)) {
          throw error;
        }

        break;
      }
    }
  }

  throw createProofreadError(
    buildProofreadFailureMessage(mode, attempts),
    'ALL_MODELS_FAILED',
    { attempts }
  );
}

async function testProofreadModelsAvailability() {
  const {
    [STORAGE_KEYS.geminiApiKey]: geminiApiKey = '',
    [STORAGE_KEYS.geminiModelMode]: geminiModelMode = GEMINI_MODEL_MODES.auto,
    [STORAGE_KEYS.geminiSelectedModel]: geminiSelectedModel = DEFAULT_GEMINI_PROOFREAD_MODEL,
  } = await getLocalStorage({
    [STORAGE_KEYS.geminiApiKey]: '',
    [STORAGE_KEYS.geminiModelMode]: GEMINI_MODEL_MODES.auto,
    [STORAGE_KEYS.geminiSelectedModel]: DEFAULT_GEMINI_PROOFREAD_MODEL,
  });
  const apiKey = geminiApiKey.trim();
  if (!apiKey) {
    throw createProofreadError('Gemini APIキーが未設定です。ポップアップから設定してください。', 'MISSING_API_KEY');
  }

  const mode = normalizeProofreadModelMode(geminiModelMode);
  const selectedModel = normalizeProofreadModelName(geminiSelectedModel);
  const modelCandidates = getProofreadModelCandidates(mode, selectedModel);
  const thinkingProfile = getProofreadThinkingProfile(mode);
  const availableModels = await listGenerateContentModels(apiKey);
  const listedResults = modelCandidates.map((modelName) => {
    const resolvedModel = findAvailableProofreadModel(availableModels, modelName);
    return {
      modelName,
      resolvedModel,
      listed: Boolean(resolvedModel),
      available: false,
      tested: false,
      message: resolvedModel ? '' : 'ListModels に見つかりません',
    };
  });
  const results = [];

  for (const listedResult of listedResults) {
    if (!listedResult.resolvedModel) {
      results.push(listedResult);
      continue;
    }

    const probeResult = await probeProofreadModel({
      apiKey,
      modelName: listedResult.modelName,
      resolvedModel: listedResult.resolvedModel,
      thinkingProfile,
    });
    results.push({
      ...listedResult,
      ...probeResult,
    });

    if (probeResult.available && mode !== GEMINI_MODEL_MODES.manual) {
      break;
    }
  }

  if (mode !== GEMINI_MODEL_MODES.manual && results.length < listedResults.length) {
    results.push(
      ...listedResults.slice(results.length).map((result) => ({
        ...result,
        message: '上位候補が応答できたため未確認',
      }))
    );
  }

  return {
    mode,
    selectedModel,
    results,
  };
}

async function trackBrowserDownload({ url, filename, sourceTabId, requestId, outputType, blobUrl = null }) {
  sendConversionProgress({
    type: MESSAGE_TYPES.conversionProgress,
    phase: 'save',
    current: 0,
    total: 0,
    requestId,
    outputType,
  }, sourceTabId);

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: 'overwrite',
  });

  const tracked = {
    requestId,
    sourceTabId,
    outputType,
    blobUrl,
    bytesReceived: 0,
    totalBytes: 0,
    lastSentAt: 0,
    lastSentPercentage: -1,
  };

  trackedDownloads.set(downloadId, tracked);

  try {
    const [downloadItem] = await chrome.downloads.search({ id: downloadId });
    if (downloadItem) {
      tracked.bytesReceived = downloadItem.bytesReceived || 0;
      tracked.totalBytes = downloadItem.totalBytes || 0;

      if (downloadItem.state === 'complete') {
        sendTrackedDownloadProgress(tracked, true);
        sendConversionProgress({
          type: MESSAGE_TYPES.conversionProgress,
          phase: 'done',
          success: true,
          requestId,
          outputType,
        }, sourceTabId);
        cleanupTrackedDownload(downloadId);
        return downloadId;
      }

      if (downloadItem.state === 'interrupted') {
        sendConversionProgress({
          type: MESSAGE_TYPES.conversionProgress,
          phase: 'error',
          success: false,
          requestId,
          error: downloadItem.error || 'ダウンロードが中断されました',
        }, sourceTabId);
        cleanupTrackedDownload(downloadId);
        return downloadId;
      }
    }
  } catch (err) {
    console.warn('[ZenstudyTool BG] ダウンロード状態の取得に失敗:', err);
  }

  sendTrackedDownloadProgress(tracked, true);
  return downloadId;
}

chrome.downloads.onChanged.addListener((delta) => {
  const tracked = trackedDownloads.get(delta.id);
  if (!tracked) return;

  if (delta.totalBytes && typeof delta.totalBytes.current === 'number') {
    tracked.totalBytes = delta.totalBytes.current;
  }

  if (delta.bytesReceived && typeof delta.bytesReceived.current === 'number') {
    tracked.bytesReceived = delta.bytesReceived.current;
  }

  if (delta.state?.current === 'complete') {
    if (tracked.totalBytes > 0) {
      tracked.bytesReceived = tracked.totalBytes;
    }
    sendTrackedDownloadProgress(tracked, true);
    sendConversionProgress({
      type: MESSAGE_TYPES.conversionProgress,
      phase: 'done',
      success: true,
      requestId: tracked.requestId,
      outputType: tracked.outputType,
    }, tracked.sourceTabId);
    cleanupTrackedDownload(delta.id);
    return;
  }

  if (delta.state?.current === 'interrupted' || delta.error?.current) {
    sendConversionProgress({
      type: MESSAGE_TYPES.conversionProgress,
      phase: 'error',
      success: false,
      requestId: tracked.requestId,
      error: delta.error?.current || 'ダウンロードが中断されました',
    }, tracked.sourceTabId);
    cleanupTrackedDownload(delta.id);
    return;
  }

  if (delta.bytesReceived || delta.totalBytes || delta.state?.current === 'in_progress') {
    sendTrackedDownloadProgress(tracked);
  }
});

// ============================================================
// ネットワーク傍受: .m3u8 / .mp4 URL を検出
// ============================================================

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (!url) return;

    // .m3u8 または .mp4 を含むURLを検出（クエリパラメータも考慮）
    const isM3U8 = /\.m3u8(\?|$)/i.test(url);
    const isMP4 = /\.mp4(\?|$)/i.test(url);

    if (!isM3U8 && !isMP4) return;

    const tabId = details.tabId;
    if (tabId < 0) return; // タブに紐づかないリクエストは無視

    const videoInfo = {
      url: url,
      type: isMP4 ? 'mp4' : 'm3u8',
      timestamp: Date.now(),
    };

    tabVideoUrls.set(tabId, videoInfo);

    // content.js に通知
    chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.videoUrlDetected,
      videoInfo: videoInfo,
    }).catch(() => {
      // content script がまだロードされていない場合は無視
    });
  },
  { urls: VIDEO_REQUEST_URL_PATTERNS },
  []
);

// ============================================================
// メッセージハンドラ
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.getVideoUrl) {
    // content.js から現在のタブの動画URLを問い合わせ
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const info = tabVideoUrls.get(tabId);
      sendResponse({ videoInfo: info || null });
    } else {
      sendResponse({ videoInfo: null });
    }
    return false;
  }

  if (message.type === MESSAGE_TYPES.downloadVideo) {
    // ダウンロードリクエスト
    handleDownload(message, sender.tab?.id).then(sendResponse);
    return true; // 非同期レスポンス
  }

  if (message.type === MESSAGE_TYPES.downloadSlideImages) {
    downloadSlideImages(message, sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE_TYPES.proofreadText) {
    proofreadWithGemini(message)
      .then(({ correctedText, model, resolvedModel, strategy }) => {
        sendResponse({ success: true, correctedText, model, resolvedModel, strategy });
      })
      .catch((error) => {
        console.error('[ZenstudyTool BG] Proofread error:', error);
        sendResponse({
          success: false,
          message: error.message || 'AI校正に失敗しました',
          code: error.code || '',
          status: error.status || 0,
        });
      });
    return true;
  }

  if (message.type === MESSAGE_TYPES.testProofreadModels) {
    testProofreadModelsAvailability()
      .then((result) => {
        sendResponse({ success: true, ...result });
      })
      .catch((error) => {
        console.error('[ZenstudyTool BG] Proofread model test error:', error);
        sendResponse({ success: false, message: error.message || 'モデル接続テストに失敗しました' });
      });
    return true;
  }

  return false;
});

// タブが閉じられたらクリーンアップ
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideoUrls.delete(tabId);
});

// ============================================================
// ダウンロード処理
// ============================================================

async function handleDownload({ videoInfo, title, sectionTitle }, sourceTabId) {
  try {
    const normalizedVideo = normalizeVideoInfo(videoInfo);
    if (!normalizedVideo) {
      return { success: false, message: '動画URLを取得できませんでした。動画を再生してから、もう一度お試しください。' };
    }

    const requestId = createRequestId();

    if (normalizedVideo.type === 'mp4') {
      // Raw MP4 downloads can lose our target filename during Chrome filename determination.
      return await processDirectMP4Download(normalizedVideo.url, title, sectionTitle, sourceTabId, requestId);
    }

    // M3U8: offscreen document で処理（可能なら MP4、難しい場合は TS）
    return await processM3U8Download(normalizedVideo.url, title, sectionTitle, sourceTabId, requestId);
  } catch (err) {
    console.error('[ZenstudyTool BG] ダウンロードエラー:', err);
    return { success: false, message: err.message };
  }
}

async function downloadSlideImages({ images, title, sectionTitle }, sourceTabId) {
  const normalizedImages = normalizeSlideImageEntries(images);
  if (normalizedImages.length === 0) {
    return { success: false, message: '保存できるスライド画像が見つかりませんでした。' };
  }

  const requestId = createRequestId();
  const baseDirectory = buildDownloadDirectory({
    title,
    sectionTitle,
    suffix: 'slides',
  });

  try {
    sendConversionProgress({
      type: MESSAGE_TYPES.slideDownloadProgress,
      phase: 'prepare',
      current: 0,
      total: normalizedImages.length,
      requestId,
    }, sourceTabId);

    for (let index = 0; index < normalizedImages.length; index += 1) {
      const image = normalizedImages[index];
      const fallbackStem = `slide_${String(index + 1).padStart(3, '0')}`;
      const fileStem = normalizeDownloadPathSegment(image.fileStem, fallbackStem) || fallbackStem;
      const extension = getDownloadExtensionFromUrl(image.url, 'jpg');

      await chrome.downloads.download({
        url: image.url,
        filename: `${baseDirectory}/${fileStem}.${extension}`,
        saveAs: false,
        conflictAction: 'overwrite',
      });

      sendConversionProgress({
        type: MESSAGE_TYPES.slideDownloadProgress,
        phase: 'queue',
        current: index + 1,
        total: normalizedImages.length,
        requestId,
      }, sourceTabId);
    }

    sendConversionProgress({
      type: MESSAGE_TYPES.slideDownloadProgress,
      phase: 'done',
      success: true,
      current: normalizedImages.length,
      total: normalizedImages.length,
      requestId,
    }, sourceTabId);

    return {
      success: true,
      count: normalizedImages.length,
      requestId,
      message: `${normalizedImages.length}件のスライド保存を開始しました`,
    };
  } catch (error) {
    sendConversionProgress({
      type: MESSAGE_TYPES.slideDownloadProgress,
      phase: 'error',
      success: false,
      requestId,
      error: error.message || 'スライド保存に失敗しました',
    }, sourceTabId);

    return {
      success: false,
      requestId,
      message: error.message || 'スライド保存に失敗しました',
    };
  }
}

// ============================================================
// M3U8 ダウンロード処理 (Offscreen Document 経由)
// ============================================================

let offscreenCreated = false;

async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  try {
    // 既存のoffscreenがないか確認
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) {
      offscreenCreated = true;
      return;
    }
  } catch (e) {
    // getContexts が使えない古いChromeバージョン
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'M3U8 動画のチャンクをバックグラウンドでダウンロード・結合するため',
  });
  offscreenCreated = true;
}

function broadcastToStudyTabs(message) {
  chrome.tabs.query({ url: '*://*.nnn.ed.nico/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function sendConversionProgress(message, sourceTabId) {
  if (typeof sourceTabId === 'number' && sourceTabId >= 0) {
    chrome.tabs.sendMessage(sourceTabId, message).catch(() => {});
    return;
  }
  // 送信元タブを特定できない場合のみブロードキャスト
  broadcastToStudyTabs(message);
}

async function processOffscreenDownload(requestMessage, title, sectionTitle, sourceTabId, requestId) {
  await ensureOffscreenDocument();

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(listener);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      sendConversionProgress({
        type: MESSAGE_TYPES.conversionProgress,
        phase: 'error',
        success: false,
        requestId,
        error: '変換がタイムアウトしました',
      }, sourceTabId);
      finish({ success: false, message: '変換がタイムアウトしました' });
    }, CONVERSION_TIMEOUT_MS);

    // offscreen からの完了通知を待つリスナー
    const listener = (message) => {
      if (message.requestId !== requestId) return;

      if (message.type === MESSAGE_TYPES.conversionComplete) {
        if (message.success) {
          const outputType = message.outputType === 'mp4' ? 'mp4' : 'ts';
          const blobUrl = message.blobUrl;

          // Blob URL からダウンロード
          const filename = buildDownloadFilename({
            title,
            sectionTitle,
            extension: outputType,
          });

          trackBrowserDownload({
            url: blobUrl,
            filename,
            sourceTabId,
            requestId,
            outputType,
            blobUrl,
          }).then(() => {
            finish({ success: true, message: `${outputType.toUpperCase()}ダウンロード開始`, requestId });
          }).catch((err) => {
            sendConversionProgress({
              type: MESSAGE_TYPES.conversionProgress,
              phase: 'error',
              success: false,
              requestId,
              error: err.message,
            }, sourceTabId);
            requestBlobRevoke(requestId, blobUrl);
            finish({ success: false, message: `ダウンロードエラー: ${err.message}` });
          });
        } else {
          sendConversionProgress({
            type: MESSAGE_TYPES.conversionProgress,
            phase: 'error',
            success: false,
            requestId,
            error: message.error,
          }, sourceTabId);
          finish({ success: false, message: message.error });
        }
      }

      if (message.type === MESSAGE_TYPES.conversionProgress) {
        // 進捗は要求元タブに転送
        sendConversionProgress(message, sourceTabId);
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    // offscreen に変換リクエストを送信
    chrome.runtime.sendMessage({
      ...requestMessage,
      requestId,
    }).catch((err) => {
      sendConversionProgress({
        type: MESSAGE_TYPES.conversionProgress,
        phase: 'error',
        success: false,
        requestId,
        error: err.message,
      }, sourceTabId);
      finish({ success: false, message: `変換開始エラー: ${err.message}` });
    });
  });
}

function processM3U8Download(m3u8Url, title, sectionTitle, sourceTabId, requestId) {
  return processOffscreenDownload({
    type: MESSAGE_TYPES.convertM3u8,
    m3u8Url,
  }, title, sectionTitle, sourceTabId, requestId);
}

function processDirectMP4Download(mp4Url, title, sectionTitle, sourceTabId, requestId) {
  return processOffscreenDownload({
    type: MESSAGE_TYPES.prepareDirectMp4,
    mp4Url,
  }, title, sectionTitle, sourceTabId, requestId);
}
