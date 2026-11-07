import { useEffect, useState } from 'react';
import { ActivityIndicator, Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useIsFocused } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError, type StaffEvent } from '../api';
import { useSession } from '../session';
import { useLanguage } from '../language';
import { errorMessage } from '../messages';

export default function EventsScreen() {
  const { session } = useSession();
  const focused = useIsFocused();

  if (!session?.token) return <Redirect href="/" />;
  if (!focused) return null;

  // Returning to this screen or changing accounts starts with a fresh list.
  return <EventsList key={session.token} token={session.token} />;
}

function EventsList({ token }: { token: string }) {
  const { setSession } = useSession();
  const { copy, locale } = useLanguage();
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    api.events(token).then(items => {
      if (active) { setEvents(items); setError(null); }
    })
      .catch(problem => {
        if (!active) return;
        setEvents([]);
        if (problem instanceof ApiError && problem.status === 401) {
          setSession(null);
          return;
        }
        setError(problem);
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [token, reload, setSession]);

  return (
    <SafeAreaView edges={['bottom']} style={styles.page}>
      <Text style={styles.hint}>{copy.eventsHint}</Text>
      <View style={styles.actions}>
        <Button title={copy.refresh} disabled={busy} onPress={() => {
          setBusy(true); setError(null); setEvents([]); setReload(value => value + 1);
        }} />
        <Button title={copy.signOut} onPress={() => setSession(null)} />
      </View>
      {busy && <ActivityIndicator accessibilityLabel={copy.loadingEvents} />}
      {error !== null && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(error, locale)}</Text>}
      <FlatList data={events} keyExtractor={item => String(item.id)}
        ListEmptyComponent={!busy && error === null ? <Text>{copy.noEvents}</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`${copy.scanTickets}: ${item.title}`} style={styles.event}
            disabled={busy} accessibilityState={{ disabled: busy }}
            onPress={() => {
              if (!busy) router.push({ pathname: '/scan', params: { id: String(item.id), title: item.title } });
            }}>
            <Text style={styles.title}>{item.title}</Text>
            <Text>{new Date(item.date).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')}</Text>
            <Text>{item.location}</Text>
            <Text style={styles.link}>{copy.scanTickets} →</Text>
          </Pressable>
        )} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 20 },
  hint: { color: '#475569', marginBottom: 12 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  event: { padding: 18, marginBottom: 14, borderRadius: 10, backgroundColor: 'white', borderWidth: 1, borderColor: '#cbd5e1', gap: 6 },
  title: { fontSize: 19, fontWeight: '600' },
  link: { color: '#163d79', fontWeight: '600', marginTop: 8 },
  error: { color: '#9f1c25', marginBottom: 20 },
});
