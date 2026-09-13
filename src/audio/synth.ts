/**
 * GCフリー・低遅延Web Audioポリフォニック・シンセサイザーモジュール
 * 打鍵時のオブジェクト生成・GC負荷を完全に排除するため、固定長ボイスプール内の
 * AudioNodeを事前生成・常時発振させ、Gainエンベロープの制御のみで発音・消音を行います。
 */

export type VoiceId = number;

export enum VoiceState {
  IDLE = 0,
  ATTACK = 1,
  SUSTAIN = 2,
  RELEASE = 3,
}

/** 1つの発音単位（ボイス）の構造体 */
export interface Voice {
  id: VoiceId;
  oscPrimary: OscillatorNode;   // 基音（三角波）
  oscSecondary: OscillatorNode; // 第2倍音（正弦波）
  gainSecondary: GainNode;      // 倍音音量バランス
  gainVoice: GainNode;          // ボイスマスターエンベロープ
  state: VoiceState;
  currentMidiNote: number;
  noteOnTime: number;
  releaseEndTime: number;
}

/** 14鍵白鍵（C4〜B5）のMIDIノートおよび音階定義 */
export const WHITE_KEYS_MIDI_NOTES: number[] = [
  60, // C4
  62, // D4
  64, // E4
  65, // F4
  67, // G4
  69, // A4 (440Hz)
  71, // B4
  72, // C5
  74, // D5
  76, // E5
  77, // F5
  79, // G5
  81, // A5
  83, // B5
];

/** MIDIノート番号から周波数（Hz）への事前計算マップ */
export const MIDI_TO_FREQUENCY: Record<number, number> = {};
for (let note = 48; note <= 96; note++) {
  MIDI_TO_FREQUENCY[note] = 440 * Math.pow(2, (note - 69) / 12);
}

/** シンセサイザー設定定数 */
export const SYNTH_CONFIG = {
  poolSize: 16,             // ボイスプールの固定サイズ
  attackTimeSec: 0.003,     // アタック: 3ms（最速かつクリック防止）
  decayTimeConstant: 0.4,   // ディケイ時定数（ピアノらしい自然な減衰）
  sustainRatio: 0.25,       // サステイン減衰目標音量比
  releaseTimeSec: 0.050,    // リリース: 50ms（離鍵ノイズ防止）
  maxVoiceGain: 0.25,       // 単一ボイスの最大ゲイン（和音時のクリッピング防止）
  secondaryHarmonicRatio: 0.35, // 第2倍音の音量比
  masterVolume: 0.8,        // マスター音量
};

export class WebAudioPianoSynth {
  private static instance: WebAudioPianoSynth | null = null;

  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private voices: Voice[] = [];
  private isInitialized: boolean = false;

  // 14白鍵の各キーに現在割り当てられているボイスID（重複発音防止・高速オフ用）
  private activeKeyVoiceMap: Int32Array = new Int32Array(14).fill(-1);

  private constructor() {}

  /**
   * シングルトンインスタンスの取得
   */
  public static getInstance(): WebAudioPianoSynth {
    if (!WebAudioPianoSynth.instance) {
      WebAudioPianoSynth.instance = new WebAudioPianoSynth();
    }
    return WebAudioPianoSynth.instance;
  }

