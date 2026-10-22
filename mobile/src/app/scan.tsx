import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Button, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { Redirect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { api } from '../api';
import { createScanner, type ScanResult } from '../scanner';
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
  const scanner = useMemo(() => createScanner(body => api.checkIn(token || '', eventId, body), randomUUID), [token, eventId]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);

  function show(promise: Promise<ScanResult> | null) {
    if (!promise) return;
    setBusy(true);
    setResult(null);
    void promise.then(value => {
      if (mounted.current) { setResult(value); setBusy(false); }
    });
  }

  if (!token) return <Redirect href="/" />;
  if (!Number.isInteger(eventId) || eventId < 1) return <Redirect href="/events" />;
  const canScan = permission?.granted && focused && active && !busy && !result && !cameraError;
  const retryable = result?.error && ['NETWORK_ERROR', 'SERVER_ERROR'].includes(result.error.code);

  return (
    <ScrollView contentContainerStyle={styles.page}>
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
          {result.receipt && <Text>Ticket #{result.receipt.ticket_id} · {new Date(result.receipt.checked_in_at).toLocaleTimeString()}</Text>}
          {retryable && <Button title="Retry this check-in" onPress={() => show(scanner.retry())} />}
          {result.error?.code === 'UNAUTHORIZED'
            ? <Button title="Sign in again" onPress={() => setToken(null)} />
            : <Button title="Scan next ticket" onPress={() => { scanner.next(); setResult(null); }} />}
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
