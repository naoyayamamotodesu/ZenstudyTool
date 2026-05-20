class ZenstudyToolProofreader {
  constructor() {
    this.enabled = true;
    this.apiKeyConfigured = false;
    this.btn = null;
    this.isProcessing = false;
    this.spinnerIndex = 0;
    this.spinnerTimer = null;
    this.observedIframeDocument = null;
    this.iframeDocumentObserver = null;
    this.observer = createDebouncedObserver(() => this.checkIframe(), 500);

    this.injectStyles();

    safeStorageGet({
      [STORAGE_KEYS.geminiApiKey]: "",
      [STORAGE_KEYS.proofreadEnabled]: true,
    }, (result) => {
      this.enabled = Boolean(result[STORAGE_KEYS.proofreadEnabled]);
      this.apiKeyConfigured = Boolean((result[STORAGE_KEYS.geminiApiKey] || "").trim());
      this.checkIframe();
    });

    addSafeStorageChangeListener((changes, area) => {
      if (area !== "local") return;
      const enabledChange = changes[STORAGE_KEYS.proofreadEnabled];
      const apiKeyChange = changes[STORAGE_KEYS.geminiApiKey];

      if (enabledChange !== undefined) {
        this.enabled = Boolean(enabledChange.newValue);
      }

      if (apiKeyChange !== undefined) {
        this.apiKeyConfigured = Boolean((apiKeyChange.newValue || "").trim());
      }

      this.checkIframe();
    });
  }

  injectStyles() {
    if (document.getElementById('zst-proofreader-styles')) return;
    const style = document.createElement('style');
    style.id = 'zst-proofreader-styles';
    style.textContent = `
      @keyframes zst-pulse-glow {
        0% { box-shadow: 0 0 0 0 rgba(0, 119, 211, 0.4); border-color: rgba(0, 119, 211, 0.4); }
        50% { box-shadow: 0 0 0 4px rgba(0, 119, 211, 0.1); border-color: rgba(0, 119, 211, 1); }
        100% { box-shadow: 0 0 0 0 rgba(0, 119, 211, 0.4); border-color: rgba(0, 119, 211, 0.4); }
      }
      .zst-proofreading-field {
        animation: zst-pulse-glow 1.5s infinite !important;
        transition: all 0.3s ease !important;
        position: relative;
        z-index: 1;
      }
    `;
    document.head.appendChild(style);
  }

  checkIframe() {
    const iframe = document.querySelector(ACTION_IFRAME_SELECTOR);
    if (this.enabled && iframe) {
      if (!iframe.dataset.zstProofreaderBound) {
        iframe.dataset.zstProofreaderBound = 'true';
        iframe.addEventListener('load', () => {
          this.showButton(iframe);
        });
      }
      this.showButton(iframe);
    } else {
      this.hideButton(iframe);
    }
  }

  getIframeDocument(iframe) {
    return getAccessibleIframeDocument(iframe);
  }

  watchIframeDocument(iframe, iframeDoc) {
    if (!iframeDoc || this.observedIframeDocument === iframeDoc) return;
    if (this.iframeDocumentObserver) this.iframeDocumentObserver.disconnect();

    this.observedIframeDocument = iframeDoc;
    this.iframeDocumentObserver = createDebouncedRootObserver(
      iframeDoc.documentElement || iframeDoc.body,
      () => this.showButton(iframe),
      200
    );
  }

  showButton(iframe) {
    if (!this.enabled) return;

    const iframeDoc = this.getIframeDocument(iframe);
    if (!iframeDoc) return;
    this.watchIframeDocument(iframe, iframeDoc);

    const evaluateButtonWrapper = findActionButtonWrapper(iframeDoc);
    if (!evaluateButtonWrapper) return;

    const proofreadFields = this.getVisibleProofreadFields(iframeDoc);
    if (proofreadFields.length === 0) {
      this.hideButton(iframe, false);
      return;
    }

    evaluateButtonWrapper.classList.add(CSS_CLASSES.actionRow);

    let button = iframeDoc.getElementById(ELEMENT_IDS.proofreadButton);
    if (!button) {
      button = iframeDoc.createElement('button');
      button.id = ELEMENT_IDS.proofreadButton;
      button.type = 'button';
      button.className = `u-button type-primary-light ${CSS_CLASSES.footerActionButton}`;
      button.addEventListener('click', () => {
        this.handleProofreadClick(iframe);
      });
      evaluateButtonWrapper.appendChild(button);
    } else {
      button.classList.add(CSS_CLASSES.footerActionButton);
    }

    this.btn = button;
    this.ensureFieldProofreadButtons(iframe, iframeDoc, proofreadFields);
    this.updateReadyButton(iframeDoc);
  }

  hideButton(iframe, disconnectObserver = true) {
    if (disconnectObserver && this.iframeDocumentObserver) {
      this.iframeDocumentObserver.disconnect();
      this.iframeDocumentObserver = null;
      this.observedIframeDocument = null;
    }

    if (this.btn && this.btn.parentNode) {
      this.btn.parentNode.removeChild(this.btn);
    }
    this.btn = null;

    if (iframe) {
      const iframeDoc = this.getIframeDocument(iframe);
      if (iframeDoc) {
        const existingButton = iframeDoc.getElementById(ELEMENT_IDS.proofreadButton);
        if (existingButton) existingButton.remove();
        iframeDoc
          .querySelectorAll(`.${CSS_CLASSES.fieldProofreadRow}`)
          .forEach((row) => {
            const parent = row.parentNode;
            if (!parent) return;

            row
              .querySelectorAll('textarea, input[type="text"], input[type="search"]')
              .forEach((field) => {
                field.classList.remove('zst-proofreading-field');
                parent.insertBefore(field, row);
              });

            row.remove();
          });
        iframeDoc
          .querySelectorAll('textarea, input[type="text"], input[type="search"]')
          .forEach((field) => field.removeAttribute('data-zst-proofread-bound'));
      }
    }
  }

  getProofreadButtonTitle(isBatch = false) {
    if (!this.enabled) {
      return 'ポップアップでAI文章校正を有効にしてください';
    }
    if (!this.apiKeyConfigured) {
      return 'ポップアップでGemini APIキーを設定してください';
    }
    return isBatch
      ? '入力済みの欄をまとめてAIで校正します'
      : 'この入力欄だけをAIで校正します';
  }

  applyButtonTone(button, tone = 'default') {
    if (!button) return;
    const styles = {
      busy: { bg: '#6f7782', color: '#fff', border: '#6f7782' },
      success: { bg: '#00c541', color: '#fff', border: '#00c541' },
      error: { bg: '#d44c4c', color: '#fff', border: '#d44c4c' },
      default: { bg: '', color: '', border: '' }
    };
    const s = styles[tone] || styles.default;
    button.style.backgroundColor = s.bg;
    button.style.color = s.color;
    button.style.borderColor = s.border;
  }

  setProofreadButtonState(button, label, tone = 'default', disabled = false, title = '') {
    if (!button) return;
    button.innerHTML = label;
    button.disabled = disabled;
    button.title = title;
    this.applyButtonTone(button, tone);
  }

  startSpinner(button, baseLabel) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % frames.length;
      button.innerHTML = `${frames[this.spinnerIndex]} ${baseLabel}`;
    }, 80);
  }

  stopSpinner() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  setButtonPresentation(label, tone = 'default', disabled = false) {
    this.setProofreadButtonState(
      this.btn,
      label,
      tone,
      disabled,
      this.getProofreadButtonTitle(true)
    );
  }

  updateReadyButton(iframeDoc = null) {
    if (this.isProcessing) return;
    this.stopSpinner();
    this.setButtonPresentation(PROOFREAD_BUTTON_TEXT.ready, 'default', false);

    if (!iframeDoc) return;
    iframeDoc
      .querySelectorAll(`.${CSS_CLASSES.fieldProofreadButton}`)
      .forEach((button) => {
        // 元に戻す状態のボタンはリセットしない
        if (button.dataset.zstProofreadState === 'undo') return;
        if (button.dataset.zstProofreadState === 'failed') return;
        
        this.setProofreadButtonState(
          button,
          FIELD_PROOFREAD_BUTTON_TEXT.ready,
          'default',
          false,
          this.getProofreadButtonTitle(false)
        );
      });
  }

  getPageContextLines() {
    const lines = [];
    const courseNameEl = document.querySelector('a[href^="/courses/"] span');
    let chapterNameEl = document.querySelector('h1 span') || document.querySelector('h2 span') || document.querySelector('h1, h2');
    const courseName = courseNameEl ? courseNameEl.textContent.trim() : '';
    const chapterName = chapterNameEl ? chapterNameEl.textContent.trim() : '';
    if (courseName) lines.push(`コース: ${courseName}`);
    if (chapterName) lines.push(`単元: ${chapterName}`);
    return lines;
  }

  normalizeContextText(text) {
    return (text || '').replace(/\r/g, '\n').replace(/\u3000/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  collectFieldContext(field, lengthRule = getAnswerLengthRuleForField(field)) {
    const contextLines = this.getPageContextLines();
    const section = field.closest('section.exercise');
    const item = field.closest('li.exercise-item, .exercise-item, .answer-area');
    const statementText = this.normalizeContextText(section?.querySelector('.statement')?.textContent || '');
    const questionText = this.normalizeContextText(item?.querySelector('.question')?.textContent || '');
    if (statementText) contextLines.push(`大問: ${statementText}`);
    if (questionText) contextLines.push(`設問: ${questionText}`);
    const lengthRuleText = formatCharacterCountRule(lengthRule);
    if (lengthRuleText) {
      contextLines.push(`字数指定: ${lengthRuleText}（校正では元の文量を保ち、字数を満たすために内容を追加しない）`);
    }
    return contextLines.join('\n');
  }

  getVisibleProofreadFields(iframeDoc) {
    return Array.from(iframeDoc.querySelectorAll(PROOFREAD_FIELD_SELECTOR)).filter((f) => f.getClientRects().length > 0);
  }

  createProofreadTarget(field) {
    const value = typeof field?.value === 'string' ? field.value.replace(/\r\n/g, '\n').trim() : '';
    if (!value) return null;
    const lengthRule = getAnswerLengthRuleForField(field);
    return {
      element: field,
      value,
      context: this.collectFieldContext(field, lengthRule),
      lengthRule,
      originalLength: countAnswerCharacters(value),
    };
  }

  ensureFieldProofreadButtons(iframe, iframeDoc, fields = this.getVisibleProofreadFields(iframeDoc)) {
    fields.forEach((field) => {
      if (field.dataset.zstProofreadBound === 'true') return;
      const fieldParent = field.parentNode;
      if (!fieldParent) return;

      const row = iframeDoc.createElement('div');
      row.className = `${CSS_CLASSES.fieldProofreadRow} ${CSS_CLASSES.fieldProofreadRowTextarea}`;
      const actionRow = iframeDoc.createElement('div');
      actionRow.className = CSS_CLASSES.fieldProofreadActions;
      const button = iframeDoc.createElement('button');
      button.type = 'button';
      button.className = CSS_CLASSES.fieldProofreadButton;
      button.dataset.zstProofreadState = 'ready';
      button.addEventListener('click', () => {
        if (button.dataset.zstProofreadState === 'undo') {
          this.handleUndoClick(field, button);
        } else {
          this.handleSingleFieldProofreadClick(iframe, field, button);
        }
      });
      field.addEventListener('input', () => {
        this.clearFieldFailure(field);
      });
      actionRow.appendChild(button);
      fieldParent.insertBefore(row, field);
      row.appendChild(field);
      row.appendChild(actionRow);
      field.dataset.zstProofreadBound = 'true';
    });
  }

  collectProofreadTargets(iframeDoc) {
    return this.getVisibleProofreadFields(iframeDoc).map((f) => this.createProofreadTarget(f)).filter(Boolean);
  }

  requestProofread(payload) {
    return new Promise((resolve, reject) => {
      safeRuntimeSendMessage({
        type: MESSAGE_TYPES.proofreadText,
        originalText: payload.value,
        promptContext: payload.context,
      }, (response, lastError) => {
        if (lastError) return reject(new Error(lastError.message || 'AI校正に失敗しました'));
        if (!response?.success || typeof response.correctedText !== 'string') {
          const error = new Error(response?.message || 'AI校正に失敗しました');
          error.code = response?.code || '';
          error.status = response?.status || 0;
          return reject(error);
        }
        resolve(response.correctedText);
      });
    });
  }

  applyFieldValue(field, value) {
    const view = field.ownerDocument?.defaultView || window;
    const EventCtor = view.Event || Event;
    const prototype = field.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor?.set) descriptor.set.call(field, value); else field.value = value;
    field.dispatchEvent(new EventCtor('input', { bubbles: true }));
    field.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  getFieldProofreadButton(field) {
    return field.parentNode?.querySelector(`.${CSS_CLASSES.fieldProofreadButton}`) || null;
  }

  validateCorrectedText(target, correctedText) {
    const correctedCount = countAnswerCharacters(correctedText);
    const originalCount = target.originalLength || countAnswerCharacters(target.value);
    if (!correctedText.trim()) throw new Error('校正結果が空でした');
    if (target.element.maxLength > 0 && correctedCount > target.element.maxLength) {
      throw new Error(`校正結果が入力上限を${correctedCount - target.element.maxLength}文字超えたため反映できませんでした`);
    }

    const rule = target.lengthRule;
    if (rule?.max && correctedCount > rule.max) {
      throw new Error(`校正結果が指定文字数を${correctedCount - rule.max}文字超えたため反映できませんでした`);
    }
    if (rule?.min && correctedCount < rule.min) {
      throw new Error(`校正結果が指定文字数を${rule.min - correctedCount}文字下回ったため反映できませんでした`);
    }

    if (originalCount >= 80) {
      const allowedDelta = Math.max(30, Math.ceil(originalCount * 0.2));
      const actualDelta = Math.abs(correctedCount - originalCount);
      if (actualDelta > allowedDelta) {
        throw new Error(`校正結果の文字数が元の文章から大きく変化したため反映できませんでした（${originalCount}文字 → ${correctedCount}文字）`);
      }
    }
  }

  setFieldButtonsDisabled(iframeDoc, disabled) {
    iframeDoc.querySelectorAll(`.${CSS_CLASSES.fieldProofreadButton}`).forEach((btn) => {
      if (btn.dataset.zstProofreadState !== 'undo') btn.disabled = disabled;
    });
  }

  shouldStopBatchOnError(error) {
    if (['MISSING_API_KEY', 'EMPTY_TEXT'].includes(error?.code)) return true;
    if (error?.status === 401 || error?.status === 403) return true;
    return /api[_\s-]*key|key not valid|permission|権限|APIキー/i.test(error?.message || '');
  }

  handleUndoClick(field, button) {
    if (this.isProcessing) return;
    const originalText = field.dataset.zstOriginalText || '';
    this.applyFieldValue(field, originalText);
    this.removeDiff(field);
    delete field.dataset.zstOriginalText;
    button.dataset.zstProofreadState = 'ready';
    this.setProofreadButtonState(button, FIELD_PROOFREAD_BUTTON_TEXT.ready, 'default', false, this.getProofreadButtonTitle(false));
  }

  tokenize(text) {
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text)).map(s => s.segment);
      }
    } catch (e) {
      console.warn('[ZenstudyTool] Intl.Segmenter failed', e);
    }
    return Array.from(text);
  }

  computeMyersDiff(str1, str2) {
    const a = this.tokenize(str1);
    const b = this.tokenize(str2);

    let prefixCount = 0;
    while (prefixCount < a.length && prefixCount < b.length && a[prefixCount] === b[prefixCount]) {
      prefixCount++;
    }

    let suffixCount = 0;
    while (suffixCount < (a.length - prefixCount) && suffixCount < (b.length - prefixCount) && a[a.length - 1 - suffixCount] === b[b.length - 1 - suffixCount]) {
      suffixCount++;
    }

    const subA = a.slice(prefixCount, a.length - suffixCount);
    const subB = b.slice(prefixCount, b.length - suffixCount);

    const prefixDiff = a.slice(0, prefixCount).map(text => ({ type: 'equal', text }));
    const suffixDiff = a.slice(a.length - suffixCount).map(text => ({ type: 'equal', text }));

    if (subA.length === 0 && subB.length === 0) {
      return [...prefixDiff, ...suffixDiff];
    }

    const n = subA.length, m = subB.length, max = n + m, v = new Int32Array(2 * max + 1), trace = [];
    v[max + 1] = 0;
    
    let subDiff = [];
    let found = false;
    for (let d = 0; d <= max; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) ? v[max + k + 1] : v[max + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && subA[x] === subB[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= n && y >= m) {
          trace.push(new Int32Array(v)); // 保存してからバックトレース
          let currX = n, currY = m;
          for (let dStep = d; dStep > 0; dStep--) {
            const vStep = trace[dStep - 1];
            const kStep = currX - currY;
            const prevK = (kStep === -dStep || (kStep !== dStep && vStep[max + kStep - 1] < vStep[max + kStep + 1])) ? kStep + 1 : kStep - 1;
            const prevX = vStep[max + prevK], prevY = prevX - prevK;
            while (currX > prevX && currY > prevY) { subDiff.push({ type: 'equal', text: subA[currX - 1] }); currX--; currY--; }
            if (currX > prevX) { subDiff.push({ type: 'removed', text: subA[currX - 1] }); currX--; }
            else if (currY > prevY) { subDiff.push({ type: 'added', text: subB[currY - 1] }); currY--; }
          }
          while (currX > 0 && currY > 0) { subDiff.push({ type: 'equal', text: subA[currX - 1] }); currX--; currY--; }
          subDiff.reverse();
          found = true;
          break;
        }
      }
      if (found) break;
      trace.push(new Int32Array(v));
    }

    return [...prefixDiff, ...subDiff, ...suffixDiff];
  }

  showDiff(field, oldStr, newStr) {
    this.removeDiff(field);
    const diffView = document.createElement('div');
    diffView.className = 'zst-proofread-diff';
    Object.assign(diffView.style, {
      marginTop: '12px',
      padding: '12px',
      border: '1px solid #d1d5da',
      borderRadius: '6px',
      backgroundColor: '#fafbfc',
      fontSize: '13px',
      lineHeight: '1.6',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: '#24292e'
    });
    const diff = this.computeMyersDiff(oldStr, newStr);
    let html = '', currentType = null, currentText = '';
    const commit = () => {
      if (currentType === null) return;
      const escaped = currentText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (currentType === 'equal') {
        html += `<span>${escaped}</span>`;
      } else if (currentType === 'added') {
        html += `<ins style="background-color:#ccffd8;text-decoration:none;color:#116329;padding:0 2px;border-radius:2px;font-weight:600;">${escaped}</ins>`;
      } else if (currentType === 'removed') {
        html += `<del style="background-color:#ffe3e6;text-decoration:line-through;color:#b31d28;padding:0 2px;border-radius:2px;">${escaped}</del>`;
      }
      currentText = '';
    };
    for (const op of diff) {
      if (op.type !== currentType) {
        commit();
        currentType = op.type;
      }
      currentText += op.text;
    }
    commit();
    diffView.innerHTML = html;
    
    // row コンテナ自体の直後に挿入する
    const rowContainer = field.parentNode;
    if (rowContainer && rowContainer.classList.contains(CSS_CLASSES.fieldProofreadRow)) {
      rowContainer.parentNode.insertBefore(diffView, rowContainer.nextSibling);
    } else {
      field.parentNode.insertBefore(diffView, field.nextSibling);
    }
    
    field.dataset.zstHasDiff = 'true';
  }

  removeDiff(field) {
    if (field.dataset.zstHasDiff === 'true') {
      const rowContainer = field.parentNode;
      let diffView;
      if (rowContainer && rowContainer.classList.contains(CSS_CLASSES.fieldProofreadRow)) {
        // 次の兄弟要素が diffView かどうか確認
        let nextSibling = rowContainer.nextElementSibling;
        while (nextSibling && !nextSibling.classList.contains('zst-proofread-diff')) {
          nextSibling = nextSibling.nextElementSibling;
        }
        if (nextSibling && nextSibling.classList.contains('zst-proofread-diff')) {
          diffView = nextSibling;
        }
      } else {
        diffView = field.parentNode.querySelector('.zst-proofread-diff');
      }
      
      if (diffView) diffView.remove();
      delete field.dataset.zstHasDiff;
    }
  }

  getFieldFeedbackAnchor(field) {
    const rowContainer = field.parentNode;
    return rowContainer && rowContainer.classList.contains(CSS_CLASSES.fieldProofreadRow)
      ? rowContainer
      : field;
  }

  getFieldErrorElement(field) {
    return field.dataset.zstProofreadErrorId
      ? field.ownerDocument.getElementById(field.dataset.zstProofreadErrorId)
      : null;
  }

  showFieldError(field, message) {
    const doc = field.ownerDocument;
    let errorView = this.getFieldErrorElement(field);
    if (!errorView) {
      errorView = doc.createElement('div');
      errorView.id = `__ZENSTUDYTOOL_proofreadError_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      field.dataset.zstProofreadErrorId = errorView.id;
      const anchor = this.getFieldFeedbackAnchor(field);
      if (!anchor?.parentNode) return;
      anchor.parentNode.insertBefore(errorView, anchor.nextSibling);
    }

    Object.assign(errorView.style, {
      marginTop: '10px',
      padding: '10px 12px',
      border: '1px solid #ff4d4f',
      borderRadius: '6px',
      backgroundColor: '#fff2f0',
      color: '#a8071a',
      fontSize: '12px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    });
    errorView.textContent = message;
  }

  removeFieldError(field) {
    const errorView = this.getFieldErrorElement(field);
    if (errorView) errorView.remove();
    delete field.dataset.zstProofreadErrorId;
  }

  markFieldFailure(field, button, message) {
    this.removeDiff(field);
    this.showFieldError(field, message);
    if (!button) return;
    button.dataset.zstProofreadState = 'failed';
    this.setProofreadButtonState(button, FIELD_PROOFREAD_BUTTON_TEXT.failed, 'error', false, message);
  }

  clearFieldFailure(field) {
    const button = this.getFieldProofreadButton(field);
    if (button?.dataset.zstProofreadState === 'failed') {
      button.dataset.zstProofreadState = 'ready';
      if (!this.isProcessing) {
        this.setProofreadButtonState(button, FIELD_PROOFREAD_BUTTON_TEXT.ready, 'default', false, this.getProofreadButtonTitle(false));
      }
    }
    this.removeFieldError(field);
  }

  async handleSingleFieldProofreadClick(iframe, field, button) {
    if (this.isProcessing) return;
    if (!this.enabled || !this.apiKeyConfigured) return alert(this.getProofreadButtonTitle(false));
    const iframeDoc = this.getIframeDocument(iframe);
    if (!iframeDoc) return alert('入力欄を取得できませんでした。ページを再読み込みしてください。');
    const target = this.createProofreadTarget(field);
    if (!target) return alert('入力内容がありません。');

    this.clearFieldFailure(field);
    this.isProcessing = true;
    this.setButtonPresentation(PROOFREAD_BUTTON_TEXT.ready, 'default', true);
    this.setFieldButtonsDisabled(iframeDoc, true);
    this.startSpinner(button, FIELD_PROOFREAD_BUTTON_TEXT.working);
    field.classList.add('zst-proofreading-field');

    try {
      const originalText = target.value;
      const correctedText = await this.requestProofread(target);
      this.validateCorrectedText(target, correctedText);
      this.applyFieldValue(target.element, correctedText);
      this.removeFieldError(target.element);
      this.showDiff(target.element, originalText, correctedText);
      target.element.dataset.zstOriginalText = originalText;
      button.dataset.zstProofreadState = 'undo';
      this.stopSpinner();
      this.setProofreadButtonState(button, '元に戻す', 'default', false, '元のテキストに戻します');
    } catch (err) {
      console.error(err);
      this.stopSpinner();
      this.markFieldFailure(field, button, err.message || 'AI校正に失敗しました');
      alert(`失敗: ${err.message}`);
    } finally {
      this.isProcessing = false;
      field.classList.remove('zst-proofreading-field');
      this.updateReadyButton(iframeDoc);
    }
  }

  async handleProofreadClick(iframe) {
    if (this.isProcessing) return;
    if (!this.enabled || !this.apiKeyConfigured) return alert(this.getProofreadButtonTitle(true));
    const iframeDoc = this.getIframeDocument(iframe);
    if (!iframeDoc) return alert('入力欄を取得できませんでした。ページを再読み込みしてください。');
    const targets = this.collectProofreadTargets(iframeDoc);
    if (targets.length === 0) return alert('入力済みの欄がありません。');

    this.isProcessing = true;
    this.setFieldButtonsDisabled(iframeDoc, true);
    this.startSpinner(this.btn, PROOFREAD_BUTTON_TEXT.working);

    let successCount = 0;
    let failureCount = 0;

    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        this.startSpinner(this.btn, `${PROOFREAD_BUTTON_TEXT.working} ${i+1}/${targets.length}`);
        target.element.classList.add('zst-proofreading-field');
        const fieldButton = this.getFieldProofreadButton(target.element);
        this.clearFieldFailure(target.element);
        try {
          const originalText = target.value;
          const correctedText = await this.requestProofread(target);
          this.validateCorrectedText(target, correctedText);
          this.applyFieldValue(target.element, correctedText);
          this.removeFieldError(target.element);
          this.showDiff(target.element, originalText, correctedText);
          target.element.dataset.zstOriginalText = originalText;
          if (fieldButton) {
            fieldButton.dataset.zstProofreadState = 'undo';
            this.setProofreadButtonState(fieldButton, '元に戻す', 'default', false, '元のテキストに戻します');
          }
          successCount += 1;
        } catch (err) {
          failureCount += 1;
          console.error(err);
          this.markFieldFailure(target.element, fieldButton, err.message || 'AI校正に失敗しました');
          if (this.shouldStopBatchOnError(err)) {
            throw err;
          }
        } finally {
          target.element.classList.remove('zst-proofreading-field');
        }
      }
      this.stopSpinner();
      if (failureCount > 0) {
        const label = `校正完了 ${successCount}/${targets.length}（失敗${failureCount}）`;
        this.setButtonPresentation(label, successCount > 0 ? 'success' : 'error', true);
        alert(`AI校正が完了しました。成功: ${successCount}件 / 失敗: ${failureCount}件`);
      } else {
        this.setButtonPresentation(PROOFREAD_BUTTON_TEXT.success, 'success', true);
      }
    } catch (err) {
      console.error(err);
      this.stopSpinner();
      this.setButtonPresentation(PROOFREAD_BUTTON_TEXT.failed, 'error', true);
      alert(`失敗: ${err.message}`);
    } finally {
      this.isProcessing = false;
      window.setTimeout(() => this.updateReadyButton(iframeDoc), 2000);
    }
  }
}
