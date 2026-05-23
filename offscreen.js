/**
 * ZenstudyTool - Offscreen Document Script
 *
 * ffmpeg.wasm を使って M3U8 を MP4 へ変換する。
 * 変換不可の場合は TS へフォールバックする。
 */

const { MESSAGE_TYPES } = globalThis.ZenstudyToolConstants;

const INPUT_PLAYLIST_FILE = 'input.m3u8';
const OUTPUT_MP4_FILE = 'output.mp4';

let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoadingPromise = null;
const encoder = new TextEncoder();
const blobRevokeTimers = new Map();
let conversionQueue = Promise.resolve();

function enqueueConversion(task) {
  const queued = conversionQueue.then(task, task);
  // キュー自体は失敗で止めず、次のタスクを流せるようにする
  conversionQueue = queued.catch(() => {});
  return queued;
}

function scheduleBlobRevoke(blobUrl, delayMs = 10 * 60 * 1000) {
  if (!blobUrl) return;
  const existing = blobRevokeTimers.get(blobUrl);
  if (existing) clearTimeout(existing);

  const timerId = setTimeout(() => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (_) {
      // 既に無効化済みなら無視
    }
    blobRevokeTimers.delete(blobUrl);
  }, delayMs);

  blobRevokeTimers.set(blobUrl, timerId);
}

function revokeBlobUrl(blobUrl) {
  if (!blobUrl) return;
  const timerId = blobRevokeTimers.get(blobUrl);
  if (timerId) {
    clearTimeout(timerId);
    blobRevokeTimers.delete(blobUrl);
  }

  try {
    URL.revokeObjectURL(blobUrl);
  } catch (_) {
    // 既に無効化済みなら無視
  }
}

function sendProgress({ phase = 'init', current = 0, total = 0, ...rest } = {}) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.conversionProgress,
    phase,
    current,
    total,
    ...rest,
  });
}

function parseAttributeUri(line) {
  const match = line.match(/URI="([^"]+)"/i);
  return match ? match[1] : null;
}

function replaceAttributeUri(line, newUri) {
  return line.replace(/URI="([^"]+)"/i, `URI="${newUri}"`);
}

function getExtensionFromUrl(url, fallbackExt) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
    if (match) return `.${match[1].toLowerCase()}`;
  } catch (_) {
    // URL パース失敗時はフォールバック
  }
  return fallbackExt;
}

function mergeUint8Arrays(chunks) {
  const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalSize);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`プレイリスト取得失敗: ${response.status}`);
  }
  return response.text();
}

