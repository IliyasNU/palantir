import { useRef, useState } from 'react';
import { Button, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Redirect } from 'expo-router';
import { api, ApiError } from '../api';
import { useSession } from '../session';

export default function LoginScreen() {
  const { token, setToken } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  async function login() {
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      setToken(await api.login(email, password));
      setPassword('');
    } catch (problem) {
      setError(problem instanceof ApiError && problem.status === 401 ? 'Incorrect email or password.'
        : problem instanceof Error ? problem.message : 'Could not sign in.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (token) return <Redirect href="/events" />;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Staff sign in</Text>
        <Text>Use the account assigned to your event by its organizer.</Text>
        <Text style={styles.label}>Email</Text>
        <TextInput accessibilityLabel="Email" style={styles.input} value={email} onChangeText={setEmail}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
        <Text style={styles.label}>Password</Text>
        <TextInput accessibilityLabel="Password" style={styles.input} value={password} onChangeText={setPassword}
          secureTextEntry autoCapitalize="none" autoComplete="current-password" editable={!busy}
          returnKeyType="go" onSubmitEditing={login} />
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Button title={busy ? 'Signing in…' : 'Sign in'} onPress={login} disabled={busy || !email.trim() || !password} />
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
});
