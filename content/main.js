const alwaysFocus = new ZenstudyToolAlwaysFocus();

// iframe 内では UI の追加や自動スキップは実行しない
if (window.top === window.self) {
  const autoFilter = new ZenstudyToolAutoFilter();
  const timeLogic = new ZenstudyToolTimeLogic();
  const ui = new ZenstudyToolUI(timeLogic);
  const autoSkip = new ZenstudyToolAutoSkip();
  const videoEndAlert = new ZenstudyToolVideoEndAlert();
  const copyText = new ZenstudyToolCopyText();
  const proofreader = new ZenstudyToolProofreader();
  const answerAssist = new ZenstudyToolAnswerAssist();
  const downloader = new ZenstudyToolDownloader();
}
