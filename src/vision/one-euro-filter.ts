/**
 * 1 Euro Filter（適応型ローパスフィルタ）モジュール
 * 低速時の手ブレ（ジッター）を除去し、高速移動時の追従遅延（ラグ）を最小化します。
 * 指先ポインタの画面描画用パイプラインで使用します。
 */

export interface OneEuroFilterConfig {
  /** 最小カットオフ周波数 (Hz) - 低速・静止時のジッター抑制 (デフォルト: 1.2) */
  minCutoff?: number;
  /** 速度係数 - 高速移動時のカットオフ周波数引き上げ感度 (デフォルト: 0.1) */
  beta?: number;
  /** 微分カットオフ周波数 (Hz) (デフォルト: 1.0) */
  dCutoff?: number;
}

/** 1次ローパスフィルタ */
class LowPassFilter {
  private hatXPrev: number | null = null;

  public filter(x: number, alpha: number): number {
    if (this.hatXPrev === null) {
      this.hatXPrev = x;
    } else {
      this.hatXPrev = alpha * x + (1.0 - alpha) * this.hatXPrev;
    }
    return this.hatXPrev;
  }

  public lastValue(): number | null {
    return this.hatXPrev;
  }

  public reset(): void {
    this.hatXPrev = null;
  }
}

/** 1次元 1 Euro Filter */
export class OneEuroFilter1D {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xFilter: LowPassFilter = new LowPassFilter();
  private dxFilter: LowPassFilter = new LowPassFilter();
  private lastTimeMs: number | null = null;

  constructor(config: OneEuroFilterConfig = {}) {
    this.minCutoff = config.minCutoff ?? 1.2;
    this.beta = config.beta ?? 0.1;
    this.dCutoff = config.dCutoff ?? 1.0;
  }

  private computeAlpha(rate: number, cutoff: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    const te = 1.0 / rate;
    return 1.0 / (1.0 + tau / te);
  }

  public filter(x: number, timestampMs: number): number {
    if (this.lastTimeMs === null) {
      this.lastTimeMs = timestampMs;
      return this.xFilter.filter(x, 1.0);
    }

    const dt = (timestampMs - this.lastTimeMs) / 1000.0;
    this.lastTimeMs = timestampMs;

    if (dt <= 0.0001) {
      return this.xFilter.lastValue() ?? x;
    }

    const rate = 1.0 / dt;

    // 1. 微分値（変化速度 dx）の平滑化
    const prevX = this.xFilter.lastValue() ?? x;
    const dx = (x - prevX) * rate;
    const edx = this.dxFilter.filter(dx, this.computeAlpha(rate, this.dCutoff));

    // 2. 変化速度に応じたカットオフ周波数の動的更新
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);

    // 3. 適応的平滑化の適用
    return this.xFilter.filter(x, this.computeAlpha(rate, cutoff));
  }

  public reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimeMs = null;
  }
}

/** 2次元（X, Y）1 Euro Filter */
export class OneEuroFilter2D {
  private filterX: OneEuroFilter1D;
  private filterY: OneEuroFilter1D;

  constructor(config: OneEuroFilterConfig = {}) {
    this.filterX = new OneEuroFilter1D(config);
    this.filterY = new OneEuroFilter1D(config);
  }

  public filter(x: number, y: number, timestampMs: number): { x: number; y: number } {
    return {
      x: this.filterX.filter(x, timestampMs),
      y: this.filterY.filter(y, timestampMs),
    };
  }

  public reset(): void {
    this.filterX.reset();
    this.filterY.reset();
  }
}
