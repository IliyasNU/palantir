import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useLanguage } from '../language';
import { portalAreas } from '../portal';
import { portalCopy } from '../portal-copy';

export default function HomeScreen() {
  const { locale } = useLanguage();
  const copy = portalCopy[locale];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title} accessibilityRole="header">{copy.homeTitle}</Text>
      {portalAreas.map(area => (
        <RoleCard key={area} title={copy[area].title} hint={copy[area].hint}
          onPress={() => router.push({ pathname: '/portal', params: { area } })} />
      ))}
      <RoleCard title={copy.staff.title} hint={copy.staff.hint} onPress={() => router.push('/staff')} />
    </ScrollView>
  );
}

function RoleCard({ title, hint, onPress }: { title: string; hint: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint}
      onPress={onPress} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingBottom: 48, gap: 12 },
  title: { fontSize: 26, fontWeight: '700', color: '#163d79', marginBottom: 4 },
  card: { borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: 'white', padding: 16, gap: 4 },
  pressed: { backgroundColor: '#eaf2ff' },
  cardTitle: { color: '#163d79', fontWeight: '700', fontSize: 18 },
  hint: { color: '#475569', fontSize: 15 },
});
