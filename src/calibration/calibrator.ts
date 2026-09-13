/**
 * ワンタイム・ArUcoキャリブレーションモジュール
 * カメラフレームからID 0〜3のArUcoマーカーを検出し、A4物理実寸座標系への
 * ホモグラフィ変換行列 H およびその逆行列 H^-1 を1回だけ算出して静的保持します。
 * 算出完了後、検出インスタンスは即時破棄されます。
 */

import jsArucoPkg from 'js-aruco2';
import 'js-aruco2/src/dictionaries/aruco_5x5_1000.js';
import {
  computeHomography,
  invertMatrix3x3,
  applyHomography,
  Matrix3x3,
  Point2D,
  PointCorrespondence,
} from './homography';

// CJS/ESM 互換のための AR 参照取得
const AR = (jsArucoPkg as any).AR || jsArucoPkg;

/**
 * A4用紙上のArUcoマーカー中心の物理座標（単位: mm）
 * マーカーサイズ 27.5mm x 27.5mm、用紙端オフセット 10mm
 */
export const A4_MARKER_TARGET_CENTERS: Record<number, Point2D> = {
  0: { x: 23.75, y: 23.75 },   // ID 0: 左上 (10 + 13.75, 10 + 13.75)
  1: { x: 273.25, y: 23.75 },  // ID 1: 右上 (259.5 + 13.75, 10 + 13.75)
  2: { x: 273.25, y: 186.25 }, // ID 2: 右下 (259.5 + 13.75, 172.5 + 13.75)
  3: { x: 23.75, y: 186.25 },  // ID 3: 左下 (10 + 13.75, 172.5 + 13.75)
};

/** A4用紙の実寸（ミリメートル） */
export const A4_PAPER_WIDTH_MM = 297;
export const A4_PAPER_HEIGHT_MM = 210;

export interface CalibrationResult {
  success: boolean;
  message: string;
  detectedIds: number[];
  homography?: Matrix3x3;
  invHomography?: Matrix3x3;
  paperCornersInCamera?: Point2D[];
  markerCentersInCamera?: Record<number, Point2D>;
}

export class Calibrator {
  // 静的保持用プロパティ（ワンタイム保持）
  public static homography: Matrix3x3 | null = null;
  public static invHomography: Matrix3x3 | null = null;
  public static paperCornersInCamera: Point2D[] | null = null;
  public static markerCentersInCamera: Record<number, Point2D> | null = null;
  public static isCalibrated: boolean = false;

  /**
   * 現在のカメラ映像からワンタイムでArUco検出とホモグラフィ算出を行います。
   * @param video 対象のビデオ要素
   * @returns キャリブレーション結果
   */
  public static calibrateFromVideo(video: HTMLVideoElement): CalibrationResult {
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      return {
        success: false,
        message: 'カメラ映像のフレームサイズが取得できませんでした。',
        detectedIds: [],
      };
    }

    // 検出用の処理解像度（最大幅1280pxに調整し、検出精度・速度を最適化）
    const maxProcessWidth = 1280;
    const scale = width > maxProcessWidth ? maxProcessWidth / width : 1.0;
    const processWidth = Math.round(width * scale);
    const processHeight = Math.round(height * scale);