  /**
   * AudioContextの生成とボイスプールの事前確保（ユーザー操作時に呼出）
   */
  public async initAudio(): Promise<boolean> {
    if (this.isInitialized && this.audioCtx && this.audioCtx.state === 'running') {
      return true;
    }

    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.audioCtx = new AudioContextClass({
          latencyHint: 'interactive',
        });

        // マスターゲイン設定
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.setValueAtTime(SYNTH_CONFIG.masterVolume, this.audioCtx.currentTime);
        this.masterGain.connect(this.audioCtx.destination);

        // ボイスプール（16ボイス）の事前確保
        this.initVoicePool(this.audioCtx, this.masterGain);
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.isInitialized = true;
      return true;
    } catch (err) {
      console.error('[WebAudioPianoSynth] AudioContext初期化失敗:', err);
      return false;
    }
  }

  /**
   * 固定16ボイスのノードを事前生成し、常時発振状態にします。
   */
  private initVoicePool(ctx: AudioContext, destination: GainNode): void {
    this.voices = [];

    for (let i = 0; i < SYNTH_CONFIG.poolSize; i++) {
      // 1. 基音オシレーター（三角波：ふくよかな基音）
      const oscPrimary = ctx.createOscillator();
      oscPrimary.type = 'triangle';
      oscPrimary.frequency.setValueAtTime(440, ctx.currentTime);

      // 2. 第2倍音オシレーター（正弦波：ピアノ特有の高調波）
      const oscSecondary = ctx.createOscillator();
      oscSecondary.type = 'sine';
      oscSecondary.frequency.setValueAtTime(880, ctx.currentTime);

      const gainSecondary = ctx.createGain();
      gainSecondary.gain.setValueAtTime(SYNTH_CONFIG.secondaryHarmonicRatio, ctx.currentTime);
      oscSecondary.connect(gainSecondary);

      // 3. ボイスマスターゲイン（エンベロープ担当）
      const gainVoice = ctx.createGain();
      // 初期状態は完全消音
      gainVoice.gain.setValueAtTime(0.0001, ctx.currentTime);

      oscPrimary.connect(gainVoice);
      gainSecondary.connect(gainVoice);
      gainVoice.connect(destination);

      // オシレーターを常時稼働（以後 stop() は一切呼ばない）
      oscPrimary.start();
      oscSecondary.start();

      this.voices.push({
        id: i,
        oscPrimary,
        oscSecondary,
        gainSecondary,
        gainVoice,
        state: VoiceState.IDLE,
        currentMidiNote: -1,
        noteOnTime: 0,
        releaseEndTime: 0,
      });
    }
  }

  /**
   * 指定MIDIノートを発音し、割り当てられたVoiceIdを返します。
   * オブジェクト生成を一切行わず、事前生成済みのボイスを再利用します。
   */
  public triggerNoteOn(midiNote: number): VoiceId {
    if (!this.audioCtx || !this.isInitialized) {
      this.initAudio();
      return -1;
    }

    const now = this.audioCtx.currentTime;
    const voice = this.allocateVoice(now);
    if (!voice) return -1;

    const freq = MIDI_TO_FREQUENCY[midiNote] || 440 * Math.pow(2, (midiNote - 69) / 12);
    const targetGain = SYNTH_CONFIG.maxVoiceGain;

    // 周波数の瞬時切り替え（基音 + 第2倍音）
    voice.oscPrimary.frequency.setValueAtTime(freq, now);
    voice.oscSecondary.frequency.setValueAtTime(freq * 2.0, now);

    // エンベロープのスケジューリング
    const gain = voice.gainVoice.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0.0001, now);

    // 1. アタック（3ms: クリックノイズ防止＆最速レスポンス）
    const attackEnd = now + SYNTH_CONFIG.attackTimeSec;
    gain.linearRampToValueAtTime(targetGain, attackEnd);

    // 2. ディケイ/サステイン（ピアノ調の指数関数減衰）
    gain.setTargetAtTime(
      targetGain * SYNTH_CONFIG.sustainRatio,
      attackEnd,
      SYNTH_CONFIG.decayTimeConstant
    );

    // ボイス状態の更新
    voice.state = VoiceState.ATTACK;
    voice.currentMidiNote = midiNote;
    voice.noteOnTime = now;
    voice.releaseEndTime = 0;

    return voice.id;
  }

  /**
   * 指定されたVoiceIdの発音をリリース（50msフェードアウト）します。
   */
  public triggerNoteOff(voiceId: VoiceId): void {
    if (!this.audioCtx || voiceId < 0 || voiceId >= this.voices.length) {
      return;
    }

    const voice = this.voices[voiceId];
    if (voice.state === VoiceState.IDLE) return;

    const now = this.audioCtx.currentTime;
    const gain = voice.gainVoice.gain;

    // 現在の出力ゲインから50msかけて無音へフェード
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0.0001, now + SYNTH_CONFIG.releaseTimeSec);

    voice.state = VoiceState.RELEASE;
    voice.releaseEndTime = now + SYNTH_CONFIG.releaseTimeSec;
  }

  /**
   * 14鍵白鍵インデックス（0〜13: C4〜B5）に対応する発音を開始
   */
  public triggerKeyIndexOn(keyIndex: number): VoiceId {
    if (keyIndex < 0 || keyIndex >= WHITE_KEYS_MIDI_NOTES.length) {
      return -1;
    }

    // 既に発音中なら一度オフにしてから再トリガー（連続打鍵の明瞭化）
    const existingVoiceId = this.activeKeyVoiceMap[keyIndex];
    if (existingVoiceId !== -1) {
      this.triggerNoteOff(existingVoiceId);
    }

    const midiNote = WHITE_KEYS_MIDI_NOTES[keyIndex];
    const voiceId = this.triggerNoteOn(midiNote);
    this.activeKeyVoiceMap[keyIndex] = voiceId;
    return voiceId;
  }

  /**
   * 14鍵白鍵インデックス（0〜13: C4〜B5）の発音を停止
   */
  public triggerKeyIndexOff(keyIndex: number): void {
    if (keyIndex < 0 || keyIndex >= WHITE_KEYS_MIDI_NOTES.length) {
      return;
    }

    const voiceId = this.activeKeyVoiceMap[keyIndex];
    if (voiceId !== -1) {
      this.triggerNoteOff(voiceId);
      this.activeKeyVoiceMap[keyIndex] = -1;
    }
  }

  /**
   * 空きボイスの検索、または最古ボイスのスチール
   * メモリ割り当て（GC）を一切行いません。
   */
  private allocateVoice(now: number): Voice | null {
    if (this.voices.length === 0) return null;

    // 1. 完全アイドル状態のボイスを探索
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.state === VoiceState.IDLE) {
        return v;
      }
      // リリース時間が経過して消音完了したボイスを再利用
      if (v.state === VoiceState.RELEASE && now >= v.releaseEndTime) {
        v.state = VoiceState.IDLE;
        return v;
      }
    }

    // 2. 空きがない場合：最も古くにリリース中に入ったボイスをスチール
    let oldestReleaseVoice: Voice | null = null;
    let earliestReleaseTime = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.state === VoiceState.RELEASE && v.releaseEndTime < earliestReleaseTime) {
        earliestReleaseTime = v.releaseEndTime;
        oldestReleaseVoice = v;
      }
    }

    if (oldestReleaseVoice) {
      return oldestReleaseVoice;
    }

    // 3. 全て発音中の場合：最も古い noteOnTime のボイスをスチール（Voice Stealing）
    let oldestVoice: Voice = this.voices[0];
    let earliestNoteOn = this.voices[0].noteOnTime;

    for (let i = 1; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.noteOnTime < earliestNoteOn) {
        earliestNoteOn = v.noteOnTime;
        oldestVoice = v;
      }
    }

    return oldestVoice;
  }

  /**
   * 全ボイスの強制消音
   */
  public allNotesOff(): void {
    if (!this.audioCtx) return;
    const now = this.audioCtx.currentTime;

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      v.gainVoice.gain.cancelScheduledValues(now);
      v.gainVoice.gain.setValueAtTime(0.0001, now);
      v.state = VoiceState.IDLE;
    }

    this.activeKeyVoiceMap.fill(-1);
  }

  /**
   * 現在の初期化状態
   */
  public get isReady(): boolean {
    return this.isInitialized && this.audioCtx !== null && this.audioCtx.state === 'running';
  }
}
