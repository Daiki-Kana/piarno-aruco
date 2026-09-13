/**
 * test-keystroke-analyzer.mjs
 * 関節圧縮 ＆ 4状態打鍵ステートマシンの単体動作シミュレーション
 */

import { KeystrokeAnalyzer, STATE } from './js/keystroke-analyzer.js';

const analyzer = new KeystrokeAnalyzer();

let noteOnEvents = [];
let noteOffEvents = [];

analyzer.onNoteOn((e) => {
  noteOnEvents.push(e);
});

analyzer.onNoteOff((e) => {
  noteOffEvents.push(e);
});

// 手のダミーランドマークを生成する関数
function createHand(tipY, mcpY = 0.5, wristY = 0.8) {
  const landmarks = Array(21).fill(null).map(() => ({ x: 0.1, y: 0.5, z: 0 }));
  landmarks[0] = { x: 0.1, y: wristY, z: 0 }; // Wrist
  landmarks[9] = { x: 0.1, y: mcpY, z: 0 };   // Middle MCP (基準長用: 0.3)
  landmarks[5] = { x: 0.1, y: mcpY, z: 0 };   // Index MCP
  landmarks[6] = { x: 0.1, y: mcpY + (tipY - mcpY) * 0.3, z: 0 };
  landmarks[7] = { x: 0.1, y: mcpY + (tipY - mcpY) * 0.6, z: 0 };
  landmarks[8] = { x: 0.1, y: tipY, z: 0 };   // Index Tip
  return [{
    handedness: 'Right',
    landmarks
  }];
}

console.log("=== 1. IDLE状態テスト ===");
let hands = createHand(0.55);
let res = analyzer.analyze(hands);
console.log("Index State:", res[0]?.fingers?.Index?.smState, "vy:", res[0]?.fingers?.Index?.velocityY, "lNorm:", res[0]?.fingers?.Index?.lNorm);

console.log("\n=== 2. 下降フェーズ (STRIKING) ===");
await new Promise(r => setTimeout(r, 20)); // 時間経過を進める
hands = createHand(0.65);
res = analyzer.analyze(hands);
console.log("Index State:", res[0]?.fingers?.Index?.smState, "vy:", res[0]?.fingers?.Index?.velocityY, "lNorm:", res[0]?.fingers?.Index?.lNorm);

console.log("\n=== 3. 接触・関節圧縮フェーズ (IMPACT) ===");
await new Promise(r => setTimeout(r, 20));
// tipY は机に衝突して停止（0.65のまま）、MCPが慣性で沈み込む（0.50 -> 0.58）
hands = createHand(0.65, 0.58);
res = analyzer.analyze(hands);
console.log("Index State:", res[0]?.fingers?.Index?.smState, "vy:", res[0]?.fingers?.Index?.velocityY, "lNorm:", res[0]?.fingers?.Index?.lNorm);
console.log("Note On count:", noteOnEvents.length);
if (noteOnEvents.length > 0) {
  console.log(" 発音成功:", noteOnEvents[0].note, "Key:", noteOnEvents[0].keyId);
}

console.log("\n=== 4. 跳ね返り・離鍵待機フェーズ (REBOUND: 多重発音ロック確認) ===");
// 同じ状態が続いても再発音しないこと
analyzer.analyze(hands);
console.log("Note On count (must still be 1):", noteOnEvents.length);

console.log("\n=== 5. 離鍵・伸長復帰フェーズ (Note Off確認) ===");
await new Promise(r => setTimeout(r, 30));
// 指が浮上（tipYが 0.65 -> 0.45 に急浮上: vy < reboundLiftVelocity）
hands = createHand(0.45, 0.40);
res = analyzer.analyze(hands);
console.log("Index State:", res[0]?.fingers?.Index?.smState, "vy:", res[0]?.fingers?.Index?.velocityY);
console.log("Note Off count:", noteOffEvents.length);
if (noteOffEvents.length > 0) {
  console.log(" 消音成功:", noteOffEvents[0].keyId);
}

console.log("\n全ステートマシン遷移テスト完了！");
