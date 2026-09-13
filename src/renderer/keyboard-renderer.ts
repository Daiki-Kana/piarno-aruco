/**
 * AR鍵盤レンダラーモジュール
 * キャッシュされた射影頂点データをもとに、手のオクルージョンを妨げない
 * 発光ワイヤーフレーム（globalCompositeOperation = 'lighter'）として高速描画します。
 */

import { KeyboardProjector, ProjectedKey } from '../piano/keyboard';

export class KeyboardRenderer {
  /**
   * 14本の白鍵およびCキーインジケータを描画
   * @param ctx 描画対象の 2D レンダリングコンテキスト
   * @param pressedKeys 現在押下中のキーインデックスのセット
   */
  public static render(ctx: CanvasRenderingContext2D, pressedKeys?: Set<number>): void {
    const projectedKeys = KeyboardProjector.getProjectedKeys();
    if (!projectedKeys || projectedKeys.length === 0) {
      return;
    }

    ctx.save();

    // 手のオクルージョン対策: 背景や指先を遮蔽しない加算発光合成
    ctx.globalCompositeOperation = 'lighter';

    // 押下中のキーを発光ハイライト（面発光）
    if (pressedKeys && pressedKeys.size > 0) {
      for (const key of projectedKeys) {
        if (pressedKeys.has(key.index)) {
          this.drawKeyHighlight(ctx, key);
        }
      }
    }

    // 発光グロー効果の設定
    ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
    ctx.shadowBlur = 4;
    ctx.lineWidth = 1.5;

    // 各白鍵のワイヤーフレームを描画
    for (const key of projectedKeys) {
      this.drawKeyWireframe(ctx, key);
    }

    // オクターブインジケータドット（C4, C5）を描画
    for (const key of projectedKeys) {
      if (key.isC && key.indicatorCenterCamera && key.indicatorRadiusCamera) {
        this.drawIndicatorDot(ctx, key.indicatorCenterCamera, key.indicatorRadiusCamera);
      }
    }

    ctx.restore();
  }

  /**
   * 打鍵中キーの面発光ハイライト描画
   */
  private static drawKeyHighlight(ctx: CanvasRenderingContext2D, key: ProjectedKey): void {
    const [c0, c1, c2, c3] = key.cornersCamera;

    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();

    // 加算半透明白塗りつぶし
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
  }

  /**
   * 1本の鍵盤の四角形ワイヤーフレームを描画
   */
  private static drawKeyWireframe(ctx: CanvasRenderingContext2D, key: ProjectedKey): void {
    const [c0, c1, c2, c3] = key.cornersCamera;

    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();

    // 半透明白線
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.stroke();
  }

  /**
   * Cキー上端の直径2mm相当のインジケータドットを描画
   */
  private static drawIndicatorDot(
    ctx: CanvasRenderingContext2D,
    center: { x: number; y: number },
    radius: number
  ): void {
    const r = Math.max(1.5, radius);

    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
