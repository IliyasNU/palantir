import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../session';
import { LanguagePicker, LanguageProvider, useLanguage } from '../language';

export default function Layout() {
  return (
    <LanguageProvider>
      <SessionProvider><Navigation /></SessionProvider>
    </LanguageProvider>
  );
}

function Navigation() {
  const { copy } = useLanguage();
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{
        headerTransparent: false,
        headerTintColor: '#163d79',
        contentStyle: { backgroundColor: '#f6f8fc' },
        headerRight: () => <LanguagePicker />,
      }}>
        <Stack.Screen name="index" options={{ title: 'BiletFlow Staff' }} />
        <Stack.Screen name="events" options={{ title: copy.eventsTitle, headerBackVisible: false }} />
        <Stack.Screen name="scan" options={{ title: copy.scanTitle }} />
      </Stack>
    </>
  );
}

