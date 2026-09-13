/**
 * finger-kinematics.js — 指関節屈曲および接触姿勢解析モジュール
 *
 * MediaPipe Hand Landmark トポロジー（Wrist:0, 各指MCP, PIP, DIP, Tip）を用いて、
 * 指の関節屈曲角および各関節間・指先距離を算出します。
 */

/**
 * 各指の関節インデックス定義（MediaPipe Hand Topology）
 */
export const FINGER_JOINTS = {
  Thumb:  { wrist: 0, cmc: 1, mcp: 2, ip: 3, tip: 4 },
  Index:  { wrist: 0, mcp: 5, pip: 6, dip: 7, tip: 8 },
  Middle: { wrist: 0, mcp: 9, pip: 10, dip: 11, tip: 12 },
  Ring:   { wrist: 0, mcp: 13, pip: 14, dip: 15, tip: 16 },
  Pinky:  { wrist: 0, mcp: 17, pip: 18, dip: 19, tip: 20 }
};

/**
 * 2D/3D空間における3点間の角度（度数法: 0〜180度）を計算
 */
function angleBetween3Points(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };

  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y + ba.z * ba.z);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);

  if (magBA < 1e-8 || magBC < 1e-8) return 180;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * 2点間の2Dユークリッド距離
 */
export function distance2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 2点間の3Dユークリッド距離
 */
export function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class FingerKinematics {
  constructor() {
    this._prevFlexion = new Map();
  }

  /**
   * 手の基準長 L_hand (Wrist-0 と 中指MCP-9 の2D距離) を計算
   * @param {Array<{x: number, y: number}>} landmarks
   * @returns {number}
   */
  computeHandScale(landmarks) {
    if (!landmarks || landmarks.length < 10) return 1.0;
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];
    const dist = distance2D(wrist, middleMcp);
    return dist > 1e-4 ? dist : 1.0;
  }

  /**
   * 単一指のMCP-Tip間距離 L(t) および正規化距離 L_norm(t) を計算
   * @param {Array<{x: number, y: number}>} landmarks
   * @param {string} fingerName
   * @param {number} [handScale] 手の基準長 L_hand（省略時は自動計算）
   * @returns {{ rawLength: number, normalizedLength: number }}
   */
  computeNormalizedFingerLength(landmarks, fingerName, handScale = null) {
    const joints = FINGER_JOINTS[fingerName];
    if (!joints || !landmarks) return { rawLength: 0, normalizedLength: 0 };

    const mcp = landmarks[joints.mcp];
    const tip = landmarks[joints.tip];
    if (!mcp || !tip) return { rawLength: 0, normalizedLength: 0 };

    const lHand = handScale || this.computeHandScale(landmarks);
    const rawLength = distance2D(mcp, tip);
    const normalizedLength = lHand > 1e-4 ? rawLength / lHand : rawLength;

    return { rawLength, normalizedLength };
  }

  /**
   * 単一指の屈曲度（角度ベース）の計算
   */
  computeFlexion(landmarks, fingerName) {
    if (fingerName === 'Thumb') {
      return this.computeThumbFlexion(landmarks);
    }

    const joints = FINGER_JOINTS[fingerName];
    if (!joints) return null;

    const wrist = landmarks[joints.wrist];
    const mcp = landmarks[joints.mcp];
    const pip = landmarks[joints.pip];
    const dip = landmarks[joints.dip];
    const tip = landmarks[joints.tip];

    const mcpAngle = angleBetween3Points(wrist, mcp, pip);
    const pipAngle = angleBetween3Points(mcp, pip, dip);
    const dipAngle = angleBetween3Points(pip, dip, tip);

    const mcpFlexion = 180 - mcpAngle;
    const pipFlexion = 180 - pipAngle;
    const dipFlexion = 180 - dipAngle;
    const totalFlexion = mcpFlexion * 0.3 + pipFlexion * 0.5 + dipFlexion * 0.2;

    const tipToMcp = distance3D(tip, mcp);
    const mcpToWrist = distance3D(mcp, wrist);
    const tipToMcpRatio = mcpToWrist > 1e-6 ? tipToMcp / mcpToWrist : 1;

    return {
      fingerName,
      mcpAngle,
      pipAngle,
      dipAngle,
      mcpFlexion,
      pipFlexion,
      dipFlexion,
      totalFlexion,
      tipToMcpRatio
    };
  }

  /**
   * 親指の屈曲度計算
   */
  computeThumbFlexion(landmarks) {
    const joints = FINGER_JOINTS.Thumb;
    const wrist = landmarks[joints.wrist];
    const cmc = landmarks[joints.cmc];
    const mcp = landmarks[joints.mcp];
    const ip = landmarks[joints.ip];
    const tip = landmarks[joints.tip];

    const cmcAngle = angleBetween3Points(wrist, cmc, mcp);
    const mcpAngle = angleBetween3Points(cmc, mcp, ip);
    const ipAngle = angleBetween3Points(mcp, ip, tip);

    const cmcFlexion = 180 - cmcAngle;
    const mcpFlexion = 180 - mcpAngle;
    const ipFlexion = 180 - ipAngle;
    const totalFlexion = cmcFlexion * 0.2 + mcpFlexion * 0.5 + ipFlexion * 0.3;

    const tipToBase = distance3D(tip, cmc);
    const baseToWrist = distance3D(cmc, wrist);
    const tipToMcpRatio = baseToWrist > 1e-6 ? tipToBase / baseToWrist : 1;

    return {
      fingerName: 'Thumb',
      mcpAngle: cmcAngle,
      pipAngle: mcpAngle,
      dipAngle: ipAngle,
      mcpFlexion: cmcFlexion,
      pipFlexion: mcpFlexion,
      dipFlexion: ipFlexion,
      totalFlexion,
      tipToMcpRatio
    };
  }

  /**
   * 打鍵姿勢の判定（指が伸び切っていないか）
   */
  isStrikePosture(flexionData, thresholds = {}) {
    if (!flexionData) return false;
    const minFlexion = thresholds.minTotalFlexion !== undefined ? thresholds.minTotalFlexion : 15;
    const maxRatio = thresholds.maxTipToMcpRatio !== undefined ? thresholds.maxTipToMcpRatio : 2.5;

    const hasFlexion = flexionData.totalFlexion >= minFlexion;
    const tipCloseEnough = flexionData.tipToMcpRatio <= maxRatio;
    return hasFlexion || tipCloseEnough;
  }

  /**
   * 屈曲角変化速度
   */
  computeFlexionVelocity(fingerKey, flexionData, timestamp) {
    const prev = this._prevFlexion.get(fingerKey);
    let velocity = 0;

    if (prev && flexionData) {
      const dt = (timestamp - prev.timestamp) / 1000;
      if (dt > 0.005 && dt < 0.5) {
        velocity = (flexionData.totalFlexion - prev.totalFlexion) / dt;
      }
    }

    if (flexionData) {
      this._prevFlexion.set(fingerKey, {
        totalFlexion: flexionData.totalFlexion,
        timestamp
      });
    }

    return velocity;
  }

  /**
   * 全指の屈曲度を一括計算
   */
  computeAllFingers(landmarks) {
    const result = {};
    for (const name of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      result[name] = this.computeFlexion(landmarks, name);
    }
    return result;
  }

  /**
   * 非アクティブな指の履歴クリーンアップ
   */
  cleanup(activeKeys) {
    for (const key of this._prevFlexion.keys()) {
      if (!activeKeys.has(key)) {
        this._prevFlexion.delete(key);
      }
    }
  }
}
