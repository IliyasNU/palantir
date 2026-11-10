import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { api, ApiError, canSearchAttendees, type Attendance, type Attendee, type UndoReceipt } from './api';
import { useLanguage } from './language';
import { emptyLoad, loadFailed, loadSucceeded, loadView } from './loading';
import { errorMessage, type Locale } from './messages';
import { createUndoSession } from './scanner';

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

export function AttendeeSearch({ token, eventId, locked, canUndo, canAct, onClose, onMark, onChanged, onSignInAgain }: EventAccess & {
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
    {submission && <AttendeeResults key={submission.attempt} term={submission.term} token={token} eventId={eventId}
      canUndo={canUndo} canAct={canAct} onMark={onMark} onUndone={reload} onSignInAgain={onSignInAgain} />}
  </View>;
}

function AttendeeResults({ token, eventId, term, canUndo, canAct, onMark, onUndone, onSignInAgain }: EventAccess & {
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
          {canUndo && item.check_in_id !== null && <UndoEntry token={token} eventId={eventId}
            checkInId={item.check_in_id} name={item.full_name} canAct={canAct} onUndone={onUndone}
            onSignInAgain={onSignInAgain} />}
        </> : (
          <Button title={copy.markEntry} accessibilityLabel={`${copy.markEntry} · ${item.full_name}`}
            onPress={() => { if (attached.current) onMark(item.qr_payload); }} />
        )}
  </View>);
}

// Reverses one admission after an explicit confirmation. Only an UNDONE receipt for this check-in counts;
// while the outcome is unknown the same request ID is sent again.
export function UndoEntry({ token, eventId, checkInId, name, canAct, onUndone, onSignInAgain }: EventAccess & {
  checkInId: number;
  name: string;
  canAct: () => boolean;
  onUndone: (receipt: UndoReceipt) => void;
}) {
  const { copy, locale } = useLanguage();
  const attached = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ error: ApiError; retry: boolean } | null>(null);
  const undo = useMemo(() => createUndoSession(
    (access, id, requestId) => api.undoCheckIn(access, eventId, id, requestId), randomUUID,
  ), [eventId]);

  useEffect(() => { undo.setToken(token); }, [undo, token]);
  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  function send() {
    const attempt = undo.undo(checkInId);
    if (!attempt) return;
    setBusy(true);
    setProblem(null);
    void attempt.then(result => {
      if (!attached.current) return;
      setBusy(false);
      if (result.receipt) onUndone(result.receipt);
      else setProblem({ error: result.error, retry: undo.unconfirmed(checkInId) });
    });
  }

  function confirm() {
    if (busy || !canAct()) return;
    Alert.alert(copy.undoTitle, copy.undoHint(name), [
      { text: copy.undoKeep, style: 'cancel' },
      { text: copy.undoEntry, style: 'destructive', onPress: () => { if (attached.current && canAct()) send(); } },
    ]);
  }

  const expired = problem?.error.status === 401;
  return <>
    {busy && <Text accessibilityLiveRegion="polite">{copy.undoing}</Text>}
    {problem && <Text accessibilityRole="alert" style={styles.error}>
      {errorMessage(problem.error, locale)}{problem.retry && !expired ? ` ${copy.undoUnknown}` : ''}
    </Text>}
    {expired ? <Button title={copy.signInAgain} onPress={onSignInAgain} />
      : problem?.retry ? <Button title={copy.retryUndo} disabled={busy}
        onPress={() => { if (canAct()) send(); }} />
        : <Button title={copy.undoEntry} accessibilityLabel={`${copy.undoEntry} · ${name}`} disabled={busy}
          onPress={confirm} />}
  </>;
}

const styles = StyleSheet.create({
  count: { fontWeight: '600', color: '#163d79' },
  note: { color: '#475569' },
  box: { padding: 16, borderRadius: 10, backgroundColor: '#e2e8f0', gap: 12 },
  attendee: { padding: 12, borderRadius: 8, backgroundColor: 'white', gap: 6 },
  error: { color: '#9f1c25' },
  input: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, backgroundColor: 'white', padding: 12, fontSize: 16 },
});
