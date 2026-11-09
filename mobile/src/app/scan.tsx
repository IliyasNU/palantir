import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Button, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { Redirect, Stack, router, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type StaffSession } from '../api';
import { AttendanceCount, AttendeeSearch } from '../attendance';
import { createScanSession, type ScanResult } from '../scanner';
import { useSession } from '../session';
import { useLanguage } from '../language';
import { errorMessage } from '../messages';

export default function ScanScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title: string }>();
  const eventId = Number(id);
  const { session } = useSession();
  if (!session?.token) return <Redirect href="/" />;
  if (!Number.isSafeInteger(eventId) || eventId < 1) return <Redirect href="/events" />;
  return <EventScanner key={`${session.userId}:${eventId}`} eventId={eventId} title={title} session={session} />;
}

function EventScanner({ eventId, title, session }: { eventId: number; title?: string; session: StaffSession }) {
  const { setSession } = useSession();
  const { copy, locale } = useLanguage();
  const { token } = session;
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [checkingCamera, setCheckingCamera] = useState(false);
  const cameraLock = useRef(false);
  const [inputMode, setInputMode] = useState({ lookupOpen: false });
  const currentMode = useRef(inputMode);
  const { lookupOpen } = inputMode;
  const [attendanceRevision, setAttendanceRevision] = useState(0);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const focused = useIsFocused();
  const navigation = useNavigation();
  const mounted = useRef(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<unknown>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const loginLock = useRef(false);
  const scanSession = useMemo(() => createScanSession(
    (currentToken, body) => api.checkIn(currentToken, eventId, body), randomUUID,
  ), [eventId]);
  const scanner = scanSession.scanner;

  useEffect(() => { scanSession.setToken(token); }, [scanSession, token]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      setActive(state === 'active');
      if (state === 'active') {
        void getPermission().catch(() => { if (mounted.current) setCameraError(true); });
      }
    });
    return () => { mounted.current = false; subscription.remove(); };
  }, [getPermission]);

  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!scanner.mustResolve() && !loginLock.current) return false;
      Alert.alert(copy.rejected, copy.resolveFirst);
      return true;
    });
    return () => subscription.remove();
  }, [focused, scanner, copy]);

  async function cameraPermission(retry = false) {
    if (cameraLock.current) return;
    cameraLock.current = true;
    setCheckingCamera(true);
    try {
      if (retry) await getPermission();
      else if (permission?.canAskAgain) await requestPermission();
      else await Linking.openSettings();
      if (mounted.current) setCameraError(false);
    } catch {
      if (mounted.current) setCameraError(true);
    } finally {
      cameraLock.current = false;
      if (mounted.current) setCheckingCamera(false);
    }
  }

  function show(promise: Promise<ScanResult> | null) {
    if (!promise) return;
    setBusy(true);
    setResult(null);
    void promise.then(value => {
      if (!mounted.current) return;
      setResult(value);
      setBusy(false);
      if (value.receipt) refreshAttendance();
    });
  }

  function refreshAttendance() {
    setAttendanceRevision(revision => revision + 1);
  }

  function changeLookup(open: boolean) {
    if (scanner.requestId() || loginLock.current || currentMode.current.lookupOpen === open) return;
    // Invalidate queued callbacks immediately, even if the same mode is reopened.
    const nextMode = { lookupOpen: open };
    currentMode.current = nextMode;
    setInputMode(nextMode);
  }

  function submitTicket(payload: string) {
    if (inputMode !== currentMode.current || !mounted.current || !navigation.isFocused()
      || AppState.currentState !== 'active' || loginLock.current) return;
    show(scanner.scan(payload));
  }

  function signInAgain() {
    if (scanner.mustResolve() || loginLock.current) return;
    scanSession.setToken('');
    setSession(null);
  }

  async function reauthenticate() {
    if (loginLock.current || !loginEmail.trim() || !loginPassword) return;
    loginLock.current = true;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const freshSession = await api.login(loginEmail, loginPassword, session.userId);
      if (!mounted.current) return;
      scanSession.setToken(freshSession.token);
      setSession(freshSession);
      show(scanner.retry());
    } catch (problem) {
      if (mounted.current) setLoginError(problem);
    } finally {
      loginLock.current = false;
      if (mounted.current) { setLoginPassword(''); setLoggingIn(false); }
    }
  }

  const canScan = !lookupOpen && permission?.granted && focused && active && !busy && !loggingIn && !result && !cameraError && !checkingCamera;
  const mustStay = busy || scanner.mustResolve() || loggingIn;
  const error = result?.error;
  const pending = scanner.mustResolve();
  const retryable = pending && (error?.code === 'NETWORK_ERROR' || error?.code === 'SERVER_ERROR');
  const eventUnavailable = ['EVENT_NOT_FOUND', 'EVENT_CANCELLED', 'EVENT_NOT_PUBLISHED'].some(code => code === error?.code);
  const backToEvents = !pending && (eventUnavailable || error?.status === 403);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ headerBackVisible: !mustStay, gestureEnabled: !mustStay }} />
      <Text style={styles.title}>{title || copy.selectedEvent}</Text>
      {focused && active && <AttendanceCount key={attendanceRevision} token={token} eventId={eventId}
        locked={mustStay || error?.status === 401} onReload={refreshAttendance} onSignInAgain={signInAgain} />}
      {lookupOpen ? (
        <AttendeeSearch token={token} eventId={eventId} locked={!focused || !active || mustStay || result !== null}
          onClose={() => changeLookup(false)} onSignInAgain={signInAgain}
          onMark={submitTicket} />
      ) : (
        !result && !mustStay && <Button title={copy.findManually} onPress={() => changeLookup(true)} />
      )}
      {!lookupOpen && <Text style={styles.hint}>{copy.scanHint}</Text>}
      {!lookupOpen && (!permission || checkingCamera) && <Text>{copy.checkingPermission}</Text>}
      {!lookupOpen && permission && !permission.granted && (
        <View style={styles.box}>
          <Text>{copy.needCamera}</Text>
          <Button title={permission.canAskAgain ? copy.allowCamera : copy.openSettings} disabled={checkingCamera}
            onPress={() => { void cameraPermission(); }} />
        </View>
      )}
      {canScan && (
        <ScanCamera onScan={submitTicket} onError={() => setCameraError(true)} />
      )}
      {!lookupOpen && cameraError && <View style={styles.box}>
        <Text accessibilityRole="alert" style={styles.error}>{copy.cameraError}</Text>
        <Button title={copy.retryCamera} disabled={checkingCamera} onPress={() => { void cameraPermission(true); }} />
      </View>}
      {busy && <View style={styles.box}><Text>{copy.checking}</Text><Text>{copy.wait}</Text></View>}
      {result && (
        <View accessibilityLiveRegion="polite" style={[styles.box, result.receipt ? styles.success : styles.failure]}>
          <Text style={styles.resultTitle}>{result.receipt ? copy.admitted : copy.rejected}</Text>
          <Text>{result.receipt ? copy.confirmed : errorMessage(result.error, locale)}</Text>
          {error && pending && <Text>{copy.unconfirmed}</Text>}
          {pending && <Text selectable>{copy.requestId}: {scanner.requestId()}</Text>}
          {error && pending && !retryable && error.status !== 401 && error.status !== 403 &&
            <Text>{copy.askOrganizer}</Text>}
          {result.receipt && <Text>{copy.ticket} #{result.receipt.ticket_id} · {new Date(result.receipt.checked_in_at).toLocaleTimeString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')}</Text>}
          {retryable && <Button title={copy.retry} onPress={() => show(scanner.retry())} />}
          {result.error?.status === 401 && <View style={styles.box}>
            <Text>{copy.reauthenticate}</Text>
            <TextInput accessibilityLabel={copy.email} placeholder={copy.email} style={styles.input} value={loginEmail} onChangeText={setLoginEmail}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" editable={!loggingIn} />
            <TextInput accessibilityLabel={copy.password} placeholder={copy.password} style={styles.input} value={loginPassword} onChangeText={setLoginPassword}
              secureTextEntry autoCapitalize="none" autoComplete="current-password" editable={!loggingIn}
              returnKeyType="go" onSubmitEditing={() => { void reauthenticate(); }} />
            {loginError !== null && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(loginError, locale, true)}</Text>}
            <Button title={loggingIn ? copy.signingIn : copy.signInRetry} disabled={loggingIn || !loginEmail.trim() || !loginPassword}
              onPress={() => { void reauthenticate(); }} />
          </View>}
          {result.error?.status === 403 && <View style={styles.box}>
            <Text>{copy.noAccess}</Text>
            {pending && <Button title={copy.retryAccess} onPress={() => show(scanner.retry())} />}
          </View>}
          {backToEvents && <Button title={copy.backToEvents} onPress={() => router.dismissTo('/events')} />}
          {!pending && !backToEvents && error?.status !== 401 &&
            <Button title={copy.nextTicket} onPress={() => { if (scanner.next()) setResult(null); }} />}
        </View>
      )}
    </ScrollView>
    </SafeAreaView>
  );
}

function ScanCamera({ onScan, onError }: { onScan: (payload: string) => void; onError: () => void }) {
  const attached = useRef(false);
  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  return <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
    onBarcodeScanned={({ data }) => { if (attached.current) onScan(data); }}
    onMountError={() => { if (attached.current) onError(); }} />;
}

const styles = StyleSheet.create({
  page: { padding: 20, paddingBottom: 48, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#163d79' },
  hint: { color: '#475569' },
  camera: { height: 340, borderRadius: 12, overflow: 'hidden' },
  box: { padding: 20, borderRadius: 10, backgroundColor: '#e2e8f0', gap: 16 },
  success: { backgroundColor: '#d1fae5', borderWidth: 2, borderColor: '#047857' },
  failure: { backgroundColor: '#fee2e2', borderWidth: 2, borderColor: '#b91c1c' },
  resultTitle: { fontWeight: '700', fontSize: 20 },
  error: { color: '#9f1c25' },
  input: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, backgroundColor: 'white', padding: 12, fontSize: 16 },
});
