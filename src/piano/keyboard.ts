/**
 * 鍵盤幾何定義およびカメラ座標射影キャッシュモジュール
 * A4実寸ミリ座標系（297mm x 210mm）における14本の白鍵（C4〜B5）の幾何形状を定義し、
 * 逆ホモグラフィ行列 H^-1 を用いてカメラ画面座標へ事前射影・キャッシュします。
 */

import { Point2D, Matrix3x3, applyHomography } from '../calibration/homography';

export interface KeyGeometry {
  index: number;
  note: string;
  isC: boolean;
  // A4平面物理座標 [mm]
  cornersMm: [Point2D, Point2D, Point2D, Point2D]; // [左上, 右上, 右下, 左下]
  indicatorCenterMm?: Point2D; // 直径2mmドットの中心
}

export interface ProjectedKey {
  index: number;
  note: string;
  isC: boolean;
  // カメラ画面座標 [px]
  cornersCamera: [Point2D, Point2D, Point2D, Point2D];
  indicatorCenterCamera?: Point2D;
  indicatorRadiusCamera?: number; // 直径2mm相当のカメラ上の半径 [px]
}

/** 白鍵ノート名定義（C4〜B5の2オクターブ、計14本） */
export const WHITE_KEYS_NOTES: string[] = [
  'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4',
  'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5'
];

/** 鍵盤幾何定数（mm単位） */
export const KEYBOARD_CONFIG = {
  numKeys: 14,
  // 四隅のマーカー（X: 10〜37.5mm, 259.5〜287mm）と物理干渉しない範囲で用紙左右端（X=10mm〜287mm）まで最大化
  keyWidthMm: 277.0 / 14, // 1鍵 約19.79mm (14本で277.0mm)
  keyLengthMm: 133.0,     // 上下マーカー間（Y: 37.5mm〜172.5mm）に収まる限界長
  totalWidthMm: 277.0,    // 用紙左右マージン10mmに揃えた最大幅
  originX_Mm: 10.0,       // 左側マーカー左端ライン(X=10mm)と整列
  originY_Mm: 38.5,       // 上側マーカー下端(37.5mm)から1.0mmクリアランス
  indicatorDiameterMm: 2.5, // 鍵盤拡大に合わせたCキーインジケータ直径
  indicatorOffsetFromTopMm: 5.0, // 上端からのオフセット
};

/**
 * 14本の白鍵の物理幾何形状（A4平面座標: mm）を生成します。
 */
export function createWhiteKeysGeometry(): KeyGeometry[] {
  const { numKeys, keyWidthMm, keyLengthMm, originX_Mm, originY_Mm, indicatorOffsetFromTopMm } = KEYBOARD_CONFIG;
  const keys: KeyGeometry[] = [];

  for (let k = 0; k < numKeys; k++) {
    const note = WHITE_KEYS_NOTES[k];
    const isC = note.startsWith('C');

    const left = originX_Mm + k * keyWidthMm;
    const right = left + keyWidthMm;
    const top = originY_Mm;
    const bottom = top + keyLengthMm;

    // 4頂点: [左上, 右上, 右下, 左下]
    const cornersMm: [Point2D, Point2D, Point2D, Point2D] = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];

    let indicatorCenterMm: Point2D | undefined;
    if (isC) {
      indicatorCenterMm = {
        x: left + keyWidthMm / 2,
        y: top + indicatorOffsetFromTopMm,
      };
    }

    keys.push({
      index: k,
      note,
      isC,
      cornersMm,
      indicatorCenterMm,
    });
  }

  return keys;
}

/**
 * 鍵盤射影プロジェクタークラス
 * H^-1 を受けて全頂点を一度だけカメラ座標へ変換し、60fps描画用にキャッシュ保持します。
 */
export class KeyboardProjector {
  private static readonly baseGeometry: KeyGeometry[] = createWhiteKeysGeometry();
  private static cachedProjectedKeys: ProjectedKey[] | null = null;

  /**
   * 逆ホモグラフィ行列 H^-1 を用いて射影キャッシュを更新します。
   * @param invH A4物理座標 (mm) -> カメラ座標 (px) の 3x3 変換行列
   */
  public static updateProjection(invH: Matrix3x3): void {
    const projected: ProjectedKey[] = [];
    const radiusMm = KEYBOARD_CONFIG.indicatorDiameterMm / 2.0;

    for (const key of this.baseGeometry) {
      // 4頂点の射影
      const c0 = applyHomography(invH, key.cornersMm[0]);
      const c1 = applyHomography(invH, key.cornersMm[1]);
      const c2 = applyHomography(invH, key.cornersMm[2]);
      const c3 = applyHomography(invH, key.cornersMm[3]);

      let indicatorCenterCamera: Point2D | undefined;
      let indicatorRadiusCamera: number | undefined;

      if (key.isC && key.indicatorCenterMm) {
        indicatorCenterCamera = applyHomography(invH, key.indicatorCenterMm);
        // 半径1mm先の基準点を射影して、カメラ画面上でのピクセル半径を算出
        const edgePointMm: Point2D = {
          x: key.indicatorCenterMm.x + radiusMm,
          y: key.indicatorCenterMm.y,
        };
        const edgeCamera = applyHomography(invH, edgePointMm);
        indicatorRadiusCamera = Math.hypot(
          edgeCamera.x - indicatorCenterCamera.x,
          edgeCamera.y - indicatorCenterCamera.y
        );
      }

      projected.push({
        index: key.index,
        note: key.note,
        isC: key.isC,
        cornersCamera: [c0, c1, c2, c3],
        indicatorCenterCamera,
        indicatorRadiusCamera,
      });
    }

    this.cachedProjectedKeys = projected;
  }

  /**
   * キャッシュされた射影鍵盤リストを取得
   */
  public static getProjectedKeys(): ProjectedKey[] | null {
    return this.cachedProjectedKeys;
  }

  /**
   * キャッシュを破棄
   */
  public static clear(): void {
    this.cachedProjectedKeys = null;
  }

  /**
   * 現在キャッシュが存在するか
   */
  public static get hasCache(): boolean {
    return this.cachedProjectedKeys !== null;
  }
}
