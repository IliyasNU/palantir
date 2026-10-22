import { useEffect, useState } from 'react';
import { ActivityIndicator, Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type StaffEvent } from '../api';
import { useSession } from '../session';

export default function EventsScreen() {
  const { token, setToken } = useSession();
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    let active = true;
    api.events(token).then(items => { if (active) setEvents(items); })
      .catch(problem => { if (active) setError(problem instanceof Error ? problem.message : 'Could not load events.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [token, reload]);

  if (!token) return <Redirect href="/" />;
  return (
    <SafeAreaView edges={['bottom']} style={styles.page}>
      <Text style={styles.hint}>Only events you can check in should appear here.</Text>
      <View style={styles.actions}>
        <Button title="Refresh" disabled={busy} onPress={() => {
          setBusy(true); setError(''); setEvents([]); setReload(value => value + 1);
        }} />
        <Button title="Sign out" onPress={() => setToken(null)} />
      </View>
      {busy && <ActivityIndicator accessibilityLabel="Loading events" />}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <FlatList data={events} keyExtractor={item => String(item.id)}
        ListEmptyComponent={!busy && !error ? <Text>No events assigned yet. Ask the organizer to add your account.</Text> : null}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Scan tickets for ${item.title}`} style={styles.event}
            onPress={() => router.push({ pathname: '/scan', params: { id: String(item.id), title: item.title } })}>
            <Text style={styles.title}>{item.title}</Text>
            <Text>{new Date(item.date).toLocaleString()}</Text>
            <Text>{item.location}</Text>
            <Text style={styles.link}>Scan tickets →</Text>
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
