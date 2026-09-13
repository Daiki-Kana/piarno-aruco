/**
 * オーバーレイ描画モジュール
 * キャリブレーション後のA4用紙輪郭、マーカー中心点、状態ガイドを白黒ミニマルに描画します。
 */

import { Calibrator } from '../calibration/calibrator';
import { KeyboardRenderer } from './keyboard-renderer';

export class CanvasOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2Dコンテキストを取得できませんでした。');
    }
    this.ctx = context;
  }

  /**
   * キャンバスの解像度をビデオ解像度に合わせてリサイズ
   */
  public resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * 毎フレームのオーバーレイ描画（60fps）
   * @param pressedKeys 現在打鍵中の白鍵インデックス
   * @param fingerTracks 5指の追跡状態リスト
   */
  public render(pressedKeys?: Set<number>, fingerTracks?: any[]): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    if (Calibrator.isCalibrated) {
      // A4用紙の輪郭ガイドを描画（控えめな白枠）
      if (Calibrator.paperCornersInCamera) {
        this.drawPaperBoundary(Calibrator.paperCornersInCamera);
      }

      // マーカー中心点（十字）を描画
      if (Calibrator.markerCentersInCamera) {
        this.drawMarkerCenters(Calibrator.markerCentersInCamera);
      }

      // 14本の白鍵 AR鍵盤（発光ワイヤーフレーム＆打鍵ハイライト）を高速描画
      KeyboardRenderer.render(this.ctx, pressedKeys);
    }

    // 5指の平滑化ポインタ（白黒ミニマル）を描画
    if (fingerTracks && fingerTracks.length > 0) {
      this.drawFingerPointers(fingerTracks);
      this.drawDebugHud(fingerTracks);
    }
  }

  /**
   * 白黒ミニマルのリアルタイム打鍵HUD描画
   */
  private drawDebugHud(fingerTracks: any[]): void {
    const { height } = this.canvas;
    const hudX = 16;
    const hudY = height - 115;
    const hudW = 190;
    const hudH = 100;

    this.ctx.save();

    // 半透明ブラック背景
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(hudX, hudY, hudW, hudH);
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(hudX, hudY, hudW, hudH);

    this.ctx.font = '10px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    // キャリブレーションステータス
    const calibText = Calibrator.isCalibrated ? 'CALIBRATED' : 'NOT CALIBRATED';
    this.ctx.fillStyle = Calibrator.isCalibrated ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
    this.ctx.fillText(`STATUS: ${calibText}`, hudX + 8, hudY + 8);

    // 各指の D_norm とステート
    const fingerShortNames: Record<string, string> = {
      thumb: 'T (親)',
      index: 'I (人)',
      middle: 'M (中)',
      ring: 'R (薬)',
      pinky: 'P (小)',
    };

    let lineY = hudY + 24;
    for (const track of fingerTracks) {
      const label = fingerShortNames[track.name] || track.name;
      const vel = track.normalizedDisplacement ?? 0;
      const velStr = (vel >= 0 ? '+' : '') + vel.toFixed(1);
      const isPressed = track.state === 'IMPACT' || track.state === 'REBOUND' || track.state === 'Triggered' || track.state === 'Holding';

      let stateText = track.state.toUpperCase().slice(0, 3);
      if (isPressed && track.pressedKeyIndex >= 0) {
        stateText += ` key#${track.pressedKeyIndex}`;
      }

      this.ctx.fillStyle = isPressed ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
      this.ctx.fillText(`${label}: v=${velStr} [${stateText}]`, hudX + 8, lineY);
      lineY += 14;
    }

    this.ctx.restore();
  }

  /**
   * 1 Euro Filter で平滑化された指先ポインタの描画
   */
  private drawFingerPointers(fingerTracks: any[]): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';

    for (const track of fingerTracks) {
      const { x, y } = track.filteredCameraPx;
      if (x <= 0 && y <= 0) continue;

      const isPressed = track.state === 'IMPACT' || track.state === 'REBOUND' || track.state === 'Triggered' || track.state === 'Holding';

      // 指先中心ドット
      this.ctx.beginPath();
      this.ctx.arc(x, y, 4, 0, Math.PI * 2);
      this.ctx.fillStyle = isPressed ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
      this.ctx.fill();

      // 打鍵中の外側リングフィードバック
      if (isPressed) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, 9, 0, Math.PI * 2);
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      }
    }

    this.ctx.restore();
  }

  /**
   * A4用紙の外枠四角形を描画（白黒ミニマル）
   */
  private drawPaperBoundary(corners: { x: number; y: number }[]): void {
    if (corners.length < 4) return;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) {
      this.ctx.lineTo(corners[i].x, corners[i].y);
    }
    this.ctx.closePath();

    // 白の半透明塗りつぶしとクッキリした白枠線
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    this.ctx.fill();

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // 四隅のコーナーインジケーター（小さな白四角）
    this.ctx.fillStyle = '#ffffff';
    for (const c of corners) {
      this.ctx.fillRect(c.x - 4, c.y - 4, 8, 8);
    }

    this.ctx.restore();
  }

  /**
   * 各ArUcoマーカーの中心位置を描画
   */
  private drawMarkerCenters(centers: Record<number, { x: number; y: number }>): void {
    this.ctx.save();
    for (const [idStr, pt] of Object.entries(centers)) {
      const id = parseInt(idStr, 10);

      // 十字マーク描画
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1.5;
      const size = 6;
      this.ctx.beginPath();
      this.ctx.moveTo(pt.x - size, pt.y);
      this.ctx.lineTo(pt.x + size, pt.y);
      this.ctx.moveTo(pt.x, pt.y - size);
      this.ctx.lineTo(pt.x, pt.y + size);
      this.ctx.stroke();

      // IDテキスト（ミニマル表記）
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(pt.x + 8, pt.y - 10, 22, 16);
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(pt.x + 8, pt.y - 10, 22, 16);

      this.ctx.font = '10px monospace';
      this.ctx.fillStyle = '#ffffff';
      this.ctx.textBaseline = 'middle';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(`#${id}`, pt.x + 19, pt.y - 2);
    }
    this.ctx.restore();
  }
}