async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`メディア取得失敗: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function selectBestVariantUrl(lines, playlistUrl) {
  let bestBandwidth = -1;
  let bestVariant = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
    const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    const variantPath = lines[i + 1];

    if (!variantPath || variantPath.startsWith('#')) continue;
    if (bandwidth >= bestBandwidth) {
      bestBandwidth = bandwidth;
      bestVariant = new URL(variantPath, playlistUrl).href;
    }
  }

  return bestVariant;
}

async function resolveMediaPlaylist(m3u8Url, depth = 0) {
  if (depth > 8) {
    throw new Error('マスタープレイリストのネストが深すぎます');
  }

  const text = await fetchText(m3u8Url);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const isMaster = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'));
  if (!isMaster) {
    return { playlistUrl: m3u8Url, lines };
  }

  const variantUrl = selectBestVariantUrl(lines, m3u8Url);
  if (!variantUrl) {
    throw new Error('マスタープレイリストからメディアを選択できません');
  }

  return resolveMediaPlaylist(variantUrl, depth + 1);
}

function buildLocalPlaylistBundle(playlistUrl, lines) {
  const assets = [];
  const assetNameByUrl = new Map();
  const rewrittenLines = [];
  const segmentUrls = [];
  let hasEncryption = false;

  const addAsset = (absoluteUrl, kind, fallbackExt) => {
    if (assetNameByUrl.has(absoluteUrl)) return assetNameByUrl.get(absoluteUrl);

    const ext = getExtensionFromUrl(absoluteUrl, fallbackExt);
    const fileName = `${kind}_${String(assets.length).padStart(5, '0')}${ext}`;
    assets.push({ url: absoluteUrl, fileName, kind });
    assetNameByUrl.set(absoluteUrl, fileName);
    return fileName;
  };

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP')) {
      const mapUri = parseAttributeUri(line);
      if (!mapUri) {
        rewrittenLines.push(line);
        continue;
      }

      const mapUrl = new URL(mapUri, playlistUrl).href;
      const mapFile = addAsset(mapUrl, 'map', '.mp4');
      rewrittenLines.push(replaceAttributeUri(line, mapFile));
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      hasEncryption = true;
      const keyUri = parseAttributeUri(line);
      if (!keyUri) {
        rewrittenLines.push(line);
        continue;
      }

      const keyUrl = new URL(keyUri, playlistUrl).href;
      const keyFile = addAsset(keyUrl, 'key', '.key');
      rewrittenLines.push(replaceAttributeUri(line, keyFile));
      continue;
    }

    if (line.startsWith('#')) {
      rewrittenLines.push(line);
      continue;
    }

    const segmentUrl = new URL(line, playlistUrl).href;
    segmentUrls.push(segmentUrl);
    const segmentFile = addAsset(segmentUrl, 'seg', '.ts');
    rewrittenLines.push(segmentFile);
  }

  return {
    assets,
    segmentUrls,
    hasEncryption,
    playlistText: `${rewrittenLines.join('\n')}\n`,
  };
}

async function downloadAssets(assets, requestId) {
  const assetDataByName = new Map();
  const segmentDataByUrl = new Map();
  const total = assets.length;

  for (let i = 0; i < total; i++) {
    const asset = assets[i];
    const data = await fetchBinary(asset.url);

    assetDataByName.set(asset.fileName, data);
    if (asset.kind === 'seg') {
      segmentDataByUrl.set(asset.url, data);
    }

    if (i === 0 || i === total - 1 || (i + 1) % 5 === 0) {
      sendProgress({ phase: 'download', current: i + 1, total, requestId });
    }
  }

  return { assetDataByName, segmentDataByUrl };
}

function ensureFfmpegApi() {
  const api = globalThis.FFmpegWASM || globalThis.FFmpeg;
  if (!api || typeof api.FFmpeg !== 'function') {
    throw new Error('ffmpeg.wasm API の読み込みに失敗しました (FFmpegWASM.FFmpeg)');
  }
  return api;
}

async function ensureFfmpegLoaded() {
  if (ffmpegLoaded) return;

  if (!ffmpegLoadingPromise) {
    ffmpegLoadingPromise = (async () => {
      const api = ensureFfmpegApi();
      if (!ffmpeg) {
        ffmpeg = new api.FFmpeg();
      }

      await ffmpeg.load({
        coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm'),
      });
      ffmpegLoaded = true;
    })().catch((err) => {
      ffmpegLoadingPromise = null;
      throw err;
    });
  }

  await ffmpegLoadingPromise;
}

async function safeDelete(fileName) {
  if (!ffmpeg) return;
  try {
    await ffmpeg.deleteFile(fileName);
  } catch (_) {
    // 既に消えている場合は無視
  }
}

async function remuxToMp4(bundle, assetDataByName) {
  await ensureFfmpegLoaded();

  const writtenFiles = [];

  try {
    for (const [fileName, data] of assetDataByName.entries()) {
      await ffmpeg.writeFile(fileName, data);
      writtenFiles.push(fileName);
    }

    await ffmpeg.writeFile(INPUT_PLAYLIST_FILE, encoder.encode(bundle.playlistText));
    writtenFiles.push(INPUT_PLAYLIST_FILE);
    await safeDelete(OUTPUT_MP4_FILE);

    const exitCode = await ffmpeg.exec([
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,crypto,data',
      '-i', INPUT_PLAYLIST_FILE,
      '-c', 'copy',
      '-movflags', '+faststart',
      OUTPUT_MP4_FILE,
    ]);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg 変換失敗 (exit=${exitCode})`);
    }

    const output = await ffmpeg.readFile(OUTPUT_MP4_FILE);
    const copied = output instanceof Uint8Array
      ? output.slice()
      : new Uint8Array(output);
    return copied;
  } finally {
    await safeDelete(OUTPUT_MP4_FILE);
    for (const fileName of writtenFiles) {
      await safeDelete(fileName);
    }
  }
}

