const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ─── サッカー用語の読み補正（VoiceVoxのノウハウを継承！） ──────────────────
function sanitizeForTTS(text) {
  return (text || "")
    .replace(/W杯/g, "ワールドカップ")
    .replace(/CL/g, "チャンピオンズリーグ")
    .replace(/PL/g, "プレミアリーグ")
    .replace(/三笘/g, "みとま")
    .replace(/久保/g, "くぼたけふさ")
    .replace(/！/g, "。") // MiniMaxは「！」より「。」の方が自然な間が開くことがあるよ
    .trim();
}

// ─── ボイスマッピング（VoiceVox ID -> MiniMax Voice ID） ──────────────────
const VOICE_MAP = {
  13: "English_ManWithDeepVoice", // 青山龍星風 -> 渋い低音
  3:  "Japanese_InnocentBoy",     // ずんだもん風 -> 無邪気な少年
  11: "Japanese_CalmLady",        // 小夜風 -> 落ち着いた女性
  0:  "Japanese_GracefulMaiden"   // めたん風 -> 上品な女性
};

const API_KEY = process.env.MINIMAX_API_KEY;
const GROUP_ID = process.env.MINIMAX_GROUP_ID;

async function generateMiniMaxTTS(speakerId, text, filename) {
  const voiceId = VOICE_MAP[speakerId] || "Japanese_CalmLady";
  const safeText = sanitizeForTTS(text);
  const outPath = path.join(__dirname, '../temp', filename);

  console.log(`🎙️ 生成中: [Speaker ${speakerId} -> ${voiceId}] "${safeText.substring(0, 15)}..."`);

  try {
    const res = await axios.post(
      `https://api-uw.minimax.io/v1/t2a_v2?GroupId=${GROUP_ID}`,
      {
        model: "speech-2.8-hd", // 画面に表示されている最新モデルに変更！
        text: safeText,
        voice_setting: {
          voice_id: voiceId,
          speed: 1.0,
          vol: 1.0,
          pitch: 0
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1
        },
        output_format: "hex"
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (res.data.data && res.data.data.audio) {
      fs.writeFileSync(outPath, Buffer.from(res.data.data.audio, 'hex'));
      console.log(`✅ 保存完了: ${outPath}`);
      return outPath;
    } else {
      console.error("❌ APIからの応答に音声データが含まれていません:", res.data);
    }
  } catch (err) {
    console.error("❌ リクエスト失敗:", err.response ? err.response.data : err.message);
  }
}

// テスト実行
(async () => {
  if (!fs.existsSync(path.join(__dirname, '../temp'))) {
    fs.mkdirSync(path.join(__dirname, '../temp'));
  }
  
  console.log("🚀 MiniMax TTS テストを開始するよ！");
  await generateMiniMaxTTS(13, "バイエルンのコンパニ監督が歴史的な勝利を収めました。実に25年ぶりの快挙です！", "test_minimax_narration.mp3");
  await generateMiniMaxTTS(3,  "バーンリーの監督を雇えばレアルに勝てるってマジかよ（笑）。信じられないぜ！", "test_minimax_zundamon.mp3");
  console.log("\n✨ 全てのテスト生成が終わったよ！相棒、tempフォルダの中身を聴いてみて！");
})();
