import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { api, ApiError, canSearchAttendees, type Attendance, type Attendee, type UndoReceipt } from './api';
import { useLanguage } from './language';
import { emptyLoad, loadFailed, loadSucceeded, loadView } from './loading';
import { errorMessage, type Locale } from './messages';
import { createUndoStore } from './undo';

type EventAccess = {
  token: string;
  eventId: number;
  onSignInAgain: () => void;
};

type LoadResult<T> = { data: T } | { error: unknown };

const localeTag = (locale: Locale) => (locale === 'kk' ? 'kk-KZ' : 'ru-RU');

// The parent mounts this only while the scanner screen is focused and the app is active, and remounts the
// scanner for another account or event. A response that arrives after any of those changes is dropped.
export function AttendanceCount({ token, eventId, revision, locked, onSignInAgain }: EventAccess & {
  revision: number;
  locked: boolean;
}) {
  const { copy, locale } = useLanguage();
  const [manual, setManual] = useState(0);
  const [loaded, setLoaded] = useState(emptyLoad<Attendance>);
  // A confirmed check-in or undo (revision) and a tap on refresh (manual) each start a new request.
  const request = `${revision}:${manual}`;

  useEffect(() => {
    let current = true;
    void api.attendance(token, eventId).then(
      data => { if (current) setLoaded(loadSucceeded(request, data, Date.now())); },
      error => { if (current) setLoaded(previous => loadFailed(previous, request, error)); },
    );
    return () => { current = false; };
  }, [token, eventId, request]);

  const { loading, failed, empty } = loadView(loaded, request);
  const { data, at, error } = loaded;
  if (empty && loading) return <Text accessibilityLiveRegion="polite">{copy.loadingAttendance}</Text>;

  const expired = failed && error instanceof ApiError && error.status === 401;
  const time = at === null ? '' : new Date(at).toLocaleTimeString(localeTag(locale));
  return <View style={styles.box}>
    {data && <Text accessibilityLiveRegion="polite" style={styles.count}>
      {copy.attendanceCount(data.checked_in, data.tickets_issued, data.capacity)}
    </Text>}
    {data && !failed && <Text style={styles.note}>{copy.attendanceUpdatedAt(time)}</Text>}
    {failed && <Text accessibilityRole="alert" style={styles.error}>
      {data ? copy.attendanceStale(time) : copy.attendanceUnavailable} {errorMessage(error, locale)}
    </Text>}
    {expired
      ? <Button title={copy.signInAgain} disabled={locked} onPress={onSignInAgain} />
      : <Button title={loading ? copy.refreshingAttendance : copy.refreshAttendance} disabled={locked || loading}
        onPress={() => setManual(value => value + 1)} />}
  </View>;
}

export function AttendeeSearch({ token, userId, eventId, locked, canUndo, canAct, onClose, onMark, onChanged, onSignInAgain }: EventAccess & {
  userId: number;
  locked: boolean;
  canUndo: boolean;
  canAct: () => boolean;
  onClose: () => void;
  onMark: (payload: string) => void;
  onChanged: () => void;
}) {
  const { copy } = useLanguage();
  const [query, setQuery] = useState('');
  const [submission, setSubmission] = useState<{ term: string; attempt: number } | null>(null);
  const valid = canSearchAttendees(query);

  function submit() {
    if (locked || !valid) return;
    setSubmission(previous => ({ term: query.trim(), attempt: (previous?.attempt ?? 0) + 1 }));
  }

  function reload() {
    // Reads the list again from the server; the edited text field is left alone.
    setSubmission(previous => previous && { term: previous.term, attempt: previous.attempt + 1 });
    onChanged();
  }

  if (locked) return null;

  return <View style={styles.box}>
    <Text style={styles.count}>{copy.findManually}</Text>
    <Text>{copy.searchHint}</Text>
    <TextInput accessibilityLabel={copy.attendeeQuery} placeholder={copy.attendeeQuery} value={query}
      onChangeText={value => { setQuery(value); setSubmission(null); }}
      autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={submit} style={styles.input} />
    <Button title={copy.search} disabled={!valid} onPress={submit} />
    <Button title={copy.backToCamera} onPress={onClose} />
    {submission && <AttendeeResults key={submission.attempt} term={submission.term} token={token} userId={userId}
      eventId={eventId} canUndo={canUndo} canAct={canAct} onMark={onMark} onUndone={reload} onSignInAgain={onSignInAgain} />}
  </View>;
}

