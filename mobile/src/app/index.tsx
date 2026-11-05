import { useEffect, useRef, useState } from 'react';
import { Button, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Redirect } from 'expo-router';
import { api } from '../api';
import { useSession } from '../session';
import { useLanguage } from '../language';
import { errorMessage } from '../messages';

export default function LoginScreen() {
  const { session, setSession } = useSession();
  const { copy, locale } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [action, setAction] = useState<'login' | 'connection' | null>(null);
  const [connection, setConnection] = useState<{ ok: true } | { error: unknown } | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const busy = action !== null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function checkConnection() {
    if (submitting.current) return;
    submitting.current = true;
    setAction('connection');
    setConnection(null);
    try {
      await api.health();
      if (mounted.current) setConnection({ ok: true });
    } catch (problem) {
      if (mounted.current) setConnection({ error: problem });
    } finally {
      submitting.current = false;
      if (mounted.current) setAction(null);
    }
  }

  async function login() {
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true;
    setAction('login');
    setError(null);
    try {
      const freshSession = await api.login(email, password);
      if (mounted.current) setSession(freshSession);
    } catch (problem) {
      if (mounted.current) setError(problem);
    } finally {
      submitting.current = false;
      if (mounted.current) { setPassword(''); setAction(null); }
    }
  }

  if (session) return <Redirect href="/events" />;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{copy.signInTitle}</Text>
        <Text>{copy.signInHint}</Text>
        <Text style={styles.label}>{copy.email}</Text>
        <TextInput accessibilityLabel={copy.email} style={styles.input} value={email} onChangeText={setEmail}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
        <Text style={styles.label}>{copy.password}</Text>
        <TextInput accessibilityLabel={copy.password} style={styles.input} value={password} onChangeText={setPassword}
          secureTextEntry autoCapitalize="none" autoComplete="current-password" editable={!busy}
          returnKeyType="go" onSubmitEditing={login} />
        {error !== null && <Text accessibilityRole="alert" style={styles.error}>{errorMessage(error, locale, true)}</Text>}
        <Button title={action === 'login' ? copy.signingIn : copy.signIn} onPress={login} disabled={busy || !email.trim() || !password} />
        <Text style={styles.label}>{action === 'connection' ? copy.checkingConnection : ''}</Text>
        <Button title={copy.checkConnection} disabled={busy} onPress={checkConnection} />
        {connection && <Text accessibilityLiveRegion="polite" style={'error' in connection ? styles.error : styles.connected}>
          {'error' in connection ? errorMessage(connection.error, locale) : copy.connected}
        </Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingBottom: 48 },
  title: { fontSize: 26, fontWeight: '700', color: '#163d79', marginBottom: 12 },
  label: { marginTop: 24, marginBottom: 8, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, backgroundColor: 'white', padding: 12, fontSize: 16, marginBottom: 12 },
  error: { color: '#9f1c25', marginVertical: 16 },
  connected: { color: '#065f46', marginVertical: 16 },
});

