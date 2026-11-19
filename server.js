const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const envPath = path.join(__dirname, '.env');

// 매 요청마다 .env 파일을 새로 읽어서 서버 재시작 없이도 즉시 반영되게 함
function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] = val;
    }
  }
}

const PLACEHOLDERS = new Set([
  '여기에_발급받은_API_키를_입력하세요',
  'your_gemini_api_key_here',
  'your_openai_api_key_here',
]);

// Gemini API 키 정제 및 추출 (AIza...)
function sanitizeGeminiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  const trimmed = rawKey.trim();
  if (PLACEHOLDERS.has(trimmed)) return '';
  const match = trimmed.match(/AIza[0-9A-Za-z_-]{30,50}/);
  if (match) return match[0];
  if (!trimmed.startsWith('sk-') && /^[\x21-\x7E]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

// OpenAI (ChatGPT) API 키 정제 및 추출 (sk-...)
function sanitizeOpenAIKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  const trimmed = rawKey.trim();
  if (PLACEHOLDERS.has(trimmed)) return '';
  const match = trimmed.match(/sk-[0-9A-Za-z_-]{20,250}/);
  if (match) return match[0];
  if (!trimmed.startsWith('AIza') && /^[\x21-\x7E]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

loadEnv();

const PORT = process.env.PORT || 3000;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function saveEnvFile(geminiKey, openaiKey) {
  const lines = [
    '# Google Gemini 및 OpenAI(ChatGPT) API 키 설정 (서버 전용, 브라우저 노출 차단)',
    `GEMINI_API_KEY=${geminiKey || '여기에_발급받은_API_키를_입력하세요'}`,
    `OPENAI_API_KEY=${openaiKey || '여기에_발급받은_API_키를_입력하세요'}`,
    `GEMINI_MODEL=${DEFAULT_GEMINI_MODEL}`,
    `OPENAI_MODEL=${DEFAULT_OPENAI_MODEL}`,
    `PORT=${PORT}`,
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
}

async function callGeminiWithFallback(apiKey, requestedModel, systemInstruction, contents) {
  const candidateModels = [
    requestedModel,
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-lite-latest',
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastError = null;
  let lastStatus = 500;

  for (const modelName of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      modelName
    )}:generateContent`;

    const geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
        },
      }),
    });

    const data = await geminiRes.json();

    if (geminiRes.ok) {
      const reply =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ||
        '응답을 생성하지 못했습니다.';
      return { ok: true, reply, usedModel: modelName };
    }

    lastStatus = geminiRes.status;
    lastError = data?.error?.message || `Gemini API 오류 (HTTP ${geminiRes.status})`;

    if (geminiRes.status !== 404) {
      break;
    }
  }

  return { ok: false, status: lastStatus, error: lastError };
}

async function callOpenAIWithFallback(apiKey, requestedModel, systemInstruction, history, message) {
  const candidateModels = [
    requestedModel,
    'gpt-4o-mini',
    'gpt-4.1-mini',
    'gpt-4o',
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  const messages = [
    { role: 'system', content: systemInstruction },
    ...history.map((msg) => ({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: String(msg.text || ''),
    })),
    { role: 'user', content: String(message || '') },
  ];

  let lastError = null;
  let lastStatus = 500;

  for (const modelName of candidateModels) {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
      }),
    });

    const data = await openaiRes.json();

    if (openaiRes.ok) {
      const reply =
        data?.choices?.[0]?.message?.content || '응답을 생성하지 못했습니다.';
      return { ok: true, reply, usedModel: modelName };
    }

    lastStatus = openaiRes.status;
    lastError = data?.error?.message || `OpenAI API 오류 (HTTP ${openaiRes.status})`;

    if (openaiRes.status !== 404) {
      break;
    }
  }

  return { ok: false, status: lastStatus, error: lastError };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'GET' && req.url === '/api/status') {
    loadEnv();
    const geminiKey = sanitizeGeminiKey(process.env.GEMINI_API_KEY);
    const openaiKey = sanitizeOpenAIKey(process.env.OPENAI_API_KEY);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        configured: Boolean(geminiKey || openaiKey),
        geminiConfigured: Boolean(geminiKey),
        openaiConfigured: Boolean(openaiKey),
        geminiModel: DEFAULT_GEMINI_MODEL,
        openaiModel: DEFAULT_OPENAI_MODEL,
      })
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-key') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', () => {
      try {
        loadEnv();
        const payload = JSON.parse(body);
        let currentGemini = sanitizeGeminiKey(process.env.GEMINI_API_KEY);
        let currentOpenAI = sanitizeOpenAIKey(process.env.OPENAI_API_KEY);

        // 만약 사용자가 어느 칸에 넣었든 키 형태(AIza... vs sk-...)에 따라 자동 분류 지원
        const rawInputs = [payload.geminiKey, payload.openaiKey, payload.apiKey].filter(Boolean);
        let updatedAny = false;

        if (payload.geminiKey !== undefined && payload.geminiKey.trim() !== '') {
          const raw = payload.geminiKey.trim();
          if (raw.startsWith('sk-')) {
            const k = sanitizeOpenAIKey(raw);
            if (k) { currentOpenAI = k; updatedAny = true; }
          } else {
            const k = sanitizeGeminiKey(raw);
            if (k) { currentGemini = k; updatedAny = true; }
          }
        }

        if (payload.openaiKey !== undefined && payload.openaiKey.trim() !== '') {
          const raw = payload.openaiKey.trim();
          if (raw.startsWith('AIza')) {
            const k = sanitizeGeminiKey(raw);
            if (k) { currentGemini = k; updatedAny = true; }
          } else {
            const k = sanitizeOpenAIKey(raw);
            if (k) { currentOpenAI = k; updatedAny = true; }
          }
        }

        if (payload.apiKey !== undefined && payload.apiKey.trim() !== '') {
          const raw = payload.apiKey.trim();
          if (raw.startsWith('sk-')) {
            const k = sanitizeOpenAIKey(raw);
            if (k) { currentOpenAI = k; updatedAny = true; }
          } else {
            const k = sanitizeGeminiKey(raw);
            if (k) { currentGemini = k; updatedAny = true; }
          }
        }

        if (rawInputs.length > 0 && !updatedAny) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error:
                '유효하지 않은 API 키 형식입니다. Gemini 키(AIza...) 또는 ChatGPT 키(sk-...)를 정확히 복사해 붙여넣어 주세요.',
            })
          );
          return;
        }

        process.env.GEMINI_API_KEY = currentGemini;
        process.env.OPENAI_API_KEY = currentOpenAI;
        saveEnvFile(currentGemini, currentOpenAI);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            geminiConfigured: Boolean(currentGemini),
            openaiConfigured: Boolean(currentOpenAI),
          })
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    loadEnv();
    const geminiKey = sanitizeGeminiKey(process.env.GEMINI_API_KEY);
    const openaiKey = sanitizeOpenAIKey(process.env.OPENAI_API_KEY);

    if (!geminiKey && !openaiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error:
            '등록된 API 키가 없습니다. 우측 상단 [🔒 보안 연결 설정] 버튼을 눌러 Google Gemini(AIza...) 또는 ChatGPT(sk-...) API 키를 등록해주세요.',
        })
      );
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });

    req.on('end', async () => {
      try {
        const { history = [], message, memoContext, model } = JSON.parse(body);
        let targetModel = model || DEFAULT_GEMINI_MODEL;
        let isOpenAIModel = targetModel.startsWith('gpt-') || targetModel.startsWith('o1') || targetModel.startsWith('o3') || targetModel.startsWith('o4');

        // 선택한 모델의 키가 없고 다른 쪽 키만 등록되어 있다면 등록된 제공자로 자동 전환
        if (isOpenAIModel && !openaiKey && geminiKey) {
          isOpenAIModel = false;
          targetModel = DEFAULT_GEMINI_MODEL;
        } else if (!isOpenAIModel && !geminiKey && openaiKey) {
          isOpenAIModel = true;
          targetModel = DEFAULT_OPENAI_MODEL;
        }

        const systemInstruction = memoContext
          ? `당신은 스마트 메모 앱에 내장된 친절하고 유능한 AI 어시스턴트입니다. 사용자의 메모 작성을 돕고, 요약, 다듬기, 아이디어 확장, 질문 답변을 수행합니다.\n\n[현재 사용자가 보고 있는 메모 내용]\n제목: ${memoContext.title || '(제목 없음)'}\n내용:\n${memoContext.content || '(내용 없음)'}`
          : '당신은 스마트 메모 앱에 내장된 친절하고 유능한 AI 어시스턴트입니다.';

        let result;
        if (isOpenAIModel) {
          result = await callOpenAIWithFallback(
            openaiKey,
            targetModel,
            systemInstruction,
            history,
            message
          );
        } else {
          const contents = [
            ...history.map((msg) => ({
              role: msg.role === 'ai' ? 'model' : 'user',
              parts: [{ text: String(msg.text || '') }],
            })),
            {
              role: 'user',
              parts: [{ text: String(message || '') }],
            },
          ];
          result = await callGeminiWithFallback(
            geminiKey,
            targetModel,
            systemInstruction,
            contents
          );
        }

        if (!result.ok) {
          res.writeHead(result.status, {
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ reply: result.reply, model: result.usedModel }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            error: '요청 처리 중 오류가 발생했습니다: ' + err.message,
          })
        );
      }
    });
    return;
  }

  if (req.method === 'GET') {
    const safeUrl = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    if (
      safeUrl.includes('..') ||
      path.basename(safeUrl).startsWith('.') ||
      safeUrl === '/server.js'
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    const filePath = path.join(__dirname, safeUrl);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

function openBrowser(url, cb) {
  if (process.argv.includes('--open')) {
    exec(`explorer.exe "${url}"`, () => {
      if (cb) cb();
    });
  } else if (cb) {
    cb();
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`포트 ${PORT}에서 이미 서버가 실행 중입니다. 브라우저를 엽니다.`);
    openBrowser(`http://localhost:${PORT}`, () => {
      setTimeout(() => process.exit(0), 500);
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`====================================================`);
  console.log(`🚀 보안 메모 + Gemini / ChatGPT 앱이 실행되었습니다!`);
  console.log(`👉 브라우저 접속 주소: http://localhost:${PORT}`);
  console.log(`🔒 API 키는 서버(.env)에서만 읽히며 브라우저에 노출되지 않습니다.`);
  console.log(`====================================================`);
  openBrowser(`http://localhost:${PORT}`);
});