function AttendeeResults({ token, userId, eventId, term, canUndo, canAct, onMark, onUndone, onSignInAgain }: EventAccess & {
  userId: number;
  term: string;
  canUndo: boolean;
  canAct: () => boolean;
  onMark: (payload: string) => void;
  onUndone: () => void;
}) {
  const { copy, locale } = useLanguage();
  const [result, setResult] = useState<LoadResult<Attendee[]> | null>(null);
  const attached = useRef(false);

  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void api.attendees(token, eventId, term).then(
      data => { if (current) setResult({ data }); },
      error => { if (current) setResult({ error }); },
    );
    return () => { current = false; };
  }, [token, eventId, term]);

  if (!result) return <Text accessibilityLiveRegion="polite">{copy.searchingAttendees}</Text>;
  if ('error' in result) {
    const expired = result.error instanceof ApiError && result.error.status === 401;
    return <>
      <Text accessibilityRole="alert" style={styles.error}>{errorMessage(result.error, locale)}</Text>
      {expired && <Button title={copy.signInAgain} onPress={onSignInAgain} />}
    </>;
  }
  if (!result.data.length) return <Text accessibilityLiveRegion="polite">{copy.noAttendees}</Text>;

  return result.data.map(item => <View key={item.ticket_id} style={styles.attendee}>
    <Text style={styles.count}>{item.full_name}</Text>
    <Text>{item.masked_email}</Text>
    {item.status === 'cancelled' ? <Text style={styles.error}>{copy.ticketCancelled}</Text>
      : item.status === 'refunded' ? <Text style={styles.error}>{copy.ticketRefunded}</Text>
        : item.checked_in_at !== null ? <>
          <Text>{copy.enteredAt} · {new Date(item.checked_in_at).toLocaleString(localeTag(locale))}</Text>
          {canUndo && item.check_in_id !== null && <UndoEntry token={token} userId={userId} eventId={eventId}
            checkInId={item.check_in_id} name={item.full_name} canAct={canAct} onUndone={onUndone} />}
        </> : (
          <Button title={copy.markEntry} accessibilityLabel={`${copy.markEntry} · ${item.full_name}`}
            onPress={() => { if (attached.current) onMark(item.qr_payload); }} />
        )}
  </View>);
}

export const undoStore = createUndoStore(
  (token, eventId, checkInId, requestId) => api.undoCheckIn(token, eventId, checkInId, requestId), randomUUID,
);

export function useUndoStore() {
  useSyncExternalStore(undoStore.subscribe, undoStore.version);
  return undoStore;
}

type UndoAccess = {
  token: string;
  userId: number;
  eventId: number;
  canAct: () => boolean;
  onUndone: (receipt: UndoReceipt) => void;
};

