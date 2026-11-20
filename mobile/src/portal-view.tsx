import { Linking, Button } from 'react-native';
import type { PortalCopy } from './portal-copy';

export type PortalViewProps = { entry: { origin: string; url: string }; copy: PortalCopy };

// Expo's browser target can open the same Vite application directly.
export function PortalView({ entry, copy }: PortalViewProps) {
  return <Button title={copy.inBrowser} onPress={() => { void Linking.openURL(entry.url); }} />;
}
