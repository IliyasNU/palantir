import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, Button, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { Redirect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type StaffSession } from '../api';
import { useLanguage } from '../language';
import { errorMessage, localeTag } from '../messages';
import { queueFor, type AddResult, type SyncOutcome, type SyncProblem } from '../offline';
import { useSession } from '../session';

// Bonus 15 (demo grade): scan without a connection, sync later. Nobody is admitted on this screen's word alone:
// the queue only becomes entries when the server answers, and a ticket someone else scanned first is shown as a conflict.
export default function OfflineScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title: string }>();
  const eventId = Number(id);
  const { session } = useSession();
  if (!session?.token) return <Redirect href="/" />;
  if (!Number.isSafeInteger(eventId) || eventId < 1) return <Redirect href="/events" />;
  return <OfflineScanner key={`${session.userId}:${eventId}`} eventId={eventId} title={title} session={session} />;
}

function OfflineScanner({ eventId, title, session }: { eventId: number; title?: string; session: StaffSession }) {
  const { copy, locale } = useLanguage();
  const { renew } = useSession();
  const queue = useMemo(() => queueFor(session.userId, eventId, randomUUID), [session.userId, eventId]);
  const [permission, requestPermission] = useCameraPermissions();
  const [size, setSize] = useState(queue.size());
  const [last, setLast] = useState<AddResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const focused = useIsFocused();
  const mounted = useRef(true);
  const token = useRef(session.token);

  useEffect(() => { token.current = session.token; }, [session.token]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);

  function scanned(payload: string) {
    if (syncing) return;
    const added = queue.add(payload);
    if (added === 'invalid') return;
    setLast(added);
    setSize(queue.size());
  }

  async function sync() {
    if (syncing || queue.size() === 0) return;
    setSyncing(true);
    setOutcome(null);
    let result = await queue.sync(scans => api.syncScans(token.current, eventId, scans));
    if (result?.error?.status === 401) {
      // The access token expired while offline: renew it once and send the rest of the queue again.
      const fresh = await renew();
      if (typeof fresh === 'object') {
        token.current = fresh.token;
        const again = await queue.sync(scans => api.syncScans(token.current, eventId, scans));
        if (again) {
          result = { accepted: result.accepted + again.accepted, conflicts: [...result.conflicts, ...again.conflicts],
            rejected: [...result.rejected, ...again.rejected], ...(again.error ? { error: again.error } : {}) };
        }
      }
    }
    if (!mounted.current) return;
    setOutcome(result);
    setSize(queue.size());
    setLast(null);
    setSyncing(false);
  }

  const time = (value: string) => new Date(value).toLocaleTimeString(localeTag(locale));
  const reason = (problem: SyncProblem) => (Object.hasOwn(copy.errors, problem.code)
    ? copy.errors[problem.code as keyof typeof copy.errors] : copy.errors.REQUEST_ERROR);
  const canScan = permission?.granted && focused && active && !syncing;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>{title || copy.selectedEvent}</Text>
        <Text style={styles.hint}>{copy.offlineHint}</Text>
        <Text style={styles.hint}>{copy.offlineMemory}</Text>
        {permission && !permission.granted && (
          <View style={styles.box}>
            <Text>{copy.needCamera}</Text>
            <Button title={permission.canAskAgain ? copy.allowCamera : copy.openSettings}
              onPress={() => { void (permission.canAskAgain ? requestPermission() : Linking.openSettings()); }} />
          </View>
        )}
        {canScan && <QueueCamera onScan={scanned} />}
        <View accessibilityLiveRegion="polite" style={styles.box}>
          <Text style={styles.count}>{copy.offlineQueued(size)}</Text>
          {last === 'queued' && <Text>{copy.offlineAdded}</Text>}
          {last === 'duplicate' && <Text>{copy.offlineDuplicate}</Text>}
          {last === 'full' && <Text style={styles.error}>{copy.offlineFull}</Text>}
          <Button title={syncing ? copy.offlineSyncing : copy.offlineSync} disabled={syncing || size === 0} onPress={() => { void sync(); }} />
        </View>
        {outcome && (
          <View accessibilityLiveRegion="polite" style={[styles.box, outcome.error || outcome.conflicts.length || outcome.rejected.length ? styles.failure : styles.success]}>
            <Text style={styles.count}>{copy.offlineAccepted(outcome.accepted)}</Text>
            {outcome.error && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(outcome.error, locale)}</Text>}
            {outcome.error && <Text>{copy.offlineKept(size)}</Text>}
            {outcome.conflicts.length > 0 && <Text style={styles.section}>{copy.offlineConflicts}</Text>}
            {outcome.conflicts.map(problem => (
              <Text key={`${problem.qr_payload}:${problem.scanned_at}`}>
                {problem.conflict ? copy.offlineConflict(problem.conflict.staff_name, time(problem.conflict.checked_in_at)) : reason(problem)}
                {' '}{copy.offlineScannedAt(time(problem.scanned_at))}
              </Text>
            ))}
            {outcome.rejected.length > 0 && <Text style={styles.section}>{copy.offlineRejectedTitle}</Text>}
            {outcome.rejected.map(problem => (
              <Text key={`${problem.qr_payload}:${problem.scanned_at}`}>{reason(problem)} {copy.offlineScannedAt(time(problem.scanned_at))}</Text>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function QueueCamera({ onScan }: { onScan: (payload: string) => void }) {
  const attached = useRef(false);
  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);
  return <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
    onBarcodeScanned={({ data }) => { if (attached.current) onScan(data); }} />;
}

const styles = StyleSheet.create({
  page: { padding: 20, paddingBottom: 48, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#163d79' },
  hint: { color: '#475569' },
  camera: { height: 300, borderRadius: 12, overflow: 'hidden' },
  box: { padding: 20, borderRadius: 10, backgroundColor: '#e2e8f0', gap: 12 },
  success: { backgroundColor: '#d1fae5', borderWidth: 2, borderColor: '#047857' },
  failure: { backgroundColor: '#fee2e2', borderWidth: 2, borderColor: '#b91c1c' },
  count: { fontWeight: '700', fontSize: 18 },
  section: { fontWeight: '700', marginTop: 4 },
  error: { color: '#9f1c25' },
});
