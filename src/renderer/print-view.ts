/**
 * A4キャリブレーション用紙 印刷用ビュー制御モジュール
 * 白黒ミニマルUIによる画面切り替え、ArUcoマーカー（ID 0〜3）のSVG描画、
 * プレビュー自動フィットスケーリング、等倍印刷ダイアログの呼び出し（window.print）を管理します。
 */

import { createArucoSvgString } from './aruco-svg';
import { downloadCalibrationSheetPdf } from './pdf-generator';

export interface PrintViewOptions {
  openButton: HTMLButtonElement;
  backButton: HTMLButtonElement;
  printButton: HTMLButtonElement;
  downloadPdfButton?: HTMLButtonElement | null;
  printViewElement: HTMLElement;
  sheetElement: HTMLElement;
  sheetContainerElement: HTMLElement;
  markerSlotElements: HTMLElement[];
}

export class PrintView {
  private openButton: HTMLButtonElement;
  private backButton: HTMLButtonElement;
  private printButton: HTMLButtonElement;
  private downloadPdfButton?: HTMLButtonElement | null;
  private printViewElement: HTMLElement;
  private sheetElement: HTMLElement;
  private sheetContainerElement: HTMLElement;
  private markerSlotElements: HTMLElement[];
  private isOpened: boolean = false;

  constructor(options: PrintViewOptions) {
    this.openButton = options.openButton;
    this.backButton = options.backButton;
    this.printButton = options.printButton;
    this.downloadPdfButton = options.downloadPdfButton;
    this.printViewElement = options.printViewElement;
    this.sheetElement = options.sheetElement;
    this.sheetContainerElement = options.sheetContainerElement;
    this.markerSlotElements = options.markerSlotElements;

    this.renderMarkers();
    this.initEvents();
  }

  /**
   * 各マーカースロットに27.5mmのArUco SVGを描画します。
   */
  private renderMarkers(): void {
    this.markerSlotElements.forEach((slot, index) => {
      const idAttr = slot.getAttribute('data-marker-id');
      const id = idAttr !== null ? parseInt(idAttr, 10) : index;
      if (id >= 0 && id <= 3) {
        slot.innerHTML = createArucoSvgString(id, 27.5);
      }
    });
  }

  /**
   * ボタンおよびキーボードイベントの登録
   */
  private initEvents(): void {
    // 印刷ビューを開く
    this.openButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open();
    });

    // 演奏画面に戻る
    this.backButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    // 印刷ダイアログ起動
    this.printButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.triggerPrint();
    });

    // PDFダウンロード
    if (this.downloadPdfButton) {
      this.downloadPdfButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadPdf();
      });
    }

    // ESCキーで閉じる
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpened) {
        this.close();
      }
    });

    // ウィンドウサイズ変更時にプレビュー倍率を追従
    window.addEventListener('resize', () => {
      if (this.isOpened) {
        this.updatePreviewScale();
      }
    });
  }

  /**
   * 画面プレビュー時にA4シートが美しく中央に収まるようスケール比率を計算・適用
   */
  public updatePreviewScale(): void {
    if (!this.sheetElement || !this.sheetContainerElement) return;

    // パディング等を考慮した表示領域（ツールバーや余白分）
    const availWidth = this.sheetContainerElement.clientWidth - 48;
    const availHeight = this.sheetContainerElement.clientHeight - 48;

    const origWidth = this.sheetElement.offsetWidth;
    const origHeight = this.sheetElement.offsetHeight;

    if (availWidth <= 0 || availHeight <= 0 || origWidth <= 0 || origHeight <= 0) {
      return;
    }

    const scale = Math.min(1.0, availWidth / origWidth, availHeight / origHeight);
    const clampedScale = Math.max(0.15, scale);

    this.sheetElement.style.setProperty('--sheet-scale', clampedScale.toFixed(4));
  }

  /**
   * 印刷ビューを表示
   */
  public open(): void {
    this.isOpened = true;
    this.printViewElement.classList.remove('hidden');
    // レンダリング更新後にプレビュー倍率を計算
    requestAnimationFrame(() => {
      this.updatePreviewScale();
    });
  }

  /**
   * 印刷ビューを閉じて演奏画面へ戻る
   */
  public close(): void {
    this.isOpened = false;
    this.printViewElement.classList.add('hidden');
  }

  /**
   * ブラウザ標準の印刷ダイアログを起動
   */
  public triggerPrint(): void {
    window.print();
  }

  /**
   * A4実寸PDFファイルを生成してダウンロード
   */
  public downloadPdf(): void {
    downloadCalibrationSheetPdf('PiARno2_A4_Calibration_Sheet.pdf');
  }

  /**
   * 現在印刷ビューが表示されているか
   */
  public get isOpen(): boolean {
    return this.isOpened;
  }
}
