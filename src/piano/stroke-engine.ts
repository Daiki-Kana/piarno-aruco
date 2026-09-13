/**
 * 二重座標系・正規化打鍵判定ステートマシンモジュール
 * カメラ生座標系での指の屈曲量（手の基準長 L_hand で正規化）を監視し、
 * 打鍵（Triggered）の瞬間のみホモグラフィ行列 H でA4平面座標へ射影して白鍵ヒット判定を行います。
 * 描画用（1 Euro Filter）と判定用（生値）の二重パイプラインにより、視差・遅延を完全にゼロにします。
 */

import { Point2D, Matrix3x3, applyHomography } from '../calibration/homography';
import { Calibrator } from '../calibration/calibrator';
import { KEYBOARD_CONFIG } from './keyboard';
import { WebAudioPianoSynth } from '../audio/synth';
import { HandDetectionResult, FingerTipLandmark } from '../vision/hand-detector';
import { OneEuroFilter2D } from '../vision/one-euro-filter';

export enum FingerStrokeState {
  IDLE = 'IDLE',           // 浮遊・静止
  STRIKING = 'STRIKING',   // 下降動作中（打鍵意図検知）
  IMPACT = 'IMPACT',       // 速度ピーク到達・打撃先行発火 (Note On)
  REBOUND = 'REBOUND',     // 離鍵待機・跳ね返り (再発音完全ロック)
  // レガシー互換エイリアス
  HOVER = 'IDLE',
  TRIGGERED = 'IMPACT',
  HOLDING = 'REBOUND',
  RELEASING = 'IDLE',
}

export interface FingerTrackState {
  name: 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
  state: FingerStrokeState;
  normalizedDisplacement: number; // HUD表示用の正規化速度または変位
  rawCameraPx: Point2D;          // 打鍵判定用の生座標（遅延ゼロ）
  filteredCameraPx: Point2D;     // 描画用の平滑化座標 (1 Euro Filter)
  pressedKeyIndex: number;       // 現在押下中の鍵盤インデックス (-1: なし)
  hitPointMm?: Point2D;          // 発音瞬間のA4平面座標 [mm]
  // 速度ピーク・打撃先行トラッキング
  prevRawY: number;
  prevTimeMs: number;
  velocityY: number;             // 現フレームの正規化下向き速度 [1/s]
  prevVelocityY: number;         // 直前フレームの正規化下向き速度 [1/s]
  peakVelocityY: number;         // 下降中の最大速度 [1/s]
  strikeImpactY: number;         // 打鍵発音時の生Y座標 [px]
  lastStrikeTimeMs: number;      // 最終発音タイムスタンプ [ms]
}

/**
 * 外部チューニング可能パラメータ (STROKE_CONFIG)
 * 実機環境や演奏者のプレイスタイルに合わせて即座に微調整可能
 */
export const STROKE_CONFIG = {
  // 振り下ろしとみなす最低下向き速度 [1/s] (手の基準長 L_hand に対する1秒間の移動量比)
  minStrikeVelocity: 1.6,
  // 親指用の最低下向き速度 [1/s] (親指の可動域特性に合わせてやや緩めに設定)
  minStrikeVelocityThumb: 1.2,
  // 打鍵後の再発火防止インターバル [ms] (チャタリング・二重発音の防止)
  reboundCooldownMs: 90,
  // 離鍵（Note Off）とみなす上昇速度 [1/s] (上向き速度のため負の値)
  releaseVelocityThreshold: -0.4,
  // 離鍵とみなす指先の上昇リフト量 [px]
  liftReleaseMarginPx: 12.0,
};

export class StrokeEngine {
  private static instance: StrokeEngine | null = null;

  // 5指それぞれのステートと1 Euro Filter
  private fingerStates: Map<string, FingerTrackState> = new Map();
  private fingerFilters: Map<string, OneEuroFilter2D> = new Map();

  // 現在押下状態にある白鍵インデックスのセット（AR鍵盤の発光描画用）
  private activePressedKeys: Set<number> = new Set();

  private synth: WebAudioPianoSynth;

  private constructor() {
    this.synth = WebAudioPianoSynth.getInstance();

    const fingerNames: ('thumb' | 'index' | 'middle' | 'ring' | 'pinky')[] = [
      'thumb',
      'index',
      'middle',
      'ring',
      'pinky',
    ];

    for (const name of fingerNames) {
      this.fingerStates.set(name, {
        name,
        state: FingerStrokeState.IDLE,
        normalizedDisplacement: 0,
        rawCameraPx: { x: 0, y: 0 },
        filteredCameraPx: { x: 0, y: 0 },
        pressedKeyIndex: -1,
        prevRawY: 0,
        prevTimeMs: 0,
        velocityY: 0,
        prevVelocityY: 0,
        peakVelocityY: 0,
        strikeImpactY: 0,
        lastStrikeTimeMs: 0,
      });

      this.fingerFilters.set(
        name,
        new OneEuroFilter2D({ minCutoff: 1.2, beta: 0.12, dCutoff: 1.0 })
      );
    }
  }

