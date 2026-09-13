/**
 * keystroke-analyzer.js - 物理接触・関節圧縮打鍵エンジン
 *
 * 固定ライン通過判定（touchThresholdY）を完全廃止し、
 * 「指先停止時の関節圧縮（MCP–Tip距離の短縮 L_norm）」と
 * 「4状態打鍵ステートマシン（IDLE → STRIKING → IMPACT → REBOUND）」による
 * 物理接触ベースの高精度打鍵判定を提供します。
 */

import { FINGER_INDICES, FINGER_NAMES } from './hand-tracker.js';
import { WHITE_KEYS, BLACK_KEYS } from './synth.js';
import { HandLandmarkFilterManager } from './one-euro-filter.js';
import { FingerKinematics, FINGER_JOINTS, distance2D } from './finger-kinematics.js';

/**
 * 4状態打鍵ステートマシン
 */
export const STATE = {
  IDLE: 'IDLE',           // 浮遊・静止
  STRIKING: 'STRIKING',   // 下降中（打鍵動作の開始）
  IMPACT: 'IMPACT',       // 物理接触・関節圧縮検知 → Note On 発火（1フレームのみ）
  REBOUND: 'REBOUND'      // 跳ね返り・離鍵待機（再発音完全ロック）
};

export class KeystrokeAnalyzer {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    // 1. 調整可能パラメータ（外部チューニング可能）
    this.params = {
      // 振り下ろしとみなす最低下向き速度 [1/s] (画面正規化座標ベース)
      minStrikeVelocity: 0.25,

      // 親指用の最低下向き速度 [1/s]
      minStrikeVelocityThumb: 0.18,

      // 離鍵判定: 指先の上向き速度（vy <= releaseVelocityThreshold で離鍵）
      releaseVelocityThreshold: -0.08,

      // 離鍵判定: 指先の上昇リフト量 [画面比率]
      liftReleaseMargin: 0.025,

      // チャタリング防止クールダウン時間 (ms)
      reboundCooldownMs: 90,

      // 1 Euro Filter パラメータ
      filterMinCutoff: 1.0,
      filterBeta: 0.007,

      // キネマティクス屈曲ゲート
      flexionEnabled: true,
      flexionThreshold: 12,

      // 鍵盤ライン・キー設定
      keyboardLeftX: 0.0,
      keyboardRightX: 1.0,
      blackKeyWidthRatio: 0.60
    };

    // 2. 指ごとの状態追跡（キー: 'Handedness_TipIndex'）
    this.fingerStates = new Map();

    // 3. 描画用アクティブキーハイライト
    this.activeKeyHighlights = new Map();

    // 4. イベントリスナー
    this.listeners = {
      noteOn: [],
      noteOff: []
    };

    // 5. サブシステム初期化
    this.landmarkFilterManager = new HandLandmarkFilterManager({
      freq: 30,
      minCutoff: this.params.filterMinCutoff,
      beta: this.params.filterBeta,
      dCutoff: 1.0
    });