function buildTsFallback(bundle, segmentDataByUrl) {
  if (bundle.hasEncryption) return null;

  const chunks = [];
  for (const segmentUrl of bundle.segmentUrls) {
    const data = segmentDataByUrl.get(segmentUrl);
    if (!data) return null;
    chunks.push(data);
  }

  if (chunks.length === 0) return null;
  return mergeUint8Arrays(chunks);
}

async function downloadFromM3U8(m3u8Url, requestId) {
  try {
    sendProgress({ phase: 'init', current: 0, total: 0, requestId });

    const mediaPlaylist = await resolveMediaPlaylist(m3u8Url);
    const bundle = buildLocalPlaylistBundle(
      mediaPlaylist.playlistUrl,
      mediaPlaylist.lines
    );

    if (bundle.assets.length === 0) {
      throw new Error('セグメントが見つかりません');
    }

    const { assetDataByName, segmentDataByUrl } = await downloadAssets(bundle.assets, requestId);

    try {
      sendProgress({ phase: 'init', current: 0, total: 0, requestId });
      const mp4Data = await remuxToMp4(bundle, assetDataByName);

      const mp4Blob = new Blob([mp4Data], { type: 'video/mp4' });
      const mp4BlobUrl = URL.createObjectURL(mp4Blob);
      scheduleBlobRevoke(mp4BlobUrl);

      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.conversionComplete,
        requestId,
        success: true,
        blobUrl: mp4BlobUrl,
        outputType: 'mp4',
      });
      return;
    } catch (ffmpegError) {
      console.warn('[ZenstudyTool Offscreen] MP4変換失敗、TSフォールバックを試行:', ffmpegError);
    }

    const tsData = buildTsFallback(bundle, segmentDataByUrl);
    if (!tsData) {
      if (bundle.hasEncryption) {
        throw new Error('暗号化HLSのためTSフォールバック不可です。MP4変換に失敗しました');
      }
      throw new Error('MP4変換に失敗し、TSフォールバックもできません');
    }

    const tsBlob = new Blob([tsData], { type: 'video/mp2t' });
    const tsBlobUrl = URL.createObjectURL(tsBlob);
    scheduleBlobRevoke(tsBlobUrl);

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.conversionComplete,
      requestId,
      success: true,
      blobUrl: tsBlobUrl,
      outputType: 'ts',
    });
  } catch (err) {
    console.error('[ZenstudyTool Offscreen] エラー:', err);
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.conversionComplete,
      requestId,
      success: false,
      error: err.message,
    });
  }
}

async function prepareDirectMp4(mp4Url, requestId) {
  try {
    sendProgress({ phase: 'init', current: 0, total: 0, requestId });
    const mp4Data = await fetchBinary(mp4Url);
    const mp4Blob = new Blob([mp4Data], { type: 'video/mp4' });
    const mp4BlobUrl = URL.createObjectURL(mp4Blob);
    scheduleBlobRevoke(mp4BlobUrl);

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.conversionComplete,
      requestId,
      success: true,
      blobUrl: mp4BlobUrl,
      outputType: 'mp4',
    });
  } catch (err) {
    console.error('[ZenstudyTool Offscreen] Direct MP4 preparation error:', err);
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.conversionComplete,
      requestId,
      success: false,
      error: err.message,
    });
  }
}

// ============================================================
// メッセージ受信
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MESSAGE_TYPES.convertM3u8) {
    // メッセージタイプ名は互換性のため維持
    enqueueConversion(() => downloadFromM3U8(message.m3u8Url, message.requestId));
    return;
  }

  if (message.type === MESSAGE_TYPES.prepareDirectMp4) {
    enqueueConversion(() => prepareDirectMp4(message.mp4Url, message.requestId));
    return;
  }

  if (message.type === MESSAGE_TYPES.revokeBlobUrl) {
    revokeBlobUrl(message.blobUrl);
  }
});