  public static getInstance(): StrokeEngine {
    if (!StrokeEngine.instance) {
      StrokeEngine.instance = new StrokeEngine();
    }
    return StrokeEngine.instance;
  }

  /**
   * 毎フレームの手先推論結果を受け取り、5指の打鍵判定と描画フィルタを更新します。
   */
  public update(detection: HandDetectionResult, homography: Matrix3x3 | null): void {
    if (!detection.detected || detection.handLengthPx <= 0) {
      // 手が画面外に外れた場合は、発音中の音をすべてリリース
      this.releaseAllFingers();
      return;
    }

    const { handLengthPx, fingers, timestampMs } = detection;

    for (const finger of fingers) {
      this.updateFinger(finger, handLengthPx, timestampMs, homography);
    }
  }

  /**
   * 単一指の打鍵ステートマシン更新（打撃先行・速度ピーク発火モデル）
   */
  private updateFinger(
    finger: FingerTipLandmark,
    handLengthPx: number,
    timestampMs: number,
    homography: Matrix3x3 | null
  ): void {
    const track = this.fingerStates.get(finger.name);
    const filter = this.fingerFilters.get(finger.name);
    if (!track || !filter) return;

    // 1. 生座標（遅延ゼロ）の記録と描画用フィルタ座標の算出
    const rawPx: Point2D = { x: finger.rawCameraPx.x, y: finger.rawCameraPx.y };
    track.rawCameraPx = rawPx;
    track.filteredCameraPx = filter.filter(rawPx.x, rawPx.y, timestampMs);

    // 2. 指先速度の算出 (1階微分: 手の基準長 L_hand で正規化した下向き速度 [1/s])
    const dt = track.prevTimeMs > 0 ? (timestampMs - track.prevTimeMs) : 16;
    const lHand = Math.max(10.0, handLengthPx);
    let vy = 0;
    if (dt > 3) {
      // (Δy / dt) * 1000 = px/s, これを lHand で除算して正規化速度 [1/s]
      const vyPxPerSec = ((rawPx.y - track.prevRawY) / dt) * 1000;
      vy = vyPxPerSec / lHand;
      track.prevVelocityY = track.velocityY;
      track.velocityY = vy;
      track.prevRawY = rawPx.y;
      track.prevTimeMs = timestampMs;
    }

    // HUD表示用: 正規化速度 [1/s]
    track.normalizedDisplacement = Math.max(-5, Math.min(10, vy));

    // 指ごとの最低ストローク速度閾値
    const isThumb = finger.name === 'thumb';
    const minStrikeVel = isThumb
      ? STROKE_CONFIG.minStrikeVelocityThumb
      : STROKE_CONFIG.minStrikeVelocity;

    // 3. 打撃先行ステートマシン (IDLE → STRIKING → IMPACT → REBOUND)
    switch (track.state) {
      // ─────────────────────────────────────────────
      // 1. IDLE: 浮遊・静止
      // ─────────────────────────────────────────────
      case FingerStrokeState.IDLE: {
        // 下降開始検知: 速度が最低ストローク速度の半分を超えたら打鍵動作開始（STRIKING）
        if (vy >= minStrikeVel * 0.5) {
          track.state = FingerStrokeState.STRIKING;
          track.peakVelocityY = vy;
        }
        break;
      }

      // ─────────────────────────────────────────────
      // 2. STRIKING: 振り下ろし動作中（速度ピーク追跡）
      // ─────────────────────────────────────────────
      case FingerStrokeState.STRIKING: {
        if (vy > track.peakVelocityY) {
          track.peakVelocityY = vy;
        }

        // 速度ピーク到達判定:
        // ① 十分な下向き速度: 直前フレームまたは現フレームが minStrikeVel 以上
        // ② 速度ピーク到達（減速への転換）: 直前フレームより加速し、現フレームで速度増加が頭打ち・減少に転じたこと
        const isSpeedPeak = track.prevVelocityY >= minStrikeVel && vy <= track.prevVelocityY;
        const isCooldownElapsed = (timestampMs - track.lastStrikeTimeMs) > STROKE_CONFIG.reboundCooldownMs;

        // 物理接触の変形完了を待たず、速度ピーク境界フレームで即座に打鍵発音（打撃先行モデル）
        if (isSpeedPeak && isCooldownElapsed) {
          // ③ 鍵盤エリア内判定
          if (homography && Calibrator.isCalibrated) {
            const hitMm = applyHomography(homography, rawPx);
            const hitKeyIndex = this.findHitKeyIndex(hitMm);

            if (hitKeyIndex !== -1) {
              // ─── [IMPACT] 打撃先行発火（速度ピーク瞬間の Note On） ───
              track.state = FingerStrokeState.IMPACT;
              track.hitPointMm = hitMm;
              track.pressedKeyIndex = hitKeyIndex;
              track.strikeImpactY = rawPx.y;
              track.lastStrikeTimeMs = timestampMs;
              this.activePressedKeys.add(hitKeyIndex);

              // 音声発音トリガー
              this.synth.triggerKeyIndexOn(hitKeyIndex);

              // 直ちに REBOUND へ遷移（同一ストロークでの多重発火を完全ロック）
              track.state = FingerStrokeState.REBOUND;
              break;
            }
          }
        }

        // 下降が失速して最低速度に達せず、上向きまたは停止した場合のキャンセル
        if (vy < minStrikeVel * 0.2 && track.prevVelocityY < minStrikeVel) {
          track.state = FingerStrokeState.IDLE;
          track.peakVelocityY = 0;
        }
        break;
      }

      // ─────────────────────────────────────────────
      // 3. IMPACT: 発音瞬間（直ちに REBOUND へ）
      // ─────────────────────────────────────────────
      case FingerStrokeState.IMPACT: {
        track.state = FingerStrokeState.REBOUND;
        break;
      }

      // ─────────────────────────────────────────────
      // 4. REBOUND: 跳ね返り・離鍵待機（再発音完全ロック）
      // ─────────────────────────────────────────────
      case FingerStrokeState.REBOUND: {
        // 離鍵条件:
        // ① 指先の速度が上向きに転じた (vy <= releaseVelocityThreshold)
        const hasLiftVelocity = vy <= STROKE_CONFIG.releaseVelocityThreshold;

        // ② 指先が打鍵位置から一定量上方にリフトアップした
        const hasLiftedDistance = (track.strikeImpactY - rawPx.y) >= STROKE_CONFIG.liftReleaseMarginPx;

        // ③ 鍵領域から外れた
        let isOutOfKey = false;
        if (homography && Calibrator.isCalibrated) {
          const currentMm = applyHomography(homography, rawPx);
          const currentKeyIndex = this.findHitKeyIndex(currentMm);
          if (currentKeyIndex !== track.pressedKeyIndex) {
            isOutOfKey = true;
          }
        }

        if (hasLiftVelocity || hasLiftedDistance || isOutOfKey) {
          this.releaseFinger(track);
        }
        break;
      }
    }
  }

