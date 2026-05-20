const {
  STORAGE_KEYS,
  GEMINI_MODEL_MODES,
  GEMINI_MODEL_MANUAL_OPTIONS,
  DEFAULT_GEMINI_MODEL,
} = globalThis.ZenstudyToolConstants;

document.addEventListener('DOMContentLoaded', () => {
  const toggleFilter = document.getElementById('toggleFilter');
  const toggleTime = document.getElementById('toggleTime');
  const toggleDailyTarget = document.getElementById('toggleDailyTarget');
  const toggleAutoSkip = document.getElementById('toggleAutoSkip');
  const toggleAlwaysFocus = document.getElementById('toggleAlwaysFocus');
  const toggleCopyText = document.getElementById('toggleCopyText');
  const toggleDownload = document.getElementById('toggleDownload');
  const toggleSlideDownload = document.getElementById('toggleSlideDownload');
  const toggleProofread = document.getElementById('toggleProofread');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const geminiModelMode = document.getElementById('geminiModelMode');
  const geminiSelectedModel = document.getElementById('geminiSelectedModel');
  const saveGeminiApiKey = document.getElementById('saveGeminiApiKey');
  const geminiApiKeyStatus = document.getElementById('geminiApiKeyStatus');
  let lastSavedApiKey = '';
  const modelModeLabels = {
    [GEMINI_MODEL_MODES.auto]: '自動選択（バランス）',
    [GEMINI_MODEL_MODES.autoSpeed]: '自動選択（速度優先）',
    [GEMINI_MODEL_MODES.autoQuality]: '自動選択（精度優先）',
    [GEMINI_MODEL_MODES.manual]: '手動指定',
  };

  const storageDefaults = {
    [STORAGE_KEYS.forceEssentialEnabled]: true,
    [STORAGE_KEYS.showTotalTime]: true,
    [STORAGE_KEYS.showDailyTarget]: true,
    [STORAGE_KEYS.autoSkipEnabled]: false,
    [STORAGE_KEYS.alwaysFocusEnabled]: true,
    [STORAGE_KEYS.copyTextEnabled]: true,
    [STORAGE_KEYS.downloadEnabled]: true,
    [STORAGE_KEYS.slideDownloadEnabled]: true,
    [STORAGE_KEYS.proofreadEnabled]: true,
    [STORAGE_KEYS.geminiApiKey]: '',
    [STORAGE_KEYS.geminiModelMode]: GEMINI_MODEL_MODES.auto,
    [STORAGE_KEYS.geminiSelectedModel]: DEFAULT_GEMINI_MODEL,
  };

  const saveSetting = (key, value, callback) => {
    chrome.storage.local.set({ [key]: value }, callback);
  };

  // タブ切り替えロジック
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(targetId).classList.add('active');
    });
  });

  const normalizeModelMode = (value) => {
    return Object.values(GEMINI_MODEL_MODES).includes(value) ? value : GEMINI_MODEL_MODES.auto;
  };

  const normalizeModelName = (value) => {
    return GEMINI_MODEL_MANUAL_OPTIONS.includes(value) ? value : DEFAULT_GEMINI_MODEL;
  };

  const getModelDisplayName = (modelName) => {
    if (modelName === DEFAULT_GEMINI_MODEL) {
      return `${modelName}（推奨）`;
    }
    return modelName;
  };

  const getModelModeDisplayName = (mode) => {
    return modelModeLabels[normalizeModelMode(mode)] || modelModeLabels[GEMINI_MODEL_MODES.auto];
  };

  const setApiKeyStatus = (message) => {
    if (geminiApiKeyStatus) {
      const suffix = toggleProofread && !toggleProofread.checked ? ' / AI校正はOFF' : '';
      geminiApiKeyStatus.textContent = `${message}${suffix}`;
    }
  };

  const getCurrentModelSettings = () => {
    return {
      [STORAGE_KEYS.geminiModelMode]: normalizeModelMode(geminiModelMode?.value),
      [STORAGE_KEYS.geminiSelectedModel]: normalizeModelName(geminiSelectedModel?.value),
    };
  };

  const getCurrentModeLabel = () => {
    const {
      [STORAGE_KEYS.geminiModelMode]: currentMode,
      [STORAGE_KEYS.geminiSelectedModel]: currentModel,
    } = getCurrentModelSettings();
    return currentMode === GEMINI_MODEL_MODES.manual ? getModelDisplayName(currentModel) : getModelModeDisplayName(currentMode);
  };

  const hasUnsavedApiKey = () => {
    if (!geminiApiKeyInput) return false;
    return geminiApiKeyInput.value.trim() !== lastSavedApiKey;
  };

  const populateModelOptions = () => {
    if (!geminiSelectedModel) return;

    geminiSelectedModel.innerHTML = '';
    for (const modelName of GEMINI_MODEL_MANUAL_OPTIONS) {
      const option = document.createElement('option');
      option.value = modelName;
      option.textContent = getModelDisplayName(modelName);
      geminiSelectedModel.appendChild(option);
    }
  };

  const updateModelUi = () => {
    if (!geminiModelMode || !geminiSelectedModel) return;

    const isManual = geminiModelMode.value === GEMINI_MODEL_MODES.manual;
    geminiSelectedModel.disabled = !isManual;
  };

  const saveApiKey = () => {
    if (!geminiApiKeyInput) return;

    const geminiApiKey = geminiApiKeyInput.value.trim();

    saveSetting(STORAGE_KEYS.geminiApiKey, geminiApiKey, () => {
      const lastError = chrome.runtime?.lastError || null;
      if (lastError) {
        setApiKeyStatus('保存に失敗しました');
        return;
      }

      lastSavedApiKey = geminiApiKey;
      const prefix = geminiApiKey ? 'APIキーを保存しました' : 'APIキーを削除しました';
      setApiKeyStatus(`${prefix} (${getCurrentModeLabel()})`);
    });
  };

  const saveModelSettings = () => {
    const modelSettings = getCurrentModelSettings();

    chrome.storage.local.set(modelSettings, () => {
      const lastError = chrome.runtime?.lastError || null;
      if (lastError) {
        setApiKeyStatus('モデル設定の保存に失敗しました');
        return;
      }

      const suffix = hasUnsavedApiKey() ? ' / APIキーは未保存' : '';
      setApiKeyStatus(`モデル設定を保存しました (${getCurrentModeLabel()})${suffix}`);
    });
  };

  populateModelOptions();

  // 初期状態を読み込んでUIのスイッチに反映
  chrome.storage.local.get(
    storageDefaults,
    (result) => {
      toggleFilter.checked = result[STORAGE_KEYS.forceEssentialEnabled];
      if (toggleTime) toggleTime.checked = result[STORAGE_KEYS.showTotalTime];
      if (toggleDailyTarget) toggleDailyTarget.checked = result[STORAGE_KEYS.showDailyTarget];
      if (toggleAutoSkip) toggleAutoSkip.checked = result[STORAGE_KEYS.autoSkipEnabled];
      if (toggleAlwaysFocus) toggleAlwaysFocus.checked = result[STORAGE_KEYS.alwaysFocusEnabled];
      if (toggleCopyText) toggleCopyText.checked = result[STORAGE_KEYS.copyTextEnabled];
      if (toggleDownload) toggleDownload.checked = result[STORAGE_KEYS.downloadEnabled];
      if (toggleSlideDownload) toggleSlideDownload.checked = result[STORAGE_KEYS.slideDownloadEnabled];
      if (toggleProofread) toggleProofread.checked = result[STORAGE_KEYS.proofreadEnabled];
      if (geminiApiKeyInput) geminiApiKeyInput.value = result[STORAGE_KEYS.geminiApiKey] || '';
      lastSavedApiKey = (result[STORAGE_KEYS.geminiApiKey] || '').trim();
      if (geminiModelMode) geminiModelMode.value = normalizeModelMode(result[STORAGE_KEYS.geminiModelMode]);
      if (geminiSelectedModel) geminiSelectedModel.value = normalizeModelName(result[STORAGE_KEYS.geminiSelectedModel]);
      updateModelUi();

      const modeLabel = normalizeModelMode(result[STORAGE_KEYS.geminiModelMode]) === GEMINI_MODEL_MODES.manual
        ? getModelDisplayName(normalizeModelName(result[STORAGE_KEYS.geminiSelectedModel]))
        : getModelModeDisplayName(result[STORAGE_KEYS.geminiModelMode]);
      setApiKeyStatus(result[STORAGE_KEYS.geminiApiKey] ? `APIキー保存済み (${modeLabel})` : `APIキー未設定 (${modeLabel})`);
    }
  );

  // トグル変更時に即座に保存
  toggleFilter.addEventListener('change', () => {
    saveSetting(STORAGE_KEYS.forceEssentialEnabled, toggleFilter.checked);
  });

  toggleTime.addEventListener('change', () => {
    saveSetting(STORAGE_KEYS.showTotalTime, toggleTime.checked);
  });

  if (toggleDailyTarget) {
    toggleDailyTarget.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.showDailyTarget, toggleDailyTarget.checked);
    });
  }

  if (toggleAutoSkip) {
    toggleAutoSkip.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.autoSkipEnabled, toggleAutoSkip.checked);
    });
  }

  if (toggleAlwaysFocus) {
    toggleAlwaysFocus.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.alwaysFocusEnabled, toggleAlwaysFocus.checked);
    });
  }

  if (toggleCopyText) {
    toggleCopyText.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.copyTextEnabled, toggleCopyText.checked);
    });
  }

  if (toggleDownload) {
    toggleDownload.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.downloadEnabled, toggleDownload.checked);
    });
  }

  if (toggleSlideDownload) {
    toggleSlideDownload.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.slideDownloadEnabled, toggleSlideDownload.checked);
    });
  }

  if (toggleProofread) {
    toggleProofread.addEventListener('change', () => {
      saveSetting(STORAGE_KEYS.proofreadEnabled, toggleProofread.checked, () => {
        const lastError = chrome.runtime?.lastError || null;
        if (lastError) {
          setApiKeyStatus('AI文章校正の設定保存に失敗しました');
          return;
        }

        const prefix = toggleProofread.checked ? 'AI文章校正を有効化しました' : 'AI文章校正を無効化しました';
        setApiKeyStatus(`${prefix} (${getCurrentModeLabel()})`);
      });
    });
  }

  if (saveGeminiApiKey) {
    saveGeminiApiKey.addEventListener('click', saveApiKey);
  }

  if (geminiApiKeyInput) {
    geminiApiKeyInput.addEventListener('input', () => {
      setApiKeyStatus(`APIキーを保存してください (${getCurrentModeLabel()})`);
    });
    geminiApiKeyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveApiKey();
      }
    });
  }

  if (geminiModelMode) {
    geminiModelMode.addEventListener('change', () => {
      updateModelUi();
      saveModelSettings();
    });
  }

  if (geminiSelectedModel) {
    geminiSelectedModel.addEventListener('change', () => {
      saveModelSettings();
    });
  }
});
