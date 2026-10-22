import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../session';

export default function Layout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: '#163d79', contentStyle: { backgroundColor: '#f6f8fc' } }}>
        <Stack.Screen name="index" options={{ title: 'BiletFlow Staff' }} />
        <Stack.Screen name="events" options={{ title: 'Choose an event', headerBackVisible: false }} />
        <Stack.Screen name="scan" options={{ title: 'Ticket check-in' }} />
      </Stack>
    </SessionProvider>
  );
}
