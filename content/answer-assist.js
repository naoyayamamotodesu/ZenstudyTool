class ZenstudyToolAnswerAssist {
  constructor() {
    this.hintSequence = 0;
    this.boundIframes = new WeakSet();
    this.boundFields = new WeakSet();
    this.observedIframeDocument = null;
    this.iframeDocumentObserver = null;
    this.observer = createDebouncedObserver(() => this.checkIframe(), 500);

    this.checkIframe();
  }

  checkIframe() {
    const iframe = document.querySelector(ACTION_IFRAME_SELECTOR);
    if (!iframe) return;

    if (!this.boundIframes.has(iframe)) {
      this.boundIframes.add(iframe);
      iframe.addEventListener("load", () => this.refreshFields(iframe));
    }

    this.refreshFields(iframe);
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
      () => this.refreshFields(iframe),
      200,
      true
    );
  }

  refreshFields(iframe) {
    const iframeDoc = this.getIframeDocument(iframe);
    if (!iframeDoc) return;
    this.watchIframeDocument(iframe, iframeDoc);

    const fields = Array.from(iframeDoc.querySelectorAll(ANSWER_TEXTAREA_SELECTOR))
      .filter((field) => field.getClientRects().length > 0);

    fields.forEach((field) => {
      this.bindField(field);
      this.updateField(field);
    });
  }

  bindField(field) {
    if (this.boundFields.has(field)) return;

    this.boundFields.add(field);
    field.addEventListener("input", () => this.updateField(field));
    field.addEventListener("change", () => this.updateField(field));
  }

  updateField(field) {
    const rule = this.getLengthRule(field);
    if (!rule?.min && !rule?.max) {
      this.removeBadge(field);
      return;
    }

    const count = this.countCharacters(field.value);
    const nativeOverLimitWarning = this.syncNativeOverLimitWarning(field, rule, count);

    const maxExceeded = rule.max && count > rule.max;
    const minShortage = !maxExceeded && rule.min && count > 0 && count < rule.min;
    const shouldWarn = maxExceeded || minShortage;

    if (!shouldWarn) {
      this.hideBadge(field);
      return;
    }

    if (maxExceeded && nativeOverLimitWarning) {
      this.hideBadge(field);
    } else {
      const badge = this.ensureBadge(field);
      badge.hidden = false;
      badge.textContent = maxExceeded
        ? `${count - rule.max}文字オーバー`
        : `${rule.min - count}文字不足`;
      this.placeBadge(field, badge);
    }
  }

  ensureBadge(field) {
    const doc = field.ownerDocument;
    let badge = field.dataset.zstAnswerLengthBadgeId
      ? doc.getElementById(field.dataset.zstAnswerLengthBadgeId)
      : null;

    if (!badge) {
      badge = doc.createElement("span");
      badge.id = `__ZENSTUDYTOOL_answerLengthBadge_${++this.hintSequence}`;
      badge.className = CSS_CLASSES.answerLengthBadge;
      field.dataset.zstAnswerLengthBadgeId = badge.id;
    }

    return badge;
  }

  placeBadge(field, badge) {
    const counter = this.findCounterElement(field);
    if (counter?.parentNode) {
      counter.parentNode.insertBefore(badge, counter);
      return;
    }

    const anchor = this.getInsertAnchor(field);
    const parent = anchor.parentNode;
    if (parent && badge.previousElementSibling !== anchor) {
      parent.insertBefore(badge, anchor.nextSibling);
    }
  }

  getInsertAnchor(field) {
    return field.closest(`.${CSS_CLASSES.fieldProofreadRow}`) || field;
  }

  hideBadge(field) {
    const badge = this.getBadge(field);
    if (badge) {
      badge.hidden = true;
      badge.textContent = "";
    }
  }

  removeBadge(field) {
    const badge = this.getBadge(field);
    if (badge) badge.remove();
    delete field.dataset.zstAnswerLengthBadgeId;
  }

  getBadge(field) {
    return field.dataset.zstAnswerLengthBadgeId
      ? field.ownerDocument.getElementById(field.dataset.zstAnswerLengthBadgeId)
      : null;
  }

  getLengthRule(field) {
    return getAnswerLengthRuleForField(field);
  }

  collectQuestionText(field) {
    return collectQuestionTextForField(field);
  }

  normalizeText(text) {
    return normalizeCharacterRuleText(text);
  }

  parseCharacterCountRule(text) {
    return parseCharacterCountRule(text);
  }

  countCharacters(value) {
    return countAnswerCharacters(value);
  }

  syncNativeOverLimitWarning(field, rule, count) {
    if (!rule?.max) return false;

    const expectedText = count > rule.max ? `${count - rule.max}文字オーバー` : "";
    const container = field.closest("li.exercise-item, .exercise-item, .answer-area") || field.closest("section.exercise");
    if (!container) return false;

    const syncCandidates = () => {
      const candidates = this.findNativeOverLimitWarnings(container);
      for (const candidate of candidates) {
        if (!expectedText) {
          candidate.textContent = "";
          candidate.hidden = true;
          candidate.style.display = "none";
          continue;
        }

        candidate.hidden = false;
        candidate.style.display = "";
        if (this.normalizeText(candidate.textContent || "") !== expectedText) {
          candidate.textContent = expectedText;
        }
      }

      if (expectedText && candidates.length > 0) {
        this.hideBadge(field);
      }

      return candidates.length;
    };

    const initialCount = syncCandidates();
    window.setTimeout(syncCandidates, 0);
    window.setTimeout(syncCandidates, 80);

    return initialCount > 0;
  }

  findNativeOverLimitWarnings(container) {
    const candidates = Array.from(container.querySelectorAll("*"))
      .filter((el) => {
        if (el.classList?.contains(CSS_CLASSES.answerLengthBadge)) return false;
        const text = this.normalizeText(el.textContent || "");
        return /^\d{1,5}文字オーバー$/.test(text);
      });

    return candidates;
  }

  findCounterElement(field) {
    const container = field.closest("li.exercise-item, .exercise-item, .answer-area") || field.closest("section.exercise");
    if (!container) return null;

    const counters = Array.from(container.querySelectorAll(".counter, [class*='counter'], [class*='count']"))
      .filter((el) => /^\d{1,5}文字$/.test(this.normalizeText(el.textContent || "")));

    if (counters.length === 0) return null;

    const fieldPosition = field.compareDocumentPosition.bind(field);
    return counters.find((counter) => fieldPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING) || counters[counters.length - 1];
  }
}
