/**
 * PiARno2 メインエントリーポイント
 * アプリケーションの初期化、カメラループ、ワンタイム・ArUcoキャリブレーション、
 * およびA4印刷ビューの連携を統括します。
 */

import { CameraManager } from './vision/camera';
import { Calibrator } from './calibration/calibrator';
import { CanvasOverlay } from './renderer/canvas-overlay';
import { PrintView } from './renderer/print-view';
import { KeyboardProjector } from './piano/keyboard';
import { WebAudioPianoSynth } from './audio/synth';
import { HandDetector } from './vision/hand-detector';
import { StrokeEngine } from './piano/stroke-engine';

// シングルトンインスタンスの取得
const synth = WebAudioPianoSynth.getInstance();
const handDetector = HandDetector.getInstance();
const strokeEngine = StrokeEngine.getInstance();

// DOM読み込み完了時の初期化
document.addEventListener('DOMContentLoaded', async () => {
  // DOM要素の参照取得
  const videoEl = document.getElementById('camera-video') as HTMLVideoElement | null;
  const canvasEl = document.getElementById('overlay-canvas') as HTMLCanvasElement | null;
  const calibrateBtn = document.getElementById('calibrate-btn') as HTMLButtonElement | null;
  const statusMsgEl = document.getElementById('status-message') as HTMLElement | null;
  const audioGuideBannerEl = document.getElementById('audio-guide-banner') as HTMLElement | null;

  // 印刷ビュー関連要素
  const openPrintBtn = document.getElementById('open-print-btn') as HTMLButtonElement | null;
  const backBtn = document.getElementById('back-btn') as HTMLButtonElement | null;
  const printBtn = document.getElementById('print-btn') as HTMLButtonElement | null;
  const downloadPdfBtn = document.getElementById('download-pdf-btn') as HTMLButtonElement | null;
  const printViewEl = document.getElementById('print-view') as HTMLElement | null;
  const sheetEl = document.getElementById('a4-sheet') as HTMLElement | null;
  const sheetContainerEl = document.getElementById('sheet-container') as HTMLElement | null;
  const markerSlots = Array.from(document.querySelectorAll<HTMLElement>('.marker-slot'));

  if (!videoEl || !canvasEl || !calibrateBtn || !statusMsgEl) {
    console.error('必要なDOM要素が見つかりませんでした。');
    return;
  }

  // バックグラウンドでHandLandmarkerモデルをロード
  handDetector.init().catch((err) => {
    console.warn('[main] HandDetector初期化待機中:', err);
  });

  // ユーザーの初回インタラクションでAudioContextをアンロック
  const unlockAudio = () => {
    synth.initAudio().then(() => {
      if (audioGuideBannerEl) {
        audioGuideBannerEl.classList.add('hidden');
      }
    });
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // オーバーレイ描画マネージャーの初期化
  const overlay = new CanvasOverlay(canvasEl);

  // キャンバス解像度を画面・ビデオに同期
  const syncCanvasSize = () => {
    const w = videoEl.videoWidth || window.innerWidth;
    const h = videoEl.videoHeight || window.innerHeight;
    overlay.resize(w, h);
  };
  window.addEventListener('resize', syncCanvasSize);
  syncCanvasSize();

  // 常時稼働レンダリングループ (60fps)
  const renderLoop = () => {
    syncCanvasSize();
    // 打鍵中キーのハイライトと、平滑化された指先ポインタを描画
    overlay.render(strokeEngine.getPressedKeys(), strokeEngine.getFingerTracks());
    requestAnimationFrame(renderLoop);
  };
  requestAnimationFrame(renderLoop);

  // カメラマネージャーの初期化（requestVideoFrameCallback 同期推論）
  const camera = new CameraManager({
    videoElement: videoEl,
    onFrame: (now) => {
      syncCanvasSize();

      // カメラフレーム到着時に同期してMediaPipe推論 & 打鍵判定を実行
      if (handDetector.ready && videoEl.readyState >= 2) {
        const detection = handDetector.detect(videoEl, now);
        strokeEngine.update(detection, Calibrator.homography);
      }
    },
  });

  // CALIBRATE ボタンのイベントリスナー（ワンタイム実行）
  calibrateBtn.addEventListener('click', () => {
    synth.initAudio(); // ボタンクリック時にもAudio初期化

    if (!videoEl.videoWidth || !videoEl.videoHeight) {
      showStatus(statusMsgEl, 'カメラ映像がまだ準備できていません。', 'error');
      return;
    }

    // ワンタイム・ArUco検出 & ホモグラフィ算出
    const result = Calibrator.calibrateFromVideo(videoEl);

    if (result.success) {
      // 成功時: 逆ホモグラフィ行列を用いてAR鍵盤頂点を事前射影・キャッシュ
      if (result.invHomography) {
        KeyboardProjector.updateProjection(result.invHomography);
      }

      showStatus(statusMsgEl, '✓ キャリブレーション完了（A4ホモグラフィ算出成功）', 'success');
      calibrateBtn.classList.add('calibrated');
      calibrateBtn.innerHTML = `
        <span class="btn-icon">✓</span>
        <span class="btn-label">CALIBRATED</span>
      `;
    } else {
      // 失敗時（未検出のIDを通知）
      showStatus(statusMsgEl, result.message, 'error');
    }
  });

  // 画面タップ/クリックによるAR鍵盤の音出しテスト（動作確認・演奏用）
  let activePointerKeyIndex = -1;

  const findKeyIndexAtPoint = (px: number, py: number): number => {
    const projectedKeys = KeyboardProjector.getProjectedKeys();
    if (!projectedKeys) return -1;

    // キャンバスの表示スケールを補正
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;
    const canvasX = (px - rect.left) * scaleX;
    const canvasY = (py - rect.top) * scaleY;

    for (let i = 0; i < projectedKeys.length; i++) {
      if (isPointInPolygon({ x: canvasX, y: canvasY }, projectedKeys[i].cornersCamera)) {
        return i;
      }
    }
    return -1;
  };

  canvasEl.addEventListener('pointerdown', (e) => {
    synth.initAudio();
    const keyIndex = findKeyIndexAtPoint(e.clientX, e.clientY);
    if (keyIndex !== -1) {
      activePointerKeyIndex = keyIndex;
      synth.triggerKeyIndexOn(keyIndex);
    }
  });

  const stopPointerKey = () => {
    if (activePointerKeyIndex !== -1) {
      synth.triggerKeyIndexOff(activePointerKeyIndex);
      activePointerKeyIndex = -1;
    }
  };

  canvasEl.addEventListener('pointerup', stopPointerKey);
  canvasEl.addEventListener('pointerleave', stopPointerKey);
  canvasEl.addEventListener('pointercancel', stopPointerKey);

  // 印刷ビューの初期化
  if (
    openPrintBtn &&
    backBtn &&
    printBtn &&
    printViewEl &&
    sheetEl &&
    sheetContainerEl &&
    markerSlots.length === 4
  ) {
    new PrintView({
      openButton: openPrintBtn,
      backButton: backBtn,
      printButton: printBtn,
      downloadPdfButton: downloadPdfBtn,
      printViewElement: printViewEl,
      sheetElement: sheetEl,
      sheetContainerElement: sheetContainerEl,
      markerSlotElements: markerSlots,
    });
  }

  // カメラストリームの開始（バックグラウンドで開始）
  camera.start().then((cameraStarted) => {
    if (!cameraStarted) {
      showStatus(statusMsgEl, 'カメラが検出されないか、権限が許可されていません。', 'error');
    }
  });
});

/**
 * 凸・凹多角形の内外判定（Ray Casting アルゴリズム）
 */
function isPointInPolygon(p: { x: number; y: number }, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

let statusTimeoutId: number | null = null;

/**
 * 画面中央下部に白黒ミニマルのステータスメッセージを表示
 */
function showStatus(el: HTMLElement, message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  if (statusTimeoutId !== null) {
    clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }

  el.textContent = message;
  el.className = `status-message ${type}`;

  // 4秒後にフェードアウト非表示
  statusTimeoutId = window.setTimeout(() => {
    el.classList.add('hidden');
    statusTimeoutId = null;
  }, 4000);
}

// 開発・テスト用グローバル参照
(window as any).__PIARNO_DEBUG__ = {
  Calibrator,
  KeyboardProjector,
  synth: WebAudioPianoSynth.getInstance(),
  handDetector,
  strokeEngine,
};
