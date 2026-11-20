import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useLanguage } from '../language';
import { portalArea, portalEntry } from '../portal';
import { portalCopy } from '../portal-copy';
import { PortalView } from '../portal-view';

export default function PortalScreen() {
  const { area: requestedArea } = useLocalSearchParams();
  const { locale } = useLanguage();
  const area = portalArea(requestedArea);
  const copy = portalCopy[locale];
  const entry = portalEntry(process.env.EXPO_PUBLIC_WEB_URL, area, __DEV__);

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: copy[area].title, headerBackButtonDisplayMode: 'minimal' }} />
      {entry
        ? <PortalView key={entry.url} entry={entry} copy={copy} />
        : <Text style={styles.message} accessibilityRole="alert">{copy.missing}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  message: { padding: 24, color: '#9f1c25', fontSize: 16 },
});