    // 一時的なオフスクリーンCanvasで画像データを取得
    let offscreenCanvas: HTMLCanvasElement | null = document.createElement('canvas');
    offscreenCanvas.width = processWidth;
    offscreenCanvas.height = processHeight;

    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      offscreenCanvas = null;
      return {
        success: false,
        message: 'Canvas 2D コンテキストの作成に失敗しました。',
        detectedIds: [],
      };
    }

    ctx.drawImage(video, 0, 0, processWidth, processHeight);
    const imageData = ctx.getImageData(0, 0, processWidth, processHeight);

    // 一時Canvasの参照を破棄
    offscreenCanvas = null;

    // ArUcoディテクターの生成（OpenCV DICT_5X5_50 互換の ARUCO_5X5_1000 辞書）
    let detector: any = new AR.Detector({
      dictionaryName: 'ARUCO_5X5_1000',
    });

    // マーカー検出
    const markers = detector.detect(imageData);

    // 検出器インスタンスを即座に破棄・メモリ解放
    detector = null;

    const detectedMap = new Map<number, Point2D>();
    const detectedIds: number[] = [];

    // スケールを元のカメラ解像度座標に戻す係数
    const invScale = 1.0 / scale;

    console.log(`[ArUco] 検出マーカー総数: ${markers.length}`, markers.map((m: any) => ({ id: m.id, dist: m.hammingDistance })));

    for (const marker of markers) {
      const id = marker.id;
      if (id >= 0 && id <= 3 && !detectedMap.has(id)) {
        // 4隅のコーナーから中心座標を算出し、元のカメラ解像度座標に復元
        const c = marker.corners;
        const centerX = ((c[0].x + c[1].x + c[2].x + c[3].x) / 4) * invScale;
        const centerY = ((c[0].y + c[1].y + c[2].y + c[3].y) / 4) * invScale;
        detectedMap.set(id, { x: centerX, y: centerY });
        detectedIds.push(id);
      }
    }

    // 4つのマーカー（ID 0, 1, 2, 3）がすべて揃っているか検証
    const missingIds: number[] = [];
    for (let id = 0; id <= 3; id++) {
      if (!detectedMap.has(id)) {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      return {
        success: false,
        message: `4点中 ${detectedIds.length} 個検出（未検出ID: ${missingIds.join(', ')}）。四隅のマーカーを用紙全体が映るように合わせてください。`,
        detectedIds,
      };
    }

    // 4組の対応点リストの構築
    // カメラ座標 (u, v) -> A4物理座標 (X, Y)
    const correspondences: PointCorrespondence[] = [];
    const markerCenters: Record<number, Point2D> = {};

    for (let id = 0; id <= 3; id++) {
      const srcPoint = detectedMap.get(id)!;
      const tgtPoint = A4_MARKER_TARGET_CENTERS[id];
      correspondences.push({
        source: srcPoint,
        target: tgtPoint,
      });
      markerCenters[id] = srcPoint;
    }

    // DLTによるホモグラフィ行列 H の算出
    const H = computeHomography(correspondences);
    if (!H) {
      return {
        success: false,
        message: 'ホモグラフィ変換行列の幾何学計算に失敗しました。',
        detectedIds,
      };
    }

    // 逆行列 H^-1 の算出
    const H_inv = invertMatrix3x3(H);
    if (!H_inv) {
      return {
        success: false,
        message: 'ホモグラフィ逆行列の算出に失敗しました。',
        detectedIds,
      };
    }

    // A4用紙の4隅物理座標 (0,0), (297,0), (297,210), (0,210) をカメラ座標系に逆投影
    const paperCornersMm: Point2D[] = [
      { x: 0, y: 0 },
      { x: A4_PAPER_WIDTH_MM, y: 0 },
      { x: A4_PAPER_WIDTH_MM, y: A4_PAPER_HEIGHT_MM },
      { x: 0, y: A4_PAPER_HEIGHT_MM },
    ];

    const paperCornersInCam = paperCornersMm.map((p) => applyHomography(H_inv, p));

    // メモリに静的保持
    Calibrator.homography = H;
    Calibrator.invHomography = H_inv;
    Calibrator.paperCornersInCamera = paperCornersInCam;
    Calibrator.markerCentersInCamera = markerCenters;
    Calibrator.isCalibrated = true;

    return {
      success: true,
      message: 'キャリブレーション完了: A4ホモグラフィ行列を算出・保持しました。',
      detectedIds,
      homography: H,
      invHomography: H_inv,
      paperCornersInCamera: paperCornersInCam,
      markerCentersInCamera: markerCenters,
    };
  }

  /**
   * カメラ上の座標 (u, v) を A4用紙実寸座標 (X, Y) [mm] に変換します。
   */
  public static cameraToA4(u: number, v: number): Point2D | null {
    if (!Calibrator.homography) return null;
    return applyHomography(Calibrator.homography, { x: u, y: v });
  }

  /**
   * A4用紙実寸座標 (X, Y) [mm] をカメラ座標 (u, v) [px] に変換します。
   */
  public static a4ToCamera(X: number, Y: number): Point2D | null {
    if (!Calibrator.invHomography) return null;
    return applyHomography(Calibrator.invHomography, { x: X, y: Y });
  }

  /**
   * 静的保持しているキャリブレーションデータをクリアします。
   */
  public static reset(): void {
    Calibrator.homography = null;
    Calibrator.invHomography = null;
    Calibrator.paperCornersInCamera = null;
    Calibrator.markerCentersInCamera = null;
    Calibrator.isCalibrated = false;
  }
}
