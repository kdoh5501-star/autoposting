/**
 * 택배 도착 즉시 음성 알림 — MVP 시연 앱
 * (특허 제10-2004487호 "택배 물품 배송 알림 방법" 워크플로우 데모)
 *
 *  화면 1  로그인 / 단말기 식별      (배송원 번호 + PIN + 기기 고유 ID 바인딩)
 *  화면 2  송장 바코드/QR 스캔        (expo-camera CameraView)
 *  화면 3  수령인 확인 & 원클릭 발송  ("배송 완료 & 음성 발송")
 *  화면 4  음성 전달 상태 & 발송 로그 (단계별 지연시간 타임라인)
 *
 * 음성 전달 경로
 *  - 서버 URL 미입력: 단말기 내 시뮬레이션(통신사 교환망 단계 모사 + 단말 TTS로 고객 수신 음성 재생)
 *  - 서버 URL 입력  : server/index.js 로 발송 요청 → 서버가 모의 교환기 또는 Twilio 실발신 처리, 앱은 상태 폴링
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────
// 상수 / 데모 데이터
// ─────────────────────────────────────────────────────────────
const C = {
  bg: '#0B1220',
  card: '#131C2E',
  cardAlt: '#1A2540',
  border: '#26324D',
  text: '#F3F6FB',
  sub: '#9AA7BF',
  dim: '#5C6A85',
  primary: '#2F6BFF',
  success: '#22C55E',
  warn: '#F59E0B',
  danger: '#EF4444',
  accent: '#38BDF8',
};

const KEY_SESSION = '@dv/session';
const KEY_LOGS = '@dv/logs';
const KEY_DEVICE = '@dv/deviceId';

const CARRIER = '데모택배';

// 숫자형 운송장 바코드(Code128 등)만 찍혔을 때 조회하는 모의 운송장 DB
const MOCK_INVOICES = {
  '600123456789': {
    name: '김민수',
    phone: '01012345678',
    address: '서울시 강남구 테헤란로 123, 101동 1203호',
    item: '생활용품 1박스',
  },
  '600987654321': {
    name: '이서연',
    phone: '01098765432',
    address: '경기도 성남시 분당구 판교역로 235, 7층',
    item: '전자제품 (취급주의)',
  },
  '600555500000': {
    name: '박미응답',
    phone: '01055550000',
    address: '부산시 해운대구 센텀중앙로 55, 302호',
    item: '의류 1개',
  },
};

// 카메라 없이(에뮬레이터/웹) 시연할 때 쓰는 샘플 송장 페이로드
const SAMPLE_PAYLOADS = [
  '{"inv":"600111222333","name":"홍길동","phone":"010-2345-6789","addr":"서울시 마포구 월드컵북로 400, 5층","item":"도서 2권"}',
  '600123456789',
  '600987654321|이서연|010-9876-5432|경기도 성남시 분당구 판교역로 235, 7층|전자제품',
  '600555500000',
];

const PLACES = [
  { key: 'door', label: '문 앞' },
  { key: 'guard', label: '경비실' },
  { key: 'locker', label: '무인택배함' },
  { key: 'hand', label: '직접 전달' },
];

const STEPS = [
  { key: 'request', label: '배송완료 탭 · 발송 이벤트 생성 (단말기)' },
  { key: 'accepted', label: '알림 서버 접수' },
  { key: 'dialing', label: '통신사 음성망 발신' },
  { key: 'ringing', label: '수령인 단말 착신 (벨 울림)' },
  { key: 'answered', label: '수령인 응답 · 음성 안내 재생' },
  { key: 'completed', label: '음성 안내 전달 완료' },
];
const STEP_LABELS = Object.fromEntries(STEPS.map((s) => [s.key, s.label]));

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────
const store = {
  async get(key, fallback = null) {
    try {
      const v = await AsyncStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  async remove(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.round(min + Math.random() * (max - min));
const makeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
const haptic = (fn) => fn().catch(() => {});

const onlyDigits = (s) => String(s || '').replace(/[^0-9]/g, '');
const isValidPhone = (d) => /^01[016789]\d{7,8}$/.test(d) || /^0[2-6]\d{7,9}$/.test(d);

function formatPhone(d) {
  if (!d) return '';
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

function maskPhone(d) {
  const f = formatPhone(d);
  const parts = f.split('-');
  if (parts.length !== 3) return f;
  return `${parts[0]}-${'*'.repeat(parts[1].length)}-${parts[2]}`;
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtMs = (ms) => (ms == null ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);

async function fetchJson(url, { method = 'GET', body } = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('응답 시간 초과');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDeviceId() {
  try {
    if (Platform.OS === 'android') {
      const id = Application.getAndroidId();
      if (id) return `AND-${id}`;
    } else if (Platform.OS === 'ios') {
      const id = await Application.getIosIdForVendorAsync();
      if (id) return `IOS-${id}`;
    }
  } catch {}
  let stored = await store.get(KEY_DEVICE);
  if (!stored) {
    stored = `${Platform.OS.toUpperCase()}-${makeId()}`;
    await store.set(KEY_DEVICE, stored);
  }
  return stored;
}

// ─────────────────────────────────────────────────────────────
// 송장 파싱: JSON QR / 파이프(|) 구분 / key=value / 숫자 운송장번호(모의 DB 조회)
// ─────────────────────────────────────────────────────────────
function parseInvoice(raw, symbology = '') {
  const text = String(raw || '').trim();
  if (!text) return null;

  const build = (f, source) => {
    const phone = onlyDigits(f.phone);
    return {
      raw: text,
      symbology,
      source,
      invoiceNo: String(f.invoiceNo || '').trim() || '미확인',
      name: String(f.name || '').trim() || '고객',
      phone,
      phoneValid: isValidPhone(phone),
      address: String(f.address || '').trim(),
      item: String(f.item || '').trim(),
      carrier: String(f.carrier || '').trim() || CARRIER,
    };
  };

  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      return build(
        {
          invoiceNo: o.inv ?? o.invoiceNo ?? o.waybill,
          name: o.name ?? o.rcv,
          phone: o.phone ?? o.tel,
          address: o.addr ?? o.address,
          item: o.item,
          carrier: o.carrier,
        },
        'QR(JSON)'
      );
    } catch {}
  }

  if (text.includes('|')) {
    const [invoiceNo, name, phone, address, item] = text.split('|').map((s) => s.trim());
    return build({ invoiceNo, name, phone, address, item }, '구분자(|) 라벨');
  }

  if (/^[^=]+=[^=]*([&;][^=]+=[^=]*)*$/.test(text)) {
    const kv = Object.fromEntries(
      text.split(/[&;]/).map((p) => {
        const [k, ...v] = p.split('=');
        return [k.trim().toLowerCase(), decodeURIComponent(v.join('=').trim())];
      })
    );
    return build(
      { invoiceNo: kv.inv || kv.invoice, name: kv.name, phone: kv.phone || kv.tel, address: kv.addr, item: kv.item },
      'key=value 라벨'
    );
  }

  const digits = onlyDigits(text);
  if (digits.length >= 8) {
    const hit = MOCK_INVOICES[digits];
    return build({ invoiceNo: digits, ...(hit || {}) }, hit ? '운송장번호 → 모의 DB 조회' : '운송장번호 (수령인 정보 없음)');
  }
  return build({ invoiceNo: text }, '미지원 형식');
}

function buildMessage(parcel, placeKey) {
  const last4 = parcel.invoiceNo.slice(-4);
  const where =
    placeKey === 'hand'
      ? '고객님께 직접 전달되었습니다'
      : `방금 ${PLACES.find((p) => p.key === placeKey)?.label ?? '문 앞'}에 도착했습니다`;
  return (
    `안녕하세요, ${parcel.name} 고객님. ${parcel.carrier}입니다. ` +
    `주문하신 택배가 ${where}. 운송장 번호 끝자리는 ${last4}입니다. ` +
    `분실 방지를 위해 빠른 수령 부탁드립니다. 감사합니다.`
  );
}

// ─────────────────────────────────────────────────────────────
// 음성 전달 엔진
// ─────────────────────────────────────────────────────────────
const estimateSpeechMs = (text) => Math.max(2500, text.length * 110);

function speakAsync(text, audible) {
  const estimate = estimateSpeechMs(text);
  if (!audible) return wait(estimate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve();
    };
    // onDone 이 오지 않는 플랫폼(일부 웹 브라우저) 대비 안전장치
    const guard = setTimeout(finish, estimate * 2 + 3000);
    Speech.speak(text, { language: 'ko-KR', rate: 0.95, pitch: 1.0, onDone: finish, onStopped: finish, onError: finish });
  });
}

async function viaSimulation({ payload, monitor, mark }) {
  await wait(jitter(60, 140));
  mark('accepted', { note: '단말기 내장 모의 서버' });
  await wait(jitter(120, 260));
  mark('dialing', { note: `발신 → ${maskPhone(payload.phone)}` });
  await wait(jitter(350, 650));
  mark('ringing');

  // 데모용 미응답 시나리오: 전화번호 끝자리 0000
  if (payload.phone.endsWith('0000')) {
    await wait(3000);
    mark('failed', { label: '수령인 미응답 (30초 무응답 처리, 데모 단축)' });
    await wait(jitter(150, 300));
    mark('fallback', { label: 'MMS 음성파일 대체 발송 (시뮬레이션)' });
    return { status: 'no_answer', transport: '로컬 시뮬레이션' };
  }

  await wait(jitter(800, 1400));
  mark('answered', { note: monitor ? '단말 스피커로 고객 수신 음성 재생 중' : '음성 재생 중 (무음 모니터링)' });
  await speakAsync(payload.message, monitor);
  mark('completed');
  return { status: 'completed', transport: '로컬 시뮬레이션', callId: `SIM-${makeId()}` };
}

const SERVER_STATUS_TO_STEP = {
  queued: 'dialing',
  initiated: 'dialing',
  dialing: 'dialing',
  ringing: 'ringing',
  'in-progress': 'answered',
  answered: 'answered',
  completed: 'completed',
};
const SERVER_FAIL = ['busy', 'failed', 'no-answer', 'canceled'];

async function viaServer({ base, payload, monitor, mark }) {
  const created = await fetchJson(`${base}/api/voice-notify`, { method: 'POST', body: payload }, 5000);
  const provider = created.provider === 'twilio' ? 'Twilio 실발신' : '서버 모의 교환기';
  mark('accepted', { note: `${provider} · ${created.callId}` });

  const seen = new Set();
  let speaking = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await wait(300);
    const call = await fetchJson(`${base}/api/calls/${created.callId}`, {}, 4000).catch(() => null);
    if (!call) continue;
    if (SERVER_FAIL.includes(call.status)) {
      mark('failed', { label: `통화 실패: ${call.status}` });
      if (call.fallback) mark('fallback', { label: call.fallback });
      return { status: call.status === 'no-answer' ? 'no_answer' : 'failed', transport: provider, callId: created.callId };
    }
    const key = SERVER_STATUS_TO_STEP[call.status];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key === 'answered') {
      mark('answered', { note: monitor ? '단말 스피커로 모니터링 재생' : undefined });
      if (monitor) speaking = speakAsync(payload.message, true);
    } else if (key === 'completed') {
      if (speaking) await speaking;
      mark('completed');
      return { status: 'completed', transport: provider, callId: created.callId };
    } else {
      mark(key);
    }
  }
  throw new Error('통화 상태 조회 시간 초과');
}

async function deliverVoiceNotice({ payload, serverUrl, monitor, onStep }) {
  const t0 = Date.now();
  const mark = (key, extra = {}) => onStep({ key, at: Date.now() - t0, ...extra });
  mark('request');

  const base = serverUrl.trim().replace(/\/+$/, '');
  if (base) {
    try {
      return await viaServer({ base, payload, monitor, mark });
    } catch (e) {
      mark('fallback', { label: `서버 연동 실패 → 로컬 시뮬레이션 전환`, note: e.message });
      const r = await viaSimulation({ payload, monitor, mark });
      return { ...r, transport: '로컬 시뮬레이션 (서버 실패 대체)' };
    }
  }
  return viaSimulation({ payload, monitor, mark });
}

// ─────────────────────────────────────────────────────────────
// 공통 UI
// ─────────────────────────────────────────────────────────────
function Button({ title, onPress, kind = 'primary', disabled, big, style, icon }) {
  const bg = { primary: C.primary, success: C.success, ghost: 'transparent', danger: C.danger, dark: C.cardAlt }[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: C.border },
        big && styles.btnBig,
        style,
      ]}
    >
      <Text style={[styles.btnText, big && styles.btnTextBig]}>
        {icon ? `${icon}  ` : ''}
        {title}
      </Text>
    </Pressable>
  );
}

function Header({ title, subtitle, right }) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

function Row({ label, value, mono, highlight }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono, highlight && { color: C.accent }]}>{value || '-'}</Text>
    </View>
  );
}

const Chip = ({ label, active, onPress }) => (
  <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
    <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
  </Pressable>
);

// ─────────────────────────────────────────────────────────────
// 화면 1: 로그인 / 단말기 식별
// ─────────────────────────────────────────────────────────────
function LoginScreen({ deviceId, initial, onLogin }) {
  const [driverId, setDriverId] = useState(initial?.driverId ?? 'DRV-0001');
  const [pin, setPin] = useState('');
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? '');
  const [showAdv, setShowAdv] = useState(!!initial?.serverUrl);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const id = driverId.trim().toUpperCase();
    if (id.length < 4) return Alert.alert('배송원 번호 확인', '배송원 고유 번호를 4자 이상 입력하세요.');
    if (!/^\d{4,6}$/.test(pin)) return Alert.alert('PIN 확인', 'PIN은 숫자 4~6자리입니다.');
    setBusy(true);
    let url = serverUrl.trim();
    let token = `LOCAL-${makeId()}`;
    if (url) {
      try {
        const r = await fetchJson(`${url.replace(/\/+$/, '')}/api/drivers/register`, {
          method: 'POST',
          body: { driverId: id, pin, deviceId },
        });
        token = r.token;
      } catch (e) {
        Alert.alert('서버 연결 실패', `${e.message}\n로컬 시뮬레이션 모드로 진행합니다.`);
        url = '';
      }
    }
    setBusy(false);
    haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
    onLogin({ driverId: id, deviceId, serverUrl: url, token, loggedInAt: new Date().toISOString() });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>📦🔊</Text>
        <Text style={styles.loginTitle}>택배 도착 음성 알림</Text>
        <Text style={styles.loginSub}>배송원 단말기 식별 후 시작합니다</Text>

        <View style={styles.card}>
          <Text style={styles.label}>배송원 고유 번호</Text>
          <TextInput
            style={styles.input}
            value={driverId}
            onChangeText={setDriverId}
            autoCapitalize="characters"
            placeholder="예) DRV-0001"
            placeholderTextColor={C.dim}
          />
          <Text style={styles.label}>PIN (숫자 4~6자리)</Text>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={(t) => setPin(onlyDigits(t).slice(0, 6))}
            keyboardType="number-pad"
            secureTextEntry
            placeholder="••••"
            placeholderTextColor={C.dim}
          />
          <Text style={styles.label}>단말기 식별자 (자동)</Text>
          <View style={styles.deviceBox}>
            <Text style={[styles.mono, { color: C.accent }]} numberOfLines={1}>
              {deviceId || '조회 중…'}
            </Text>
          </View>

          <Pressable onPress={() => setShowAdv((v) => !v)} style={{ marginTop: 14 }}>
            <Text style={{ color: C.sub }}>{showAdv ? '▾' : '▸'} 고급 설정 (알림 서버 연동)</Text>
          </Pressable>
          {showAdv && (
            <>
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={serverUrl}
                onChangeText={setServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.0.10:4000 (비우면 로컬 시뮬레이션)"
                placeholderTextColor={C.dim}
              />
              <Text style={styles.hint}>PC에서 server/index.js 실행 후 같은 Wi-Fi의 PC IP를 입력하세요.</Text>
            </>
          )}
        </View>

        <Button title={busy ? '인증 중…' : '단말기 등록 & 시작'} onPress={submit} disabled={busy || !deviceId} big />
        <Text style={[styles.hint, { textAlign: 'center', marginTop: 12 }]}>데모 계정: DRV-0001 / PIN 1234 (아무 4자리 가능)</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────
// 화면 2: 바코드 / QR 스캔
// ─────────────────────────────────────────────────────────────
const FRAME_W = 280;
const FRAME_H = 200;

function ScanScreen({ session, onParsed, onLogs, onLogout }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [manual, setManual] = useState('');
  const [sampleIdx, setSampleIdx] = useState(0);
  const lockRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const accept = useCallback(
    (data, type) => {
      if (lockRef.current) return;
      lockRef.current = true;
      haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
      const parsed = parseInvoice(data, type);
      if (!parsed) {
        lockRef.current = false;
        return;
      }
      onParsed(parsed);
    },
    [onParsed]
  );

  const useSample = () => {
    const raw = SAMPLE_PAYLOADS[sampleIdx % SAMPLE_PAYLOADS.length];
    setSampleIdx((i) => i + 1);
    accept(raw, 'sample');
  };

  const header = (
    <Header
      title="송장 스캔"
      subtitle={`배송원 ${session.driverId} · ${session.serverUrl ? '서버 연동' : '로컬 시뮬레이션'}`}
      right={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="로그" kind="dark" onPress={onLogs} style={styles.btnSmall} />
          <Button title="로그아웃" kind="ghost" onPress={onLogout} style={styles.btnSmall} />
        </View>
      }
    />
  );

  const fallbackPanel = (
    <View style={styles.scanPanel}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          style={[styles.input, { flex: 1, marginTop: 0 }]}
          value={manual}
          onChangeText={setManual}
          placeholder="운송장번호 직접 입력"
          placeholderTextColor={C.dim}
          autoCapitalize="none"
        />
        <Button title="조회" kind="dark" disabled={!manual.trim()} onPress={() => accept(manual, 'manual')} />
      </View>
      <Button title={`샘플 송장 사용 (${(sampleIdx % SAMPLE_PAYLOADS.length) + 1}/${SAMPLE_PAYLOADS.length})`} kind="ghost" onPress={useSample} style={{ marginTop: 10 }} />
    </View>
  );

  if (!permission) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={[styles.center, { padding: 24 }]}>
          <Text style={styles.bigEmoji}>📷</Text>
          <Text style={styles.centerText}>송장 바코드 스캔을 위해 카메라 권한이 필요합니다.</Text>
          <Button title="카메라 권한 허용" onPress={requestPermission} style={{ marginTop: 16, alignSelf: 'stretch' }} />
        </View>
        {fallbackPanel}
      </View>
    );
  }

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, FRAME_H - 3] });

  return (
    <View style={{ flex: 1 }}>
      {header}
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'itf14', 'pdf417', 'datamatrix', 'codabar', 'upc_a'],
          }}
          onBarcodeScanned={({ data, type }) => accept(data, type)}
        />
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.frame}>
            {['tl', 'tr', 'bl', 'br'].map((k) => (
              <View key={k} style={[styles.corner, styles[`corner_${k}`]]} />
            ))}
            <Animated.View style={[styles.scanLine, { transform: [{ translateY }] }]} />
          </View>
          <Text style={styles.overlayText}>송장 바코드 또는 QR을 사각형 안에 맞춰주세요</Text>
        </View>
        <Pressable onPress={() => setTorch((t) => !t)} style={styles.torchBtn}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{torch ? '🔦 끄기' : '🔦 플래시'}</Text>
        </Pressable>
      </View>
      {fallbackPanel}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 화면 3: 수령인 확인 & 원클릭 발송
// ─────────────────────────────────────────────────────────────
function ConfirmScreen({ parcel: initialParcel, onBack, onSend }) {
  const [parcel, setParcel] = useState(initialParcel);
  const [place, setPlace] = useState('door');
  const [monitor, setMonitor] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [phoneInput, setPhoneInput] = useState(formatPhone(initialParcel.phone));
  const [previewing, setPreviewing] = useState(false);
  const message = buildMessage(parcel, place);

  useEffect(() => () => Speech.stop(), []);

  const updatePhone = (t) => {
    setPhoneInput(t);
    const d = onlyDigits(t);
    setParcel((p) => ({ ...p, phone: d, phoneValid: isValidPhone(d) }));
  };

  const preview = async () => {
    if (previewing) {
      await Speech.stop();
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    await speakAsync(message, true);
    setPreviewing(false);
  };

  const send = () => {
    Speech.stop();
    haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
    onSend({ parcel, place, message, monitor });
  };

  return (
    <View style={{ flex: 1 }}>
      <Header title="수령인 확인" subtitle={`인식 방식: ${parcel.source}`} right={<Button title="다시 스캔" kind="ghost" onPress={onBack} style={styles.btnSmall} />} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Row label="운송장번호" value={parcel.invoiceNo} mono highlight />
          <Row label="택배사" value={parcel.carrier} />
          <Row label="수령인" value={parcel.name} />
          {parcel.phoneValid && !parcel.edited ? (
            <Pressable onPress={() => setReveal((r) => !r)}>
              <Row label="연락처" value={`${reveal ? formatPhone(parcel.phone) : maskPhone(parcel.phone)}  ${reveal ? '🙈' : '👁'}`} mono />
            </Pressable>
          ) : (
            <View style={{ marginTop: 6 }}>
              <Text style={[styles.label, { color: C.warn }]}>연락처를 확인/입력하세요</Text>
              <TextInput
                style={[styles.input, !parcel.phoneValid && { borderColor: C.warn }]}
                value={phoneInput}
                onChangeText={updatePhone}
                onFocus={() => setParcel((p) => ({ ...p, edited: true }))}
                keyboardType="phone-pad"
                placeholder="010-0000-0000"
                placeholderTextColor={C.dim}
              />
            </View>
          )}
          <Row label="주소" value={parcel.address} />
          <Row label="품목" value={parcel.item} />
        </View>

        <Text style={styles.sectionTitle}>배송 위치</Text>
        <View style={styles.chips}>
          {PLACES.map((p) => (
            <Chip key={p.key} label={p.label} active={place === p.key} onPress={() => setPlace(p.key)} />
          ))}
        </View>

        <Text style={styles.sectionTitle}>발송될 음성 안내</Text>
        <View style={[styles.card, { backgroundColor: C.cardAlt }]}>
          <Text style={styles.message}>“{message}”</Text>
          <View style={styles.monitorRow}>
            <Button title={previewing ? '⏹ 정지' : '▶ 미리듣기'} kind="dark" onPress={preview} style={styles.btnSmall} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: C.sub, fontSize: 12 }}>단말 스피커 모니터링</Text>
              <Switch value={monitor} onValueChange={setMonitor} />
            </View>
          </View>
        </View>
      </ScrollView>

      <View style={styles.bottomBar}>
        <Button title="배송 완료 & 음성 발송" icon="🔊" kind="success" big disabled={!parcel.phoneValid} onPress={send} />
        {!parcel.phoneValid && <Text style={[styles.hint, { textAlign: 'center', color: C.warn }]}>유효한 전화번호가 필요합니다</Text>}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 화면 4: 음성 전달 상태 & 발송 로그
// ─────────────────────────────────────────────────────────────
function Timeline({ run }) {
  const running = run.state === 'running';
  const reached = new Set(run.events.map((e) => e.key));
  const terminal = reached.has('failed') || reached.has('completed');
  const pending = running && !terminal ? STEPS.filter((s) => !reached.has(s.key)) : [];
  const color = (k) => (k === 'failed' ? C.danger : k === 'fallback' ? C.warn : C.success);

  return (
    <View style={styles.card}>
      {run.events.map((e, i) => (
        <View key={`${e.key}-${i}`} style={styles.tlRow}>
          <View style={[styles.tlDot, { backgroundColor: color(e.key) }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tlLabel}>{e.label}</Text>
            {e.note ? <Text style={styles.tlNote}>{e.note}</Text> : null}
          </View>
          <Text style={[styles.mono, { color: C.accent }]}>+{fmtMs(e.at)}</Text>
        </View>
      ))}
      {pending.map((s, i) => (
        <View key={s.key} style={styles.tlRow}>
          {i === 0 ? <ActivityIndicator size="small" color={C.accent} style={{ width: 12, marginRight: 12 }} /> : <View style={[styles.tlDot, { backgroundColor: C.border }]} />}
          <Text style={[styles.tlLabel, { color: C.dim }]}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

const STATUS_VIEW = {
  running: { emoji: '📞', text: '음성 알림 발송 중…', color: C.accent },
  completed: { emoji: '✅', text: '음성 안내 전달 완료', color: C.success },
  no_answer: { emoji: '📵', text: '미응답 · 대체 발송 처리', color: C.warn },
  failed: { emoji: '⚠️', text: '발송 실패', color: C.danger },
};

function StatusScreen({ run, logs, onNext, onClearLogs, onReplay }) {
  const [openId, setOpenId] = useState(null);
  const sv = run ? STATUS_VIEW[run.state === 'running' ? 'running' : run.result?.status ?? 'failed'] : null;
  const answered = run?.events.find((e) => e.key === 'answered');
  const last = run?.events[run.events.length - 1];

  return (
    <View style={{ flex: 1 }}>
      <Header title={run ? '음성 전달 상태' : '발송 로그'} subtitle={run ? `${run.parcel.name} · ${maskPhone(run.parcel.phone)}` : `총 ${logs.length}건`} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        {run && (
          <>
            <View style={[styles.statusHero, { borderColor: sv.color }]}>
              <Text style={styles.bigEmoji}>{sv.emoji}</Text>
              <Text style={[styles.statusText, { color: sv.color }]}>{sv.text}</Text>
              <View style={styles.metrics}>
                <View style={styles.metric}>
                  <Text style={styles.metricVal}>{fmtMs(answered?.at)}</Text>
                  <Text style={styles.metricLabel}>탭 → 고객 음성 수신</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricVal}>{run.state === 'running' ? '…' : fmtMs(last?.at)}</Text>
                  <Text style={styles.metricLabel}>전체 처리 시간</Text>
                </View>
              </View>
              {run.result?.transport ? <Text style={styles.hint}>경로: {run.result.transport}{run.result.callId ? ` · ${run.result.callId}` : ''}</Text> : null}
            </View>
            <Text style={styles.sectionTitle}>처리 타임라인</Text>
            <Timeline run={run} />
          </>
        )}

        <View style={[styles.rowBetween, { marginTop: 18 }]}>
          <Text style={styles.sectionTitle}>발송 로그 ({logs.length})</Text>
          {logs.length > 0 && (
            <Pressable
              onPress={() =>
                Alert.alert('로그 삭제', '모든 발송 로그를 삭제할까요?', [
                  { text: '취소', style: 'cancel' },
                  { text: '삭제', style: 'destructive', onPress: onClearLogs },
                ])
              }
            >
              <Text style={{ color: C.danger }}>전체 삭제</Text>
            </Pressable>
          )}
        </View>
        {logs.length === 0 && <Text style={[styles.hint, { textAlign: 'center', marginTop: 12 }]}>아직 발송 이력이 없습니다.</Text>}
        {logs.map((l) => {
          const v = STATUS_VIEW[l.status] ?? STATUS_VIEW.failed;
          const open = openId === l.id;
          return (
            <Pressable key={l.id} onPress={() => setOpenId(open ? null : l.id)} style={styles.logItem}>
              <View style={styles.rowBetween}>
                <Text style={styles.logTitle}>
                  {v.emoji} {l.name} · {l.phoneMasked}
                </Text>
                <Text style={[styles.badge, { color: v.color, borderColor: v.color }]}>{l.status === 'completed' ? '전달' : l.status === 'no_answer' ? '미응답' : '실패'}</Text>
              </View>
              <Text style={styles.logSub}>
                {fmtTime(l.createdAt)} · 운송장 {l.invoiceNo} · {l.place}
              </Text>
              <Text style={styles.logSub}>
                수신 {fmtMs(l.answeredMs)} · 전체 {fmtMs(l.totalMs)} · {l.transport}
              </Text>
              {open && (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.tlNote}>“{l.message}”</Text>
                  {l.steps.map((s, i) => (
                    <Text key={i} style={styles.tlNote}>
                      +{fmtMs(s.at)}  {s.label}
                    </Text>
                  ))}
                  <Text style={styles.tlNote}>단말 {l.deviceId} · 배송원 {l.driverId}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={[styles.bottomBar, { flexDirection: 'row', gap: 10 }]}>
        {run && run.state !== 'running' && <Button title="다시 듣기" kind="dark" onPress={() => onReplay(run.message)} style={{ flex: 1 }} />}
        <Button title="다음 송장 스캔" icon="📷" onPress={onNext} style={{ flex: 2 }} big />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 앱 루트 (단순 상태 기반 화면 전환)
// ─────────────────────────────────────────────────────────────
function Main() {
  const [screen, setScreen] = useState('boot');
  const [deviceId, setDeviceId] = useState('');
  const [session, setSession] = useState(null);
  const [lastSession, setLastSession] = useState(null);
  const [parcel, setParcel] = useState(null);
  const [run, setRun] = useState(null);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    (async () => {
      const [id, saved, savedLogs] = await Promise.all([resolveDeviceId(), store.get(KEY_SESSION), store.get(KEY_LOGS, [])]);
      setDeviceId(id);
      setLogs(Array.isArray(savedLogs) ? savedLogs : []);
      setLastSession(saved);
      if (saved && saved.deviceId === id) {
        setSession(saved);
        setScreen('scan');
      } else {
        setScreen('login');
      }
    })();
  }, []);

  const login = (s) => {
    setSession(s);
    setLastSession(s);
    store.set(KEY_SESSION, s);
    setScreen('scan');
  };

  const logout = () => {
    store.remove(KEY_SESSION);
    setSession(null);
    setScreen('login');
  };

  const onParsed = useCallback((p) => {
    setParcel(p);
    setScreen('confirm');
  }, []);

  const startDelivery = async ({ parcel: p, place, message, monitor }) => {
    const runId = makeId();
    const createdAt = new Date().toISOString();
    const placeLabel = PLACES.find((x) => x.key === place)?.label ?? place;
    const events = [];
    setRun({ id: runId, parcel: p, message, events: [], state: 'running' });
    setScreen('status');

    const onStep = (ev) => {
      events.push({ ...ev, label: ev.label || STEP_LABELS[ev.key] || ev.key });
      const snapshot = [...events];
      setRun((r) => (r && r.id === runId ? { ...r, events: snapshot } : r));
    };

    const payload = {
      driverId: session.driverId,
      deviceId: session.deviceId,
      token: session.token,
      invoiceNo: p.invoiceNo,
      name: p.name,
      phone: p.phone,
      address: p.address,
      place: placeLabel,
      carrier: p.carrier,
      message,
    };

    let result;
    try {
      result = await deliverVoiceNotice({ payload, serverUrl: session.serverUrl || '', monitor, onStep });
    } catch (e) {
      onStep({ key: 'failed', at: events.length ? events[events.length - 1].at : 0, label: `발송 오류: ${e.message}` });
      result = { status: 'failed', transport: '-' };
    }

    setRun((r) => (r && r.id === runId ? { ...r, events: [...events], state: 'done', result } : r));
    haptic(() =>
      Haptics.notificationAsync(result.status === 'completed' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning)
    );

    const entry = {
      id: runId,
      createdAt,
      invoiceNo: p.invoiceNo,
      name: p.name,
      phoneMasked: maskPhone(p.phone),
      place: placeLabel,
      message,
      status: result.status,
      transport: result.transport,
      callId: result.callId,
      answeredMs: events.find((e) => e.key === 'answered')?.at ?? null,
      totalMs: events.length ? events[events.length - 1].at : null,
      steps: events.map(({ at, label }) => ({ at, label })),
      driverId: session.driverId,
      deviceId: session.deviceId,
    };
    setLogs((prev) => {
      const next = [entry, ...prev].slice(0, 200);
      store.set(KEY_LOGS, next);
      return next;
    });
  };

  const goScan = () => {
    Speech.stop();
    setRun((r) => (r?.state === 'running' ? r : null));
    setParcel(null);
    setScreen('scan');
  };

  if (screen === 'boot') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  }
  if (screen === 'login' || !session) return <LoginScreen deviceId={deviceId} initial={lastSession} onLogin={login} />;
  if (screen === 'confirm' && parcel) return <ConfirmScreen parcel={parcel} onBack={goScan} onSend={startDelivery} />;
  if (screen === 'status')
    return (
      <StatusScreen
        run={run}
        logs={logs}
        onNext={goScan}
        onReplay={(msg) => speakAsync(msg, true)}
        onClearLogs={() => {
          setLogs([]);
          store.set(KEY_LOGS, []);
        }}
      />
    );
  return (
    <ScanScreen
      session={session}
      onParsed={onParsed}
      onLogout={logout}
      onLogs={() => {
        setRun((r) => (r?.state === 'running' ? r : null));
        setScreen('status');
      }}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <Main />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ─────────────────────────────────────────────────────────────
// 스타일
// ─────────────────────────────────────────────────────────────
const CORNER = 26;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  centerText: { color: C.text, textAlign: 'center', fontSize: 15, lineHeight: 22 },
  bigEmoji: { fontSize: 44, marginBottom: 8, textAlign: 'center' },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13 },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle: { color: C.text, fontSize: 20, fontWeight: '800' },
  headerSub: { color: C.sub, fontSize: 12, marginTop: 2 },

  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnBig: { paddingVertical: 18, borderRadius: 14 },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnTextBig: { fontSize: 18, fontWeight: '800' },

  loginWrap: { padding: 20, paddingTop: 40 },
  logo: { fontSize: 52, textAlign: 'center' },
  loginTitle: { color: C.text, fontSize: 26, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  loginSub: { color: C.sub, textAlign: 'center', marginTop: 6, marginBottom: 24 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 16 },
  label: { color: C.sub, fontSize: 13, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: C.bg, color: C.text, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  deviceBox: { backgroundColor: C.bg, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed' },
  hint: { color: C.dim, fontSize: 12, marginTop: 6 },

  cameraWrap: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  frame: { width: FRAME_W, height: FRAME_H, overflow: 'hidden' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: C.accent },
  corner_tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 8 },
  corner_tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 8 },
  corner_bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 8 },
  corner_br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 8 },
  scanLine: { position: 'absolute', left: 10, right: 10, height: 3, backgroundColor: C.danger, borderRadius: 2, opacity: 0.85 },
  overlayText: { color: '#fff', marginTop: 18, fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4 },
  torchBtn: { position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  scanPanel: { padding: 16, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card },

  row: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowLabel: { color: C.sub, width: 84, fontSize: 14 },
  rowValue: { color: C.text, flex: 1, fontSize: 15, fontWeight: '600' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: C.text, fontWeight: '800', fontSize: 15, marginBottom: 10, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  chipActive: { backgroundColor: C.primary, borderColor: C.primary },
  chipText: { color: C.sub, fontWeight: '700' },
  message: { color: C.text, fontSize: 15, lineHeight: 23 },
  monitorRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  bottomBar: { padding: 16, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },

  statusHero: { alignItems: 'center', backgroundColor: C.card, borderRadius: 18, borderWidth: 2, padding: 20, marginBottom: 18 },
  statusText: { fontSize: 22, fontWeight: '800' },
  metrics: { flexDirection: 'row', gap: 12, marginTop: 16, alignSelf: 'stretch' },
  metric: { flex: 1, backgroundColor: C.bg, borderRadius: 12, padding: 12, alignItems: 'center' },
  metricVal: { color: C.accent, fontSize: 22, fontWeight: '800' },
  metricLabel: { color: C.sub, fontSize: 12, marginTop: 4 },
  tlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  tlDot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  tlLabel: { color: C.text, fontSize: 14, fontWeight: '600' },
  tlNote: { color: C.sub, fontSize: 12, marginTop: 2 },

  logItem: { backgroundColor: C.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  logTitle: { color: C.text, fontWeight: '700', fontSize: 14, flex: 1 },
  logSub: { color: C.sub, fontSize: 12, marginTop: 3 },
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
});
