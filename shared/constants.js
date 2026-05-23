(() => {
  const STORAGE_KEYS = Object.freeze({
    forceEssentialEnabled: "forceEssentialEnabled",
    showTotalTime: "showTotalTime",
    showDailyTarget: "showDailyTarget",
    autoSkipEnabled: "autoSkipEnabled",
    alwaysFocusEnabled: "alwaysFocusEnabled",
    copyTextEnabled: "copyTextEnabled",
    downloadEnabled: "downloadEnabled",
    slideDownloadEnabled: "slideDownloadEnabled",
    proofreadEnabled: "proofreadEnabled",
    geminiApiKey: "geminiApiKey",
    geminiModelMode: "geminiModelMode",
    geminiSelectedModel: "geminiSelectedModel",
  });

  const GEMINI_MODEL_MODES = Object.freeze({
    auto: "auto",
    autoSpeed: "autoSpeed",
    autoQuality: "autoQuality",
    manual: "manual",
  });

  const GEMINI_MODEL_MANUAL_OPTIONS = Object.freeze([
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
  ]);

  const GEMINI_MODEL_FALLBACK_ORDERS = Object.freeze({
    [GEMINI_MODEL_MODES.auto]: Object.freeze([
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
    ]),
    [GEMINI_MODEL_MODES.autoSpeed]: Object.freeze([
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
    ]),
    [GEMINI_MODEL_MODES.autoQuality]: Object.freeze([
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemma-4-31b-it",
      "gemini-3.1-flash-lite",
      "gemma-4-26b-a4b-it",
      "gemini-2.5-flash-lite",
    ]),
  });

  const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
  const GEMINI_MODEL_FALLBACK_ORDER = GEMINI_MODEL_FALLBACK_ORDERS[GEMINI_MODEL_MODES.auto];

  const MESSAGE_TYPES = Object.freeze({
    videoUrlDetected: "ZST_VIDEO_URL_DETECTED",
    getVideoUrl: "ZST_GET_VIDEO_URL",
    downloadVideo: "ZST_DOWNLOAD_VIDEO",
    downloadSlideImages: "ZST_DOWNLOAD_SLIDE_IMAGES",
    proofreadText: "ZST_PROOFREAD_TEXT",
    testProofreadModels: "ZST_TEST_PROOFREAD_MODELS",
    conversionProgress: "ZST_CONVERSION_PROGRESS",
    conversionComplete: "ZST_CONVERSION_COMPLETE",
    convertM3u8: "ZST_CONVERT_M3U8",
    prepareDirectMp4: "ZST_PREPARE_DIRECT_MP4",
    revokeBlobUrl: "ZST_REVOKE_BLOB_URL",
    slideDownloadProgress: "ZST_SLIDE_DOWNLOAD_PROGRESS",
  });

  globalThis.ZenstudyToolConstants = Object.freeze({
    STORAGE_KEYS,
    GEMINI_MODEL_MODES,
    GEMINI_MODEL_MANUAL_OPTIONS,
    GEMINI_MODEL_FALLBACK_ORDERS,
    GEMINI_MODEL_FALLBACK_ORDER,
    DEFAULT_GEMINI_MODEL,
    MESSAGE_TYPES,
  });
})();
