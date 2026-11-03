import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Button, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { Redirect, Stack, router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { api, ApiError } from '../api';
import { createScanSession, type ScanResult } from '../scanner';
import { useSession } from '../session';

export default function ScanScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title: string }>();
  const eventId = Number(id);
  const { token, setToken } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [active, setActive] = useState(AppState.currentState === 'active');
  const focused = useIsFocused();
  const mounted = useRef(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const loginLock = useRef(false);
  const scanSession = useMemo(() => createScanSession(
    (currentToken, body) => api.checkIn(currentToken, eventId, body), randomUUID,
  ), [eventId]);
  const scanner = scanSession.scanner;

  useEffect(() => { scanSession.setToken(token || ''); }, [scanSession, token]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!scanner.mustResolve() && !loginLock.current) return false;
      Alert.alert('Check-in is unconfirmed', 'Resolve this request before leaving. Do not admit the attendee yet.');
      return true;
    });
    return () => subscription.remove();
  }, [focused, scanner]);

  function show(promise: Promise<ScanResult> | null) {
    if (!promise) return;
    setBusy(true);
    setResult(null);
    void promise.then(value => {
      if (mounted.current) { setResult(value); setBusy(false); }
    });
  }

  async function reauthenticate() {
    if (loginLock.current || !loginEmail.trim() || !loginPassword) return;
    loginLock.current = true;
    setLoggingIn(true);
    setLoginError('');
    try {
      const freshToken = await api.login(loginEmail, loginPassword);
      if (!mounted.current) return;
      scanSession.setToken(freshToken);
      setToken(freshToken);
      setLoginPassword('');
      show(scanner.retry());
    } catch (problem) {
      if (mounted.current) setLoginError(problem instanceof ApiError && problem.status === 401
        ? 'Incorrect email or password.' : 'Could not sign in. Try again.');
    } finally {
      loginLock.current = false;
      if (mounted.current) setLoggingIn(false);
    }
  }

  if (!token) return <Redirect href="/" />;
  if (!Number.isInteger(eventId) || eventId < 1) return <Redirect href="/events" />;
  const canScan = permission?.granted && focused && active && !busy && !loggingIn && !result && !cameraError;
  const mustStay = busy || scanner.mustResolve() || loggingIn;
  const retryable = result?.error && scanner.mustResolve() && result.error.status !== 401 && result.error.status !== 403;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ headerBackVisible: !mustStay, gestureEnabled: !mustStay }} />
      <Text style={styles.title}>{title || 'Selected event'}</Text>
      <Text style={styles.hint}>Point the camera at the attendee’s ticket QR.</Text>
      {!permission && <Text>Checking camera permission…</Text>}
      {permission && !permission.granted && (
        <View style={styles.box}>
          <Text>Camera access is needed to scan tickets.</Text>
          <Button title={permission.canAskAgain ? 'Allow camera' : 'Open settings'}
            onPress={() => { void (permission.canAskAgain ? requestPermission() : Linking.openSettings()); }} />
        </View>
      )}
      {canScan && (
        <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { if (data) show(scanner.scan(data)); }}
          onMountError={() => setCameraError('Could not open the camera. Check its permission or reopen this screen.')} />
      )}
      {!!cameraError && <Text style={styles.error}>{cameraError}</Text>}
      {busy && <View style={styles.box}><Text>Checking with the server…</Text><Text>Please wait. Do not admit yet.</Text></View>}
      {result && (
        <View accessibilityLiveRegion="polite" style={[styles.box, result.receipt ? styles.success : styles.failure]}>
          <Text style={styles.resultTitle}>{result.receipt ? 'CHECKED_IN' : result.error.code}</Text>
          <Text>{result.receipt ? 'Check-in confirmed. The attendee can enter.' : result.error.message}</Text>
          {retryable && <Text>Check-in is unconfirmed. Retry before admitting the attendee.</Text>}
          {result.error && scanner.mustResolve() && !retryable && <Text>The earlier check-in is still unconfirmed. Do not admit the attendee.</Text>}
          {result.receipt && <Text>Ticket #{result.receipt.ticket_id} · {new Date(result.receipt.checked_in_at).toLocaleTimeString()}</Text>}
          {retryable && <Button title="Retry this check-in" onPress={() => show(scanner.retry())} />}
          {result.error?.status === 401 && <View style={styles.box}>
            <Text>Sign in again with the same staff account to retry this request.</Text>
            <TextInput accessibilityLabel="Staff email" value={loginEmail} onChangeText={setLoginEmail}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" editable={!loggingIn} />
            <TextInput accessibilityLabel="Staff password" value={loginPassword} onChangeText={setLoginPassword}
              secureTextEntry autoCapitalize="none" editable={!loggingIn} />
            {!!loginError && <Text accessibilityRole="alert">{loginError}</Text>}
            <Button title={loggingIn ? 'Signing in…' : 'Sign in and retry'} disabled={loggingIn || !loginEmail.trim() || !loginPassword}
              onPress={() => { void reauthenticate(); }} />
          </View>}
          {result.error?.status === 403 && <View style={styles.box}>
            <Text>Ask the organizer to check your access and this ticket. Your session is kept.</Text>
            {scanner.mustResolve() ? <Button title="Retry after access is restored" onPress={() => show(scanner.retry())} />
              : <Button title="Back to events" onPress={() => router.replace('/events')} />}
          </View>}
          {!scanner.mustResolve() && result.error?.status !== 401 && result.error?.status !== 403 &&
            <Button title="Scan next ticket" onPress={() => { if (scanner.next()) setResult(null); }} />}
        </View>
      )}
    </ScrollView>
  );
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
});
