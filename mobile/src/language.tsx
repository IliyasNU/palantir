import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { languages, messages, type Locale } from './messages';

const LanguageContext = createContext<{
  locale: Locale;
  setLocale: (value: Locale) => void;
}>({ locale: 'ru', setLocale: () => {} });

export function LanguageProvider({ children }: PropsWithChildren) {
  const [locale, setLocale] = useState<Locale>('ru');
  return <LanguageContext.Provider value={{ locale, setLocale }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const language = useContext(LanguageContext);
  return { ...language, copy: messages[language.locale] };
}

// Three compact text buttons: native buttons for three languages do not fit beside the screen title.
export function LanguagePicker() {
  const { locale, setLocale } = useLanguage();
  return (
    <View style={styles.row}>
      {languages.map(language => {
        const selected = language.locale === locale;
        return (
          <Pressable key={language.locale} accessibilityRole="button" accessibilityLabel={language.name}
            accessibilityState={{ selected, disabled: selected }} disabled={selected} hitSlop={8}
            onPress={() => setLocale(language.locale)} style={[styles.option, selected && styles.selected]}>
            <Text style={[styles.label, selected && styles.selectedLabel]}>{language.short}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  option: { paddingHorizontal: 6, paddingVertical: 6, borderRadius: 6 },
  selected: { backgroundColor: '#163d79' },
  label: { fontSize: 13, fontWeight: '600', color: '#163d79' },
  selectedLabel: { color: 'white' },
});
