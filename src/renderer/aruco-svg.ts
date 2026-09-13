/**
 * ArUcoマーカー（DICT_5X5_50）SVG生成モジュール
 * OpenCV標準のDICT_5X5_50辞書からID 0〜3の7x7ビットパターン（外枠黒1マス＋内部5x5）を生成します。
 */

// 7x7グリッドのビットパターン定義 (0: 黒, 1: 白)
// 外周1マスはすべて黒枠(0)
export const ARUCO_5X5_PATTERNS: Record<number, number[][]> = {
  0: [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0, 0, 0],
    [0, 0, 1, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 0, 0],
    [0, 1, 0, 1, 0, 1, 0],
    [0, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ],
  1: [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0],
    [0, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0],
    [0, 1, 0, 1, 1, 1, 0],
    [0, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ],
  2: [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 1, 0, 0],
    [0, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 0, 1, 1, 0],
    [0, 1, 0, 1, 1, 0, 0],
    [0, 1, 1, 1, 0, 1, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ],
  3: [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 0],
    [0, 0, 0, 1, 0, 1, 0],
    [0, 0, 1, 1, 1, 1, 0],
    [0, 1, 0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ],
};

/**
 * 指定したArUco IDのSVGマークアップ文字列を生成します。
 * @param id マーカーID (0〜3)
 * @param sizeMm 表示・印刷サイズ（ミリメートル、デフォルト27.5）
 * @returns インラインSVGマークアップ文字列
 */
export function createArucoSvgString(id: number, sizeMm: number = 27.5): string {
  const pattern = ARUCO_5X5_PATTERNS[id];
  if (!pattern) {
    throw new Error(`サポートされていないArUco IDです: ${id}`);
  }

  // 1マス単位の白セルを生成（背景を黒にしておき、白セルのみを描画することで描画隙間を防止）
  let whiteCells = '';
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      if (pattern[row][col] === 1) {
        whiteCells += `<rect x="${col}" y="${row}" width="1" height="1" fill="#ffffff" />`;
      }
    }
  }

  return `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 7 7"
      width="${sizeMm}mm"
      height="${sizeMm}mm"
      shape-rendering="crispEdges"
      class="aruco-marker marker-id-${id}"
      data-marker-id="${id}"
    >
      <rect width="7" height="7" fill="#000000" />
      ${whiteCells}
    </svg>
  `.trim();
}
