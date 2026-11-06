import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import { Button, View } from 'react-native';
import { messages, type Locale } from './messages';

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

export function LanguagePicker() {
  const { locale, setLocale } = useLanguage();
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      <Button title="РУС" accessibilityLabel="Русский" disabled={locale === 'ru'} onPress={() => setLocale('ru')} />
      <Button title="ҚАЗ" accessibilityLabel="Қазақша" disabled={locale === 'kk'} onPress={() => setLocale('kk')} />
    </View>
  );
}
