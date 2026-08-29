import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import { DatabaseStatusView } from "./components/DatabaseStatusPanel";
import { ProbeWorkbench } from "./components/ProbeWorkbench";
import { ProjectWorkbench } from "./components/ProjectWorkbench";
import { useDatabaseStatus } from "./hooks/useDatabaseStatus";
import { createTranslator, resolveLocale } from "./i18n";
import type { Locale } from "./i18n/resources";

type ThemePreference = "system" | "light" | "dark";

const LOCALE_STORAGE_KEY = "omp-manager.locale";
const THEME_STORAGE_KEY = "omp-manager.theme";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The preference remains valid for the current session when storage is unavailable.
  }
}

function initialLocale(): Locale {
  return resolveLocale(readStorage(LOCALE_STORAGE_KEY) ?? window.navigator.language);
}

function initialTheme(): ThemePreference {
  const stored = readStorage(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function isThemePreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isLocale(value: string): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const database = useDatabaseStatus();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const databaseReady =
    database.state.phase === "resolved" && database.state.report.availability === "ready";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.title");
    writeStorage(LOCALE_STORAGE_KEY, locale);
  }, [locale, t]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const handleLocaleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (isLocale(event.currentTarget.value)) {
      setLocale(event.currentTarget.value);
    }
  };

  const handleThemeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (isThemePreference(event.currentTarget.value)) {
      setTheme(event.currentTarget.value);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            OMP
          </span>
          <div>
            <strong>{t("app.title")}</strong>
            <span>{t("app.subtitle")}</span>
          </div>
        </div>

        <div className="preference-controls">
          <label>
            <span>{t("language.label")}</span>
            <select value={locale} onChange={handleLocaleChange}>
              <option value="zh-CN">{t("language.zhCN")}</option>
              <option value="en-US">{t("language.enUS")}</option>
            </select>
          </label>
          <label>
            <span>{t("theme.label")}</span>
            <select value={theme} onChange={handleThemeChange}>
              <option value="system">{t("theme.system")}</option>
              <option value="light">{t("theme.light")}</option>
              <option value="dark">{t("theme.dark")}</option>
            </select>
          </label>
        </div>
      </header>

      <main className="app-main">
        <DatabaseStatusView state={database.state} retry={database.retry} t={t} />
        <ProjectWorkbench enabled={databaseReady} locale={locale} t={t} />
        <ProbeWorkbench locale={locale} t={t} />
      </main>
    </div>
  );
}
