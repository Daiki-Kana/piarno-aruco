/**
 * js-aruco2 型定義ファイル
 */

declare module 'js-aruco2' {
  export namespace AR {
    export interface Point {
      x: number;
      y: number;
    }

    export interface Marker {
      id: number;
      corners: Point[];
    }

    export interface DetectorOptions {
      dictionaryName?: string;
      maxHammingDistance?: number;
    }

    export class Detector {
      constructor(options?: DetectorOptions);
      detect(imageData: ImageData): Marker[];
      detect(width: number, height: number, data: Uint8ClampedArray): Marker[];
    }

    export const DICTIONARIES: Record<string, unknown>;
  }
}