// Starts the undo of one admission after an explicit confirmation. Only an UNDONE receipt for this
// check-in counts. A request without a definite answer lives in the undo store and is continued from
// PendingUndos, so it outlives this row, the scanner screen and a new sign-in.
export function UndoEntry({ token, userId, eventId, checkInId, name, canAct, onUndone }: UndoAccess & {
  checkInId: number;
  name: string;
}) {
  const { copy, locale } = useLanguage();
  const store = useUndoStore();
  const attached = useRef(false);
  const [refused, setRefused] = useState<ApiError | null>(null);
  const entry = store.find(userId, eventId, checkInId);

  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  function send() {
    const attempt = store.undo({ token, userId }, eventId, checkInId, name);
    if (!attempt) return;
    setRefused(null);
    void attempt.then(result => {
      if (!attached.current) return;
      if (result.receipt) onUndone(result.receipt);
      else if (!store.find(userId, eventId, checkInId)) setRefused(result.error);
    });
  }

  function confirm() {
    if (entry || !canAct()) return;
    Alert.alert(copy.undoTitle, copy.undoHint(name), [
      { text: copy.undoKeep, style: 'cancel' },
      { text: copy.undoEntry, style: 'destructive', onPress: () => { if (attached.current && canAct()) send(); } },
    ]);
  }

  if (entry) return <Text accessibilityLiveRegion="polite">{entry.busy ? copy.undoing : copy.undoPending}</Text>;
  return <>
    {refused && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(refused, locale)}</Text>}
    <Button title={copy.undoEntry} accessibilityLabel={`${copy.undoEntry} · ${name}`} onPress={confirm} />
  </>;
}

// This account's undo requests for the event that have no definite answer yet. Retrying sends the same
// request ID. After a 401 the retry is offered once the account has signed in again with a new token.
export function PendingUndos({ token, userId, eventId, locked, canAct, onUndone, onChanged, onSignInAgain }: UndoAccess & {
  locked: boolean;
  onChanged: () => void;
  onSignInAgain: () => void;
}) {
  const { copy, locale } = useLanguage();
  const store = useUndoStore();
  const attached = useRef(false);
  const [settled, setSettled] = useState<{ label: string; error: ApiError | null } | null>(null);
  const entries = store.pending(userId, eventId);
  const open = entries.length;
  const seen = useRef(open);

  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  useEffect(() => {
    // A request left the list: it was confirmed or refused, so the totals may have changed.
    if (open < seen.current) onChanged();
    seen.current = open;
  }, [open, onChanged]);

  function retry(checkInId: number, label: string) {
    if (locked || !canAct()) return;
    const attempt = store.undo({ token, userId }, eventId, checkInId, label);
    if (!attempt) return;
    setSettled(null);
    void attempt.then(result => {
      if (!attached.current) return;
      if (result.receipt) { setSettled({ label, error: null }); onUndone(result.receipt); }
      else if (!store.find(userId, eventId, checkInId)) setSettled({ label, error: result.error });
    });
  }

  if (!open && !settled) return null;
  return <View style={styles.box}>
    {entries.map(entry => <View key={entry.checkInId} style={styles.attendee}>
      <Text style={styles.count}>{copy.undoPendingTitle} · {entry.label}</Text>
      {entry.busy ? <Text accessibilityLiveRegion="polite">{copy.undoing}</Text> : <>
        {entry.lastError && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(entry.lastError, locale)}</Text>}
        <Text>{copy.undoUnknown}</Text>
        <Text selectable>{copy.requestId}: {entry.requestId}</Text>
        {entry.expiredToken === token
          ? <Button title={copy.signInAgain} disabled={locked} onPress={onSignInAgain} />
          : <Button title={copy.retryUndo} accessibilityLabel={`${copy.retryUndo} · ${entry.label}`}
            disabled={locked} onPress={() => retry(entry.checkInId, entry.label)} />}
      </>}
    </View>)}
    {settled && <Text accessibilityLiveRegion="polite" style={settled.error ? styles.error : styles.count}>
      {settled.label}: {settled.error ? errorMessage(settled.error, locale) : copy.undone}
    </Text>}
  </View>;
}

const styles = StyleSheet.create({
  count: { fontWeight: '600', color: '#163d79' },
  note: { color: '#475569' },
  box: { padding: 16, borderRadius: 10, backgroundColor: '#e2e8f0', gap: 12 },
  attendee: { padding: 12, borderRadius: 8, backgroundColor: 'white', gap: 6 },
  error: { color: '#9f1c25' },
  input: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, backgroundColor: 'white', padding: 12, fontSize: 16 },
});
