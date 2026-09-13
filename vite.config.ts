import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { qrcode } from 'vite-plugin-qrcode';

// Vite設定: スマホ実機からのHTTPS接続およびWebAR/カメラ利用を可能にする
// --mode http 指定時はHTTPモードで起動可能（ローカルテスト用）
export default defineConfig(({ mode }) => {
  const isHttp = mode === 'http';

  return {
    plugins: [
      ...(isHttp ? [] : [basicSsl()]),
      qrcode() // 開発サーバー起動時にQRコードをターミナルに表示
    ],
    server: {
      host: true, // ローカルネットワーク内の他デバイスからアクセス可能にする
      https: isHttp ? undefined : true, // WebAR/カメラAPI利用のためにHTTPSを有効化
      port: 5175
    }
  };
});
