// 君斗りんく 音声相談デモ
// 音声入力 → キャラ口調で応答生成 → VOICEVOXで音声合成 → LINE風トークに音声メッセージとして表示・再生

const VOICEVOX_BASE = '/vv'; // server.mjsのプロキシ経由

// 話者ID（ouenmovie/whc-it/script_vertical.py の VOICE 辞書と同一）
const VOICE_ID = {
  tanunee: 14, // 冥鳴ひまり
  link: 8,     // 春日部つむぎ
  konta: 32,   // 白上虎太郎（わーい）
};

const CHAR_META = {
  tanunee: { name: 'たぬ姉', icon: '🦝' },
  link: { name: 'りんく', icon: '🐺' },
  konta: { name: 'こん太', icon: '🐻' },
};

// クリエイターの悩み相談パターン（streamerfunch既存4コマの題材を踏襲）
// キーワード → { speaker, reply }
const RULES = [
  {
    keys: ['発信', 'つぶやく', '投稿していい', '大丈夫かな', '気にしすぎ', '見られ'],
    speaker: 'tanunee',
    reply: 'それ、気にしすぎな気がするわ。自分では目立つ気がしても、他の人は意外と見てないものよ。伝えたいことは、出してOKなのよ。',
  },
  {
    keys: ['伸びない', 'いいねが', '反応が少ない', 'バズら', 'リポスト'],
    speaker: 'konta',
    reply: '伸びない＝ダメな投稿、とは限らないよ！投稿時間とか、最初の一文でも変わることあるし、落ち込まず次いこ！',
  },
  {
    keys: ['車輪の再発明', '自作', 'ライブラリ', 'ゼロから作'],
    speaker: 'link',
    reply: '学習で自作するのはアリなのだ！でも実務なら、もう既存ライブラリがあるかもしれないから、使えるものを見極めるのも大事なのだ。',
  },
  {
    keys: ['見つけて', '知ってもらえ', '検索', '見つからない'],
    speaker: 'konta',
    reply: '大事なのは独占じゃなくて伝わる工夫だよ！タイトル・サムネ・発信・継続、この4つで見つけてもらう努力が一番効くよ。',
  },
  {
    keys: ['ai', '生成ai', 'ちゃっと', 'chatgpt'],
    speaker: 'link',
    reply: 'AIは使ってもOKなのだ！ただキャラ絵みたいに世界観を守りたいものは固定で運用して、作業効率化のところだけAIに任せる、使い分けが大事なのだ。',
  },
  {
    keys: ['相談', '見積', '費用', 'クライアント', '依頼'],
    speaker: 'tanunee',
    reply: 'たくさん相談したのに最後に「やっぱり自分で」と言われると、ちょっと寂しいわよね。相談にも価値があるの。気持ちよく仕事できる関係が、いちばん長続きするわ。',
  },
  {
    keys: ['告知', '事前登録', 'リリース', '公開'],
    speaker: 'link',
    reply: '作るのに精一杯で告知が後回しになるの、あるあるなのだ！事前登録機能を使えば、公開前から期待を集められるから、次は試してみてほしいのだ。',
  },
  {
    keys: ['疲れ', 'しんど', '不安', '自信ない'],
    speaker: 'tanunee',
    reply: '無理しすぎないでね。作る時間と同じくらい、休む時間も大事よ。ゆっくりでいいから、続けていきましょう。',
  },
];

const FALLBACK = {
  speaker: 'link',
  reply: 'なるほど、それはクリエイターさんあるあるかもなのだ！作ることと届けること、両方大事にしていこうなのだ。',
};

function pickReply(userText) {
  const lower = userText.toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some(k => lower.includes(k.toLowerCase()))) {
      return { speaker: rule.speaker, reply: rule.reply };
    }
  }
  return FALLBACK;
}

// ---------- UI ----------
const thread = document.getElementById('thread');
const micBtn = document.getElementById('micBtn');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const engineStatusEl = document.getElementById('engineStatus');
const voiceOverrideEl = document.getElementById('voiceOverride');

function scrollBottom() {
  thread.scrollTop = thread.scrollHeight;
}

function addUserBubble(text) {
  const row = document.createElement('div');
  row.className = 'row user';
  row.innerHTML = `<div class="bubble user"></div>`;
  row.querySelector('.bubble').textContent = text;
  thread.appendChild(row);
  scrollBottom();
}

