/**
 * A4キャリブレーション用紙 PDF生成・ダウンロードモジュール
 * jsPDFを用いてA4横向き（297mm × 210mm）の実寸ベクターPDFを生成し、
 * 四隅に正確なオフセット（端から10mm）・サイズ（27.5mm）でArUcoマーカー（ID 0〜3）を埋め込みます。
 */

import { jsPDF } from 'jspdf';
import { ARUCO_5X5_PATTERNS } from './aruco-svg';

export interface MarkerPdfConfig {
  id: number;
  xMm: number;
  yMm: number;
  sizeMm: number;
}

/** A4横向き寸法（ミリメートル） */
export const A4_WIDTH_MM = 297;
export const A4_HEIGHT_MM = 210;

/** マーカー基本仕様 */
export const MARKER_SIZE_MM = 27.5;
export const MARKER_OFFSET_MM = 10;

/** 四隅マーカー配置設定 */
export const PDF_MARKER_CONFIGS: MarkerPdfConfig[] = [
  // ID 0 (左上): X=10mm, Y=10mm
  { id: 0, xMm: MARKER_OFFSET_MM, yMm: MARKER_OFFSET_MM, sizeMm: MARKER_SIZE_MM },
  // ID 1 (右上): X=259.5mm, Y=10mm (297 - 10 - 27.5)
  { id: 1, xMm: A4_WIDTH_MM - MARKER_OFFSET_MM - MARKER_SIZE_MM, yMm: MARKER_OFFSET_MM, sizeMm: MARKER_SIZE_MM },
  // ID 2 (右下): X=259.5mm, Y=172.5mm (210 - 10 - 27.5)
  { id: 2, xMm: A4_WIDTH_MM - MARKER_OFFSET_MM - MARKER_SIZE_MM, yMm: A4_HEIGHT_MM - MARKER_OFFSET_MM - MARKER_SIZE_MM, sizeMm: MARKER_SIZE_MM },
  // ID 3 (左下): X=10mm, Y=172.5mm
  { id: 3, xMm: MARKER_OFFSET_MM, yMm: A4_HEIGHT_MM - MARKER_OFFSET_MM - MARKER_SIZE_MM, sizeMm: MARKER_SIZE_MM },
];

/**
 * A4キャリブレーション用紙の純ベクターPDFドキュメントを生成します。
 * @returns jsPDF インスタンス
 */
export function generateCalibrationSheetPdf(): jsPDF {
  // A4 横向き (297mm x 210mm) のPDFドキュメントを作成
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  // 四隅に各ArUcoマーカー（ID 0〜3）を純ベクター矩形で描画
  for (const config of PDF_MARKER_CONFIGS) {
    drawArucoMarkerVector(doc, config.id, config.xMm, config.yMm, config.sizeMm);
  }

  // 鍵盤線は一切描画しない（完全な白紙領域を維持）

  return doc;
}

/**
 * 単一のArUcoマーカーをベクター矩形としてPDF上に描画します。
 */
function drawArucoMarkerVector(
  doc: jsPDF,
  id: number,
  x: number,
  y: number,
  sizeMm: number
): void {
  const pattern = ARUCO_5X5_PATTERNS[id];
  if (!pattern) {
    console.error(`未定義のArUco IDです: ${id}`);
    return;
  }

  // 1マスのサイズ (7x7グリッド)
  const cellSize = sizeMm / 7.0;

  // 背景: 27.5mm x 27.5mm の黒塗り矩形
  doc.setFillColor(0, 0, 0);
  doc.rect(x, y, sizeMm, sizeMm, 'F');

  // 白ビットセルの描画
  doc.setFillColor(255, 255, 255);
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (pattern[r][c] === 1) {
        doc.rect(
          x + c * cellSize,
          y + r * cellSize,
          cellSize,
          cellSize,
          'F'
        );
      }
    }
  }
}

/**
 * A4キャリブレーション用紙PDFを生成し、ブラウザ上でダウンロードします。
 * @param filename ダウンロードファイル名
 */
export function downloadCalibrationSheetPdf(filename: string = 'PiARno2_A4_Calibration_Sheet.pdf'): void {
  const doc = generateCalibrationSheetPdf();
  doc.save(filename);
}
