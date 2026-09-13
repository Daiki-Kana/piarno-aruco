/**
 * DLT（直接線形変換）によるホモグラフィ行列算出および幾何学変換モジュール
 * カメラ座標系 (u, v) と A4実寸ミリ座標系 (X, Y) 間の 3x3 透視変換行列 H およびその逆行列 H^-1 を扱います。
 */

export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number]
];

export interface Point2D {
  x: number;
  y: number;
}

export interface PointCorrespondence {
  source: Point2D; // カメラ座標 (u, v) [px]
  target: Point2D; // A4実寸座標 (X, Y) [mm]
}

/**
 * 4組の対応点から DLT (Direct Linear Transformation) により 3x3 ホモグラフィ行列 H を算出します。
 * 変換式: [X, Y, 1]^T ~ H * [u, v, 1]^T
 * @param correspondences 4組の対応点リスト
 * @returns 3x3 ホモグラフィ行列 H (算出不可の場合は null)
 */
export function computeHomography(correspondences: PointCorrespondence[]): Matrix3x3 | null {
  if (correspondences.length < 4) {
    console.error('ホモグラフィ算出には最低4組の対応点が必要です。');
    return null;
  }

  // 8元1次連立方程式 A * h = b を構築 (h_22 = 1 と正規化)
  // 未知数: h = [h00, h01, h02, h10, h11, h12, h20, h21]^T
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = correspondences[i].source;
    const { x: X, y: Y } = correspondences[i].target;

    // 行 2i: u*h00 + v*h01 + 1*h02 - u*X*h20 - v*X*h21 = X
    A.push([u, v, 1, 0, 0, 0, -u * X, -v * X]);
    b.push(X);

    // 行 2i+1: u*h10 + v*h11 + 1*h12 - u*Y*h20 - v*Y*h21 = Y
    A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y]);
    b.push(Y);
  }

  // ガウス消去法（部分ピボット選択付き）で A * h = b を解く
  const h = solveLinearSystem(A, b);
  if (!h) {
    console.error('特異行列のためホモグラフィ行列を解けませんでした。');
    return null;
  }

  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1.0],
  ];
}

/**
 * 3x3 行列の逆行列を算出します。
 * @param M 対象の 3x3 行列
 * @returns 逆行列 M^-1 (行列式が0の場合は null)
 */
export function invertMatrix3x3(M: Matrix3x3): Matrix3x3 | null {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = M;

  // 余因子行列の要素計算
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;

  // 行列式
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    console.error('行列式がゼロに近いため逆行列が存在しません。');
    return null;
  }

  const invDet = 1.0 / det;

  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);

  const G = b * f - c * e;
  const H_val = -(a * f - c * d);
  const I = a * e - b * d;

  // 随伴行列の転置に 1/det を乗算
  return [
    [A * invDet, D * invDet, G * invDet],
    [B * invDet, E * invDet, H_val * invDet],
    [C * invDet, F * invDet, I * invDet],
  ];
}

/**
 * 3x3 透視変換行列を用いて2次元座標を変換します。
 * @param M 3x3 変換行列
 * @param p 変換元の座標 (x, y)
 * @returns 変換後の座標 (x', y')
 */
export function applyHomography(M: Matrix3x3, p: Point2D): Point2D {
  const [
    [m00, m01, m02],
    [m10, m11, m12],
    [m20, m21, m22],
  ] = M;

  const w = m20 * p.x + m21 * p.y + m22;
  if (Math.abs(w) < 1e-12) {
    return { x: 0, y: 0 };
  }

  const invW = 1.0 / w;
  return {
    x: (m00 * p.x + m01 * p.y + m02) * invW,
    y: (m10 * p.x + m11 * p.y + m12) * invW,
  };
}

/**
 * 部分ピボット選択付きガウス消去法により連立一次方程式 A * x = b (8x8) を解きます。
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // 拡大係数行列の作成
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    M.push([...A[i], b[i]]);
  }

  // 前進消去
  for (let col = 0; col < n; col++) {
    // ピボット行の選択 (絶対値が最大の要素を行選択)
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(M[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    if (maxVal < 1e-12) {
      return null; // 解が一意に定まらない
    }

    // 行の交換
    if (maxRow !== col) {
      const temp = M[col];
      M[col] = M[maxRow];
      M[maxRow] = temp;
    }

    // 他行の消去
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  // 後退代入
  const x: number[] = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }

  return x;
}