function addStatus(text) {
  const el = document.createElement('div');
  el.className = 'status';
  el.textContent = text;
  thread.appendChild(el);
  scrollBottom();
  return el;
}

function addBotVoiceBubble(speakerKey, text, durationSec) {
  const meta = CHAR_META[speakerKey];
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="who-icon">${meta.icon}</div>
    <div class="bubble bot">
      <div class="speaker-tag">${meta.name}</div>
      <div class="voice-msg">
        <button class="play-btn" disabled>▶</button>
        <div class="waveform">${Array.from({length: 18}).map(() => `<span style="height:${6 + Math.random()*14|0}px"></span>`).join('')}</div>
        <div class="dur">${durationSec ? durationSec.toFixed(0) + '"' : '…'}</div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:4px;">${text}</div>
    </div>
  `;
  thread.appendChild(row);
  scrollBottom();
  return row.querySelector('.play-btn');
}

async function synthesize(speakerKey, text) {
  const speakerId = VOICE_ID[speakerKey];
  const q = await fetch(`${VOICEVOX_BASE}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  if (!q.ok) throw new Error('audio_query failed: ' + q.status);
  const query = await q.json();
  const synth = await fetch(`${VOICEVOX_BASE}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!synth.ok) throw new Error('synthesis failed: ' + synth.status);
  const blob = await synth.blob();
  return URL.createObjectURL(blob);
}

async function handleUserMessage(userText) {
  addUserBubble(userText);
  const thinking = addStatus('返信を考えています…');

  let { speaker, reply } = pickReply(userText);
  const override = voiceOverrideEl.value;
  if (override !== 'auto') speaker = override;

  try {
    const audioUrl = await synthesize(speaker, reply);
    thinking.remove();
    const audio = new Audio(audioUrl);
    audio.addEventListener('loadedmetadata', () => {
      const playBtn = addBotVoiceBubble(speaker, reply, audio.duration);
      playBtn.disabled = false;
      playBtn.textContent = '▶';
      playBtn.onclick = () => {
        audio.currentTime = 0;
        audio.play();
        playBtn.textContent = '❚❚';
      };
      audio.onended = () => { playBtn.textContent = '▶'; };
      audio.play();
      playBtn.textContent = '❚❚';
    });
  } catch (e) {
    thinking.remove();
    addStatus('VOICEVOXエンジンに接続できませんでした。VOICEVOXアプリを起動してから再度お試しください。（' + e.message + '）');
  }
}

sendBtn.addEventListener('click', () => {
  const v = textInput.value.trim();
  if (!v) return;
  textInput.value = '';
  handleUserMessage(v);
});
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

// ---------- 音声認識（Web Speech API） ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizing = false;
let recognizer = null;

if (SpeechRecognition) {
  recognizer = new SpeechRecognition();
  recognizer.lang = 'ja-JP';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (event) => {
    const text = event.results[0][0].transcript;
    handleUserMessage(text);
  };
  recognizer.onerror = (event) => {
    addStatus('音声認識でエラーが発生しました: ' + event.error + '（テキスト入力をお試しください）');
  };
  recognizer.onend = () => {
    recognizing = false;
    micBtn.classList.remove('recording');
  };

  micBtn.addEventListener('click', () => {
    if (recognizing) {
      recognizer.stop();
      return;
    }
    recognizing = true;
    micBtn.classList.add('recording');
    addStatus('聞いています…話しかけてね');
    recognizer.start();
  });
} else {
  micBtn.disabled = true;
  micBtn.title = 'このブラウザは音声入力に対応していません（Chrome推奨）';
  addStatus('このブラウザは音声認識に対応していません。テキスト入力をご利用ください（Chrome推奨）。');
}

// ---------- VOICEVOXエンジン疎通確認 ----------
(async () => {
  try {
    const res = await fetch(`${VOICEVOX_BASE}/version`);
    if (res.ok) {
      const v = await res.json();
      engineStatusEl.textContent = `VOICEVOXエンジン接続OK（v${v}）`;
      engineStatusEl.className = 'engine-status ok';
    } else {
      throw new Error('status ' + res.status);
    }
  } catch (e) {
    engineStatusEl.textContent = 'VOICEVOXエンジンに未接続です。VOICEVOXアプリを起動してください。';
    engineStatusEl.className = 'engine-status ng';
  }
})();
