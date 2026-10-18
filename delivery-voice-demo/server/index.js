/**
 * 택배 도착 음성 알림 — 데모 알림 서버 (의존성 없음, Node 18+)
 *
 *   node server/index.js            → 모의 교환기 모드 (상태 전이만 시뮬레이션)
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1xxx node server/index.js
 *                                   → Twilio Programmable Voice 로 실제 전화 발신 (TTS <Say ko-KR>)
 *
 * API
 *   GET  /health
 *   POST /api/drivers/register   { driverId, pin, deviceId }                → { token }
 *   POST /api/voice-notify       { driverId, deviceId, phone, message, ... } → { callId, provider }
 *   GET  /api/calls/:id                                                    → { status, fallback?, ... }
 *   GET  /api/logs
 */
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 4000);
const TWILIO = {
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM,
};
const useTwilio = Boolean(TWILIO.sid && TWILIO.token && TWILIO.from);

const drivers = new Map(); // driverId → { deviceId, token, registeredAt }
const calls = new Map(); // callId → call record

const id = (p) => `${p}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const estimateSpeechMs = (text) => Math.max(2500, String(text).length * 110);

function toE164Kr(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.startsWith('82')) return `+${d}`;
  if (d.startsWith('0')) return `+82${d.slice(1)}`;
  return `+${d}`;
}

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
  });
}

function setStatus(call, status) {
  call.status = status;
  call.history.push({ status, at: Date.now() - call.createdAt });
  console.log(`[call ${call.callId}] +${Date.now() - call.createdAt}ms ${status}`);
}

// 모의 교환기: queued → ringing → in-progress → completed (끝자리 0000 은 no-answer)
function simulateCall(call) {
  const noAnswer = call.phone.endsWith('0000');
  setTimeout(() => setStatus(call, 'ringing'), 350);
  if (noAnswer) {
    setTimeout(() => {
      setStatus(call, 'no-answer');
      call.fallback = 'MMS 음성파일 대체 발송 (서버 시뮬레이션)';
    }, 3500);
    return;
  }
  const answerAt = 350 + 900 + Math.round(Math.random() * 500);
  setTimeout(() => setStatus(call, 'in-progress'), answerAt);
  setTimeout(() => setStatus(call, 'completed'), answerAt + estimateSpeechMs(call.message));
}

async function twilioRequest(method, path, form) {
  const auth = Buffer.from(`${TWILIO.sid}:${TWILIO.token}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.sid}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Twilio HTTP ${res.status}`);
  return data;
}

async function twilioCall(call) {
  const twiml =
    `<Response><Pause length="1"/>` +
    `<Say language="ko-KR" voice="Polly.Seoyeon">${escapeXml(call.message)}</Say>` +
    `<Pause length="1"/><Say language="ko-KR" voice="Polly.Seoyeon">${escapeXml(call.message)}</Say></Response>`;
  const data = await twilioRequest('POST', '/Calls.json', { To: toE164Kr(call.phone), From: TWILIO.from, Twiml: twiml });
  call.providerSid = data.sid;
  setStatus(call, data.status || 'queued');
}

async function refreshTwilio(call) {
  if (!call.providerSid || ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(call.status)) return;
  try {
    const data = await twilioRequest('GET', `/Calls/${call.providerSid}.json`);
    if (data.status !== call.status) setStatus(call, data.status);
  } catch (e) {
    console.warn('twilio refresh failed:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, provider: useTwilio ? 'twilio' : 'mock' });

    if (req.method === 'POST' && path === '/api/drivers/register') {
      const { driverId, pin, deviceId } = await readBody(req);
      if (!driverId || !/^\d{4,6}$/.test(String(pin || '')) || !deviceId) return send(res, 400, { error: '배송원 번호/PIN/단말기 ID 확인' });
      const prev = drivers.get(driverId);
      if (prev && prev.deviceId !== deviceId) console.log(`[driver ${driverId}] 단말기 변경: ${prev.deviceId} → ${deviceId}`);
      const token = id('TKN');
      drivers.set(driverId, { deviceId, token, registeredAt: new Date().toISOString() });
      console.log(`[driver ${driverId}] registered on ${deviceId}`);
      return send(res, 200, { token, driverId, deviceId });
    }

    if (req.method === 'POST' && path === '/api/voice-notify') {
      const receivedAt = Date.now();
      const body = await readBody(req);
      const driver = drivers.get(body.driverId);
      if (!driver || driver.token !== body.token) return send(res, 401, { error: '등록되지 않은 단말기입니다. 다시 로그인하세요.' });
      if (driver.deviceId !== body.deviceId) return send(res, 403, { error: '등록된 단말기와 다른 기기입니다.' });
      if (!body.phone || !body.message) return send(res, 400, { error: 'phone, message 필수' });

      const call = {
        callId: id('CALL'),
        provider: useTwilio ? 'twilio' : 'mock',
        createdAt: receivedAt,
        createdIso: new Date(receivedAt).toISOString(),
        driverId: body.driverId,
        deviceId: body.deviceId,
        invoiceNo: body.invoiceNo,
        name: body.name,
        phone: String(body.phone),
        place: body.place,
        message: String(body.message).slice(0, 500),
        status: 'queued',
        history: [{ status: 'queued', at: 0 }],
      };
      calls.set(call.callId, call);
      console.log(`[call ${call.callId}] ${call.provider} → ${call.phone} (${call.invoiceNo})`);

      if (useTwilio) {
        twilioCall(call).catch((e) => {
          setStatus(call, 'failed');
          call.error = e.message;
        });
      } else {
        simulateCall(call);
      }
      return send(res, 200, { callId: call.callId, provider: call.provider });
    }

    const m = path.match(/^\/api\/calls\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const call = calls.get(m[1]);
      if (!call) return send(res, 404, { error: 'call not found' });
      if (call.provider === 'twilio') await refreshTwilio(call);
      const { message, ...rest } = call;
      return send(res, 200, rest);
    }

    if (req.method === 'GET' && path === '/api/logs') {
      return send(res, 200, [...calls.values()].reverse().map(({ message, ...c }) => c));
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`알림 서버 실행 중 (provider: ${useTwilio ? 'Twilio 실발신' : '모의 교환기'})`);
  console.log('앱 "고급 설정"에 입력할 주소:', ips.join(' , ') || `http://localhost:${PORT}`);
});
