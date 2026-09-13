/**
 * カメラ制御およびビデオフレーム描画ループモジュール
 * 背面カメラの取得、解像度同期、requestVideoFrameCallback による高効率ループを管理します。
 */

export interface CameraManagerOptions {
  videoElement: HTMLVideoElement;
  onFrame?: (now: DOMHighResTimeStamp, metadata?: VideoFrameCallbackMetadata) => void;
}

export class CameraManager {
  private video: HTMLVideoElement;
  private onFrameCallback?: (now: DOMHighResTimeStamp, metadata?: VideoFrameCallbackMetadata) => void;
  private stream: MediaStream | null = null;
  private isRunning: boolean = false;
  private frameCallbackId: number | null = null;

  constructor(options: CameraManagerOptions) {
    this.video = options.videoElement;
    this.onFrameCallback = options.onFrame;
  }

  /**
   * 背面カメラ（environment）を高解像度・高フレームレートで起動します。
   */
  public async start(): Promise<boolean> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('このブラウザはカメラAPI (getUserMedia) に対応していません。');
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }, // 背面カメラを優先
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, min: 30 },
        },
        audio: false,
      });

      this.video.srcObject = this.stream;

      // メタデータロード完了を待機（最大3秒のタイムアウト付き）
      await new Promise<void>((resolve) => {
        if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve();
          return;
        }
        const timer = setTimeout(() => resolve(), 3000);
        this.video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      await this.video.play().catch(() => {});
      this.isRunning = true;
      this.scheduleNextFrame();
      return true;
    } catch (error) {
      console.error('カメラ起動エラー:', error);
      return false;
    }
  }

  /**
   * requestVideoFrameCallback または requestAnimationFrame によるループ実行
   */
  private scheduleNextFrame(): void {
    if (!this.isRunning) return;

    if ('requestVideoFrameCallback' in this.video) {
      // Chrome/Edge/Safari等: 新しいカメラフレーム到着時のみ正確に発火
      (this.video as any).requestVideoFrameCallback(
        (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
          if (!this.isRunning) return;
          if (this.onFrameCallback) {
            this.onFrameCallback(now, metadata);
          }
          this.scheduleNextFrame();
        }
      );
    } else {
      // フォールバック: requestAnimationFrame
      this.frameCallbackId = requestAnimationFrame((now) => {
        if (!this.isRunning) return;
        if (this.onFrameCallback) {
          this.onFrameCallback(now);
        }
        this.scheduleNextFrame();
      });
    }
  }

  /**
   * カメラストリームおよびループを停止します。
   */
  public stop(): void {
    this.isRunning = false;
    if (this.frameCallbackId !== null) {
      cancelAnimationFrame(this.frameCallbackId);
      this.frameCallbackId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  /**
   * ビデオ要素の実際の解像度幅を取得
   */
  public get videoWidth(): number {
    return this.video.videoWidth || 1280;
  }

  /**
   * ビデオ要素の実際の解像度高さを取得
   */
  public get videoHeight(): number {
    return this.video.videoHeight || 720;
  }

  /**
   * 現在稼働中か
   */
  public get active(): boolean {
    return this.isRunning;
  }
}
