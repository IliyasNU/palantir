import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Button, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { isPortalUrl, readTicketPdfMessage } from './portal';
import type { PortalViewProps } from './portal-view';

export function PortalView({ entry, copy }: PortalViewProps) {
  // The package's default generic intersects its props with undefined in strict mode.
  const web = useRef<WebView<object>>(null);
  const sharing = useRef(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [failed, setFailed] = useState(false);

  useFocusEffect(useCallback(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack || failed) return false;
      web.current?.goBack();
      return true;
    });
    return () => listener.remove();
  }, [canGoBack, failed]));

  async function shareTicket(event: WebViewMessageEvent) {
    if (sharing.current) return;
    const pdf = readTicketPdfMessage(event.nativeEvent.data, event.nativeEvent.url, entry.origin);
    if (!pdf) return;
    sharing.current = true;
    try {
      if (!await isAvailableAsync()) throw new Error('Sharing unavailable');
      const file = new File(Paths.cache, pdf.name);
      file.create({ overwrite: true });
      file.write(pdf.base64, { encoding: 'base64' });
      await shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    } catch {
      Alert.alert(copy.shareFailed);
    } finally {
      sharing.current = false;
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.page}>
      <Stack.Screen options={{ headerRight: () => canGoBack && !failed
        ? <Pressable accessibilityRole="button" accessibilityLabel={copy.previous} hitSlop={8}
          style={styles.previous} onPress={() => web.current?.goBack()}>
          <Text style={styles.previousLabel}>‹</Text>
        </Pressable>
        : null }} />
      {failed
        ? <View style={styles.problem}>
          <Text accessibilityRole="alert" style={styles.error}>{copy.unavailable}</Text>
          <Button title={copy.retry} onPress={() => { setCanGoBack(false); setFailed(false); }} />
        </View>
        : <WebView<object> ref={web} source={{ uri: entry.url }}
          originWhitelist={['*']} onShouldStartLoadWithRequest={request => isPortalUrl(request.url, entry.origin)}
          allowFileAccess={false} mixedContentMode="never" javaScriptCanOpenWindowsAutomatically={false}
          onOpenWindow={() => { /* The portal uses same-window navigation. */ }}
          onNavigationStateChange={state => setCanGoBack(state.canGoBack)}
          onError={() => setFailed(true)}
          onHttpError={({ nativeEvent }) => { if (nativeEvent.url === entry.url) setFailed(true); }}
          onMessage={event => { void shareTicket(event); }}
          startInLoadingState
          renderLoading={() => <ActivityIndicator accessibilityLabel={copy.loading} style={styles.spinner} />} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  problem: { padding: 24, gap: 12 },
  error: { color: '#9f1c25', fontSize: 16 },
  previous: { minWidth: 44, alignItems: 'center' },
  previousLabel: { color: '#163d79', fontSize: 32 },
  spinner: { position: 'absolute', top: 28, alignSelf: 'center' },
});