  /**
   * 指の離鍵・消音処理
   */
  private releaseFinger(track: FingerTrackState): void {
    track.state = FingerStrokeState.IDLE;

    if (track.pressedKeyIndex !== -1) {
      this.synth.triggerKeyIndexOff(track.pressedKeyIndex);
      this.activePressedKeys.delete(track.pressedKeyIndex);
      track.pressedKeyIndex = -1;
      track.hitPointMm = undefined;
    }
  }

  /**
   * 全指の強制リリース
   */
  public releaseAllFingers(): void {
    for (const track of this.fingerStates.values()) {
      if (track.state !== FingerStrokeState.IDLE) {
        this.releaseFinger(track);
        track.state = FingerStrokeState.IDLE;
      }
    }
    this.activePressedKeys.clear();
  }

  /**
   * A4平面座標（mm）から該当する白鍵インデックス（0〜13）を判定
   * 演奏性を高めるため、境界線付近に許容マージン（Y方向±25mm、X方向±15mm）を設けています。
   */
  public findHitKeyIndex(ptMm: Point2D): number {
    const { numKeys, keyWidthMm, keyLengthMm, originX_Mm, originY_Mm } = KEYBOARD_CONFIG;

    // Y方向の許容マージンチェック（前後25mm拡張）
    const marginY = 25.0;
    if (ptMm.y < originY_Mm - marginY || ptMm.y > originY_Mm + keyLengthMm + marginY) {
      return -1;
    }

    // X方向の許容マージンチェック（左右15mm拡張）
    const marginX = 15.0;
    const totalWidth = numKeys * keyWidthMm;
    if (ptMm.x < originX_Mm - marginX || ptMm.x > originX_Mm + totalWidth + marginX) {
      return -1;
    }

    // クランプして最近傍の白鍵インデックスに吸着
    const clampedX = Math.min(Math.max(ptMm.x, originX_Mm), originX_Mm + totalWidth - 0.01);
    const index = Math.floor((clampedX - originX_Mm) / keyWidthMm);
    if (index >= 0 && index < numKeys) {
      return index;
    }

    return -1;
  }

  /**
   * 現在押下中のキーインデックス一覧（描画用）
   */
  public getPressedKeys(): Set<number> {
    return this.activePressedKeys;
  }

  /**
   * 5指の追跡状態リスト（描画・デバッグ用）
   */
  public getFingerTracks(): FingerTrackState[] {
    return Array.from(this.fingerStates.values());
  }
}