    this.kinematics = new FingerKinematics();
  }

  // ─── イベントシステム ──────────────────────────────────────────────

  onNoteOn(callback) {
    this.listeners.noteOn.push(callback);
  }

  onNoteOff(callback) {
    this.listeners.noteOff.push(callback);
  }

  emitNoteOn(event) {
    for (const cb of this.listeners.noteOn) {
      try { cb(event); } catch (err) { console.error('noteOn コールバックエラー', err); }
    }
  }

  emitNoteOff(event) {
    for (const cb of this.listeners.noteOff) {
      try { cb(event); } catch (err) { console.error('noteOff コールバックエラー', err); }
    }
  }

  // ─── パラメータ更新 (外部/DebugPanelより) ──────────────────────────

  updateParams(newParams) {
    Object.assign(this.params, newParams);

    this.landmarkFilterManager.setParams({
      minCutoff: this.params.filterMinCutoff,
      beta: this.params.filterBeta
    });
  }

  // ─── 鍵盤特定ロジック ──────────────────────────────────────────────

  /**
   * 画面上の正規化座標 (px, py) から該当する鍵を特定
   * @param {number} px 指先の正規化X座標 (0..1)
   * @param {number} _py 指先の正規化Y座標 (0..1)
   * @returns {Object|null}
   */
  getKeyAtPoint(px, _py) {
    if (px < 0.0 || px > 1.0) {
      return null;
    }

    const t = Math.max(0, Math.min(1, px));
    const NUM_WHITE = WHITE_KEYS.length;
    const whiteKeyWidth = 1.0 / NUM_WHITE;

    let whiteIdx = Math.floor(t / whiteKeyWidth);
    whiteIdx = Math.max(0, Math.min(NUM_WHITE - 1, whiteIdx));

    return {
      isBlack: false,
      keyIndex: whiteIdx,
      keyData: WHITE_KEYS[whiteIdx],
      keyId: `W_${whiteIdx}`
    };
  }

  // ─── メイン解析ループ (フレームごと実行) ──────────────────────────

  /**
   * 関節圧縮 ＆ 4状態ステートマシン解析
   * @param {Array<Object>} rawHands HandTracker からの出力
   * @param {Object} [options]
   * @param {boolean} [options.isMirrored=false] カメラの左右反転フラグ
   * @returns {Array<Object>}
   */
  analyze(rawHands, options = {}) {
    const isMirrored = options.isMirrored !== undefined ? options.isMirrored : false;
    const now = performance.now();
    const timeSec = now / 1000;

    if (!rawHands || rawHands.length === 0) {
      this.checkGlobalReleases(now);
      return [];
    }

    const analyzedHands = [];
    const activeFingerKeysThisFrame = new Set();

    for (let h = 0; h < rawHands.length; h++) {
      const hand = rawHands[h];
      const landmarks = hand.landmarks;
      if (!landmarks || landmarks.length < 21) continue;

      const analyzedFingers = {};

      // 1. 手の基準長 L_hand の算出 (Wrist:0 - Middle MCP:9)
      const wrist = landmarks[0];
      const middleMcp = landmarks[9];
      const lHand = Math.max(1e-4, distance2D(wrist, middleMcp));

      // 2. 全指の屈曲角データ取得
      const allFlexion = this.kinematics.computeAllFingers(landmarks);

      const displayHandedness = isMirrored
        ? (hand.handedness === 'Left' ? 'Right' : (hand.handedness === 'Right' ? 'Left' : hand.handedness))
        : hand.handedness;

      for (let f = 0; f < FINGER_NAMES.length; f++) {
        const fingerName = FINGER_NAMES[f];
        const tipIndex = FINGER_INDICES[f];
        const rawTip = landmarks[tipIndex];
        const joints = FINGER_JOINTS[fingerName];
        const mcpIndex = joints ? joints.mcp : 0;
        const rawMcp = landmarks[mcpIndex];

        const fingerKey = `${hand.handedness}_${tipIndex}`;
        activeFingerKeysThisFrame.add(fingerKey);

        // 3. One Euro Filter: 指先座標のスムージング（微分ノイズ低減）
        const filteredTip = this.landmarkFilterManager.filterLandmark(fingerKey, rawTip, timeSec);

        // 4. 画面座標（ミラー反転考慮）
        const screenX = isMirrored ? (1.0 - filteredTip.x) : filteredTip.x;
        const screenTip = {
          x: screenX,
          y: filteredTip.y,
          z: filteredTip.z
        };

        // 5. 関節間距離 L(t) および 正規化距離 L_norm(t) = L(t) / L_hand の算出
        const lRaw = distance2D(rawTip, rawMcp);
        const lNorm = lRaw / lHand;

        // 6. 指状態オブジェクトの取得または初期化
        let fState = this.fingerStates.get(fingerKey);
        if (!fState) {
          fState = {
            key: fingerKey,
            handedness: displayHandedness,
            rawHandedness: hand.handedness,
            fingerName,
            tipIndex,
            smState: STATE.IDLE,
            activeKeyInfo: null,
            prevFilteredY: filteredTip.y,
            prevLNorm: lNorm,
            prevTime: now,
            velocityY: 0,
            prevVelocityY: 0,
            peakVelocityY: 0,
            strikeImpactY: 0,
            lastStrikeTime: 0,
            totalFlexion: 0,
            flexionVelocity: 0
          };
          this.fingerStates.set(fingerKey, fState);
        } else {
          fState.handedness = displayHandedness;
        }

        // 7. 指先速度の算出 (1階微分: vy > 0 で下降)
        const dt = (now - fState.prevTime) / 1000;
        let vy = 0;
        if (dt > 0.005) {
          vy = (filteredTip.y - fState.prevFilteredY) / dt;
          fState.prevVelocityY = fState.velocityY;
          fState.velocityY = vy;
          fState.prevFilteredY = filteredTip.y;
          fState.prevTime = now;
        }

        // 8. キネマティクス屈曲情報
        const flexion = allFlexion[fingerName];
        if (flexion) {
          fState.totalFlexion = flexion.totalFlexion;
          fState.flexionVelocity = this.kinematics.computeFlexionVelocity(fingerKey, flexion, now);
        }

        // 9. 指先直下の鍵特定
        const hitKey = this.getKeyAtPoint(screenX, filteredTip.y);

        // 10. 4状態ステートマシン更新（固定ライン非依存・関節圧縮式）
        this._updateStateMachine(fState, screenTip, hitKey, vy, lNorm, flexion, now, displayHandedness);

        // 前フレームの正規化長を更新
        fState.prevLNorm = lNorm;

        analyzedFingers[fingerName] = {
          tip: screenTip,
          rawFilteredTip: filteredTip,
          screenX,
          rawTip,
          hitKey,
          isDown: fState.smState === STATE.IMPACT || fState.smState === STATE.REBOUND,
          velocityY: fState.velocityY,
          lNorm,
          smState: fState.smState,
          totalFlexion: fState.totalFlexion,
          flexionVelocity: fState.flexionVelocity,
          flexionData: flexion
        };
      }

      analyzedHands.push({
        handedness: displayHandedness,
        rawHandedness: hand.handedness,
        handIndex: hand.handIndex,
        score: hand.score,
        landmarks: hand.landmarks,
        fingers: analyzedFingers
      });
    }

    // 画面外に外れた指のノートオフ処理
    for (const [key, state] of this.fingerStates.entries()) {
      if (!activeFingerKeysThisFrame.has(key)) {
        if ((state.smState === STATE.IMPACT || state.smState === STATE.REBOUND) && state.activeKeyInfo) {
          this.emitNoteOff({
            keyId: state.activeKeyInfo.keyId,
            isBlack: state.activeKeyInfo.isBlack,
            keyIndex: state.activeKeyInfo.keyIndex,
            keyData: state.activeKeyInfo.keyData,
            handedness: state.handedness,
            fingerName: state.fingerName,
            timestamp: now
          });
        }
        this.fingerStates.delete(key);
      }
    }

    this.landmarkFilterManager.cleanup(activeFingerKeysThisFrame);
    this.kinematics.cleanup(activeFingerKeysThisFrame);

    // キーハイライトの経過削除
    for (const [kId, hl] of this.activeKeyHighlights.entries()) {
      if (now - hl.startTime > 250) {
        this.activeKeyHighlights.delete(kId);
      }
    }

    return analyzedHands;
  }

  // ─── 4状態打鍵ステートマシン ─────────────────────────────────────

  /**
   * ステートマシン遷移: IDLE → STRIKING → IMPACT → REBOUND → IDLE
   */
  _updateStateMachine(fState, screenTip, hitKey, vy, lNorm, flexion, now, handedness) {
    const p = this.params;
    const isThumb = fState.fingerName === 'Thumb';
    const minStrikeVel = isThumb ? p.minStrikeVelocityThumb : p.minStrikeVelocity;

    const flexionOk = !p.flexionEnabled || !flexion || this.kinematics.isStrikePosture(flexion, {
      minTotalFlexion: p.flexionThreshold
    });

    switch (fState.smState) {
      // ─────────────────────────────────────────────
      // 1. IDLE: 静止・浮遊状態
      // ─────────────────────────────────────────────
      case STATE.IDLE: {
        // 下降開始検知: 最低打鍵速度の半分を超えたらSTRIKINGへ
        if (vy >= minStrikeVel * 0.5 && flexionOk) {
          fState.smState = STATE.STRIKING;
          fState.peakVelocityY = vy;
        }
        break;
      }

      // ─────────────────────────────────────────────
      // 2. STRIKING: 指先下降フェーズ（速度ピーク追跡）
      // ─────────────────────────────────────────────
      case STATE.STRIKING: {
        if (vy > fState.peakVelocityY) {
          fState.peakVelocityY = vy;
        }

        // 速度ピーク到達判定:
        // ① 十分な下向き速度
        // ② 速度ピーク到達（減速への転換）: 直前フレームより加速し、現フレームで速度増加が頭打ち・減少に転じたこと
        const isSpeedPeak = fState.prevVelocityY >= minStrikeVel && vy <= fState.prevVelocityY;
        const isCooldownElapsed = (now - fState.lastStrikeTime) > p.reboundCooldownMs;

        // 物理接触の完了・変形を待たず、速度ピーク到達フレームで即時発音
        if (isSpeedPeak && hitKey && isCooldownElapsed) {
          // ═══ IMPACT: Note On 発火（このフレーム限定） ═══
          fState.smState = STATE.IMPACT;
          fState.activeKeyInfo = hitKey;
          fState.strikeImpactY = screenTip.y;
          fState.lastStrikeTime = now;

          const strikeVel = Math.min(1.0, Math.max(0.3, fState.peakVelocityY * 1.5));

          this.activeKeyHighlights.set(hitKey.keyId, {
            startTime: now,
            velocity: strikeVel,
            handedness,
            fingerName: fState.fingerName,
            isBlack: hitKey.isBlack,
            keyIndex: hitKey.keyIndex,
            keyData: hitKey.keyData
          });

          this.emitNoteOn({
            keyId: hitKey.keyId,
            isBlack: hitKey.isBlack,
            keyIndex: hitKey.keyIndex,
            keyData: hitKey.keyData,
            note: hitKey.keyData.note,
            freq: hitKey.keyData.freq,
            velocity: strikeVel,
            handedness,
            fingerName: fState.fingerName,
            tipPos: { x: screenTip.x, y: screenTip.y },
            timestamp: now
          });

          // 直ちに REBOUND へ遷移（同一打鍵での多重発火を完全防止）
          fState.smState = STATE.REBOUND;
          break;
        }

        // 下降が失速して打鍵に至らなかった場合のキャンセル
        if (vy < minStrikeVel * 0.2 && fState.prevVelocityY < minStrikeVel) {
          fState.smState = STATE.IDLE;
          fState.peakVelocityY = 0;
        }
        break;
      }

      // ─────────────────────────────────────────────
      // 3. IMPACT: 打鍵瞬間（直ちにREBOUNDへ）
      // ─────────────────────────────────────────────
      case STATE.IMPACT: {
        fState.smState = STATE.REBOUND;
        break;
      }

      // ─────────────────────────────────────────────
      // 4. REBOUND: 跳ね返り・離鍵待機フェーズ（再発音完全ロック）
      // ─────────────────────────────────────────────
      case STATE.REBOUND: {
        // 離鍵条件の判定:
        // ① 指先が上向きに浮上した（上向き速度 vy <= releaseVelocityThreshold）
        const hasLiftVelocity = vy <= p.releaseVelocityThreshold;

        // ② 指先が打鍵位置から一定量上方にリフトアップした
        const hasLiftedDistance = (fState.strikeImpactY - screenTip.y) >= p.liftReleaseMargin;

        // ③ 鍵領域から外れた
        const isKeyLost = !hitKey || (fState.activeKeyInfo && hitKey.keyId !== fState.activeKeyInfo.keyId);

        if (hasLiftVelocity || hasLiftedDistance || isKeyLost) {
          const prevKey = fState.activeKeyInfo;
          fState.smState = STATE.IDLE;
          fState.peakVelocityY = 0;
          fState.activeKeyInfo = null;

          if (prevKey) {
            this.emitNoteOff({
              keyId: prevKey.keyId,
              isBlack: prevKey.isBlack,
              keyIndex: prevKey.keyIndex,
              keyData: prevKey.keyData,
              handedness: fState.handedness,
              fingerName: fState.fingerName,
              timestamp: now
            });
          }
        }
        break;
      }
    }
  }

  // ─── 全音消音処理 ───────────────────────────────────────────

  checkGlobalReleases(now) {
    for (const [key, state] of this.fingerStates.entries()) {
      if ((state.smState === STATE.IMPACT || state.smState === STATE.REBOUND) && state.activeKeyInfo) {
        this.emitNoteOff({
          keyId: state.activeKeyInfo.keyId,
          isBlack: state.activeKeyInfo.isBlack,
          keyIndex: state.activeKeyInfo.keyIndex,
          keyData: state.activeKeyInfo.keyData,
          handedness: state.handedness,
          fingerName: state.fingerName,
          timestamp: now
        });
      }
    }
    this.fingerStates.clear();
    this.landmarkFilterManager.resetAll();
  }

  // ─── 外部感度調整API ─────────────────────────────────────────

  setSensitivity(sensitivity) {
    // 感度 0..1 に応じて圧縮閾値と速度閾値を連動調整
    const s = Math.max(0, Math.min(1, sensitivity));
    this.params.compressionThreshold = 0.050 - (s * 0.030); // 0.050 (鈍感) 〜 0.020 (敏感)
    this.params.strikeVelocityThreshold = 0.20 - (s * 0.12);
  }

  get keyboardQuad() {
    // 互換性用
    return {
      topLeft:     { x: 0.0, y: 0.8 },
      topRight:    { x: 1.0, y: 0.8 },
      bottomRight: { x: 1.0, y: 0.8 },
      bottomLeft:  { x: 0.0, y: 0.8 }
    };
  }
}
