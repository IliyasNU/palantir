import { useEffect, useState } from 'react';
import { ActivityIndicator, Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useIsFocused } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError, type StaffEvent } from '../api';
import { useUndoStore } from '../attendance';
import { useSession } from '../session';
import { useLanguage } from '../language';
import { errorMessage, localeTag } from '../messages';

export default function EventsScreen() {
  const { session } = useSession();
  const focused = useIsFocused();

  if (!session?.token) return <Redirect href="/" />;
  if (!focused) return null;

  // Returning to this screen or changing accounts starts with a fresh list. A renewed token of the same
  // account only reloads it.
  return <EventsList key={session.userId} token={session.token} userId={session.userId} />;
}

function EventsList({ token, userId }: { token: string; userId: number }) {
  const { setSession, renew } = useSession();
  const { copy, locale } = useLanguage();
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  const [loadedToken, setLoadedToken] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // A new token invalidates the old assignments immediately, before the reload effect runs.
  const loading = busy || loadedToken !== token;
  // Events where this account still has an undo without a definite answer.
  const unconfirmed = new Set(useUndoStore().pending(userId).map(entry => entry.eventId));

  useEffect(() => {
    let active = true;
    // After a renewal this effect runs again with the new token; the list stays "loading" until then.
    let renewed = false;
    api.events(token).then(items => {
      if (active) { setEvents(items); setError(null); }
    })
      .catch(async problem => {
        if (!active) return;
        setEvents([]);
        if (problem instanceof ApiError && problem.status === 401) {
          // The access token expired: continue with the refresh token before asking for the password.
          const fresh = await renew();
          if (!active) return;
          if (fresh === 'rejected') { setSession(null); return; }
          if (fresh !== 'unavailable') { renewed = true; return; }
        }
        setError(problem);
      })
      .finally(() => { if (active && !renewed) { setLoadedToken(token); setBusy(false); } });
    return () => { active = false; };
  }, [token, reload, setSession, renew]);

  return (
    <SafeAreaView edges={['bottom']} style={styles.page}>
      <Text style={styles.hint}>{copy.eventsHint}</Text>
      <View style={styles.actions}>
        <Button title={copy.refresh} disabled={loading} onPress={() => {
          setBusy(true); setError(null); setEvents([]); setReload(value => value + 1);
        }} />
        <Button title={copy.signOut} onPress={() => setSession(null)} />
      </View>
      {loading && <ActivityIndicator accessibilityLabel={copy.loadingEvents} />}
      {!loading && error !== null && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(error, locale)}</Text>}
      <FlatList data={loading ? [] : events} keyExtractor={item => String(item.id)}
        ListEmptyComponent={!loading && error === null ? <Text>{copy.noEvents}</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`${copy.scanTickets}: ${item.title}`} style={styles.event}
            disabled={loading} accessibilityState={{ disabled: loading }}
            onPress={() => {
              if (!loading) {
                router.push({ pathname: '/scan', params: {
                  id: String(item.id), title: item.title, manage: item.can_manage === true ? '1' : '0',
                } });
              }
            }}>
            <Text style={styles.title}>{item.title}</Text>
            <Text>{new Date(item.date).toLocaleString(localeTag(locale))}</Text>
            <Text>{item.location}</Text>
            {unconfirmed.has(item.id) && <Text accessibilityRole="alert" style={styles.error}>{copy.eventUndoPending}</Text>}
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
