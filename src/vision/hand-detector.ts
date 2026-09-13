/**
 * MediaPipe HandLandmarker 手先検出・トラッキングモジュール
 * カメラ映像から21点の手のランドマークを取得し、GPU優先推論で高速に処理します。
 */

import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface FingerTipLandmark {
  index: number;      // 指先ランドマーク番号 (4, 8, 12, 16, 20)
  mcpIndex: number;   // 根元MCPランドマーク番号 (2, 5, 9, 13, 17)
  pipIndex: number;   // 第2関節 (3, 6, 10, 14, 18)
  dipIndex: number;   // 第1関節 (3, 7, 11, 15, 19)
  name: 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
  rawCameraPx: { x: number; y: number; z: number }; // カメラ生ピクセル座標
  rawMcpCameraPx: { x: number; y: number; z: number };
  rawPipCameraPx: { x: number; y: number; z: number };
  rawDipCameraPx: { x: number; y: number; z: number };
}

export interface HandDetectionResult {
  detected: boolean;
  landmarks: NormalizedLandmark[];
  handLengthPx: number; // 手の基準長 L_hand = ||MCP_9 - Wrist_0|| [px]
  handVector: { x: number; y: number }; // 手首 -> 中指MCP の方向ベクトル
  fingers: FingerTipLandmark[];
  timestampMs: number;
}

/** 5指の全関節ランドマークインデックス対応 */
export const FINGER_INDICES = [
  { name: 'thumb' as const, tip: 4, dip: 3, pip: 2, mcp: 1 }, // 親指: TIP, IP, MCP, CMC
  { name: 'index' as const, tip: 8, dip: 7, pip: 6, mcp: 5 },
  { name: 'middle' as const, tip: 12, dip: 11, pip: 10, mcp: 9 },
  { name: 'ring' as const, tip: 16, dip: 15, pip: 14, mcp: 13 },
  { name: 'pinky' as const, tip: 20, dip: 19, pip: 18, mcp: 17 },
];

export class HandDetector {
  private static instance: HandDetector | null = null;

  private landmarker: HandLandmarker | null = null;
  private isLoaded: boolean = false;
  private isLoading: boolean = false;
  private lastTimestampMs: number = -1;

  private constructor() {}

  public static getInstance(): HandDetector {
    if (!HandDetector.instance) {
      HandDetector.instance = new HandDetector();
    }
    return HandDetector.instance;
  }

  /**
   * MediaPipe HandLandmarker モデルの初期化（GPU優先、失敗時CPUフォールバック）
   */
  public async init(): Promise<boolean> {
    if (this.isLoaded && this.landmarker) return true;
    if (this.isLoading) return false;

    this.isLoading = true;

    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
      );

      const modelUrl =
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

      // 1. GPU デリゲートの試行
      try {
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelUrl,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.35,
          minHandPresenceConfidence: 0.35,
          minTrackingConfidence: 0.35,
        });
        console.log('[HandDetector] GPUデリゲートで初期化成功');
      } catch (gpuErr) {
        console.warn('[HandDetector] GPU初期化失敗、CPUデリゲートにフォールバック:', gpuErr);
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelUrl,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.35,
          minHandPresenceConfidence: 0.35,
          minTrackingConfidence: 0.35,
        });
        console.log('[HandDetector] CPUデリゲートで初期化成功');
      }

      this.isLoaded = true;
      this.isLoading = false;
      return true;
    } catch (err) {
      console.error('[HandDetector] 初期化エラー:', err);
      this.isLoading = false;
      return false;
    }
  }

  /**
   * ビデオ要素から手のランドマークを推論し、ピクセル座標および基準長を返します。
   */
  public detect(video: HTMLVideoElement, timestampMs: number): HandDetectionResult {
    const emptyResult: HandDetectionResult = {
      detected: false,
      landmarks: [],
      handLengthPx: 0,
      handVector: { x: 0, y: 0 },
      fingers: [],
      timestampMs,
    };

    if (!this.isLoaded || !this.landmarker || video.readyState < 2) {
      return emptyResult;
    }

    // 単調増加タイムスタンプの保証
    let currentTs = timestampMs;
    if (currentTs <= this.lastTimestampMs) {
      currentTs = this.lastTimestampMs + 1;
    }
    this.lastTimestampMs = currentTs;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return emptyResult;

    try {
      const result = this.landmarker.detectForVideo(video, currentTs);

      if (!result.landmarks || result.landmarks.length === 0) {
        return emptyResult;
      }

      const hand = result.landmarks[0]; // 1手目

      // 基準長 L_hand: 手首(0) と 中指MCP(9) の画面ピクセル距離
      const wrist = hand[0];
      const middleMcp = hand[9];
      const wristPx = { x: wrist.x * width, y: wrist.y * height };
      const mcpPx = { x: middleMcp.x * width, y: middleMcp.y * height };
      const handLengthPx = Math.hypot(mcpPx.x - wristPx.x, mcpPx.y - wristPx.y);

      // 手首 -> 中指MCP の方向ベクトル
      const handVector = {
        x: mcpPx.x - wristPx.x,
        y: mcpPx.y - wristPx.y,
      };

      // 5指の生カメラピクセル座標
      const fingers: FingerTipLandmark[] = FINGER_INDICES.map((f) => {
        const tipLm = hand[f.tip];
        const dipLm = hand[f.dip];
        const pipLm = hand[f.pip];
        const mcpLm = hand[f.mcp];
        return {
          index: f.tip,
          dipIndex: f.dip,
          pipIndex: f.pip,
          mcpIndex: f.mcp,
          name: f.name,
          rawCameraPx: {
            x: tipLm.x * width,
            y: tipLm.y * height,
            z: tipLm.z * width,
          },
          rawDipCameraPx: {
            x: dipLm.x * width,
            y: dipLm.y * height,
            z: dipLm.z * width,
          },
          rawPipCameraPx: {
            x: pipLm.x * width,
            y: pipLm.y * height,
            z: pipLm.z * width,
          },
          rawMcpCameraPx: {
            x: mcpLm.x * width,
            y: mcpLm.y * height,
            z: mcpLm.z * width,
          },
        };
      });

      return {
        detected: true,
        landmarks: hand,
        handLengthPx,
        handVector,
        fingers,
        timestampMs: currentTs,
      };
    } catch (err) {
      console.warn('[HandDetector] 推論エラー:', err);
      return emptyResult;
    }
  }

  public get ready(): boolean {
    return this.isLoaded && this.landmarker !== null;
  }
}
