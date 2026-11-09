import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, canSearchAttendees, type Attendance, type Attendee } from './api';
import { useLanguage } from './language';
import { errorMessage } from './messages';

type EventAccess = {
  token: string;
  eventId: number;
  onSignInAgain: () => void;
};

type LoadResult<T> = { data: T } | { error: unknown };

export function AttendanceCount({ token, eventId, locked, onReload, onSignInAgain }: EventAccess & {
  locked: boolean;
  onReload: () => void;
}) {
  const { copy, locale } = useLanguage();
  const [result, setResult] = useState<LoadResult<Attendance> | null>(null);

  useEffect(() => {
    let current = true;
    void api.attendance(token, eventId).then(
      data => { if (current) setResult({ data }); },
      error => { if (current) setResult({ error }); },
    );
    return () => { current = false; };
  }, [token, eventId]);

  if (!result) return <Text accessibilityLiveRegion="polite">{copy.loadingAttendance}</Text>;
  if ('error' in result) {
    const expired = result.error instanceof ApiError && result.error.status === 401;
    return <View style={styles.box}>
      <Text accessibilityRole="alert" style={styles.error}>{copy.attendanceUnavailable} {errorMessage(result.error, locale)}</Text>
      <Button title={expired ? copy.signInAgain : copy.refresh} disabled={locked}
        onPress={expired ? onSignInAgain : onReload} />
    </View>;
  }
  const { checked_in, tickets_issued, capacity } = result.data;
  return <Text accessibilityLiveRegion="polite" style={styles.count}>
    {copy.attendanceCount(checked_in, tickets_issued, capacity)}
  </Text>;
}

export function AttendeeSearch({ token, eventId, locked, onClose, onMark, onSignInAgain }: EventAccess & {
  locked: boolean;
  onClose: () => void;
  onMark: (payload: string) => void;
}) {
  const { copy } = useLanguage();
  const [query, setQuery] = useState('');
  const [submission, setSubmission] = useState<{ term: string; attempt: number } | null>(null);
  const valid = canSearchAttendees(query);

  function submit() {
    if (locked || !valid) return;
    setSubmission(previous => ({ term: query.trim(), attempt: (previous?.attempt ?? 0) + 1 }));
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
      onMark={onMark} onSignInAgain={onSignInAgain} />}
  </View>;
}

function AttendeeResults({ token, eventId, term, onMark, onSignInAgain }: EventAccess & {
  term: string;
  onMark: (payload: string) => void;
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
    {item.checked_in_at !== null ? (
      <Text>{copy.enteredAt} · {new Date(item.checked_in_at).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')}</Text>
    ) : (
      <Button title={copy.markEntry} accessibilityLabel={`${copy.markEntry} · ${item.full_name}`}
        onPress={() => { if (attached.current) onMark(item.qr_payload); }} />
    )}
  </View>);
}

const styles = StyleSheet.create({
  count: { fontWeight: '600', color: '#163d79' },
  box: { padding: 16, borderRadius: 10, backgroundColor: '#e2e8f0', gap: 12 },
  attendee: { padding: 12, borderRadius: 8, backgroundColor: 'white', gap: 6 },
  error: { color: '#9f1c25' },
  input: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, backgroundColor: 'white', padding: 12, fontSize: 16 },
});
