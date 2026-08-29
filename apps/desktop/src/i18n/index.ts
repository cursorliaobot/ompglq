import { resources, type Locale, type TranslationKey } from "./resources";

export type Translate = (key: TranslationKey) => string;

export function translate(locale: Locale, key: TranslationKey): string {
  return resources[locale][key];
}

export function createTranslator(locale: Locale): Translate {
  return (key) => translate(locale, key);
}

export function resolveLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith("en") === true ? "en-US" : "zh-CN";
}

const capabilityTranslationKeys: Readonly<Record<string, TranslationKey>> = {
  profile: "capability.profile",
  profiles: "capability.profile",
  cwd: "capability.cwd",
  session_resume: "capability.sessionResume",
  resume: "capability.sessionResume",
  session_fork: "capability.sessionFork",
  fork: "capability.sessionFork",
  session_export: "capability.sessionExport",
  export: "capability.sessionExport",
  models_json: "capability.modelsJson",
  config_json: "capability.configJson",
  usage: "capability.usage",
  credential_summary: "capability.usage",
  auth_broker: "capability.authBroker",
  auth_gateway: "capability.authGateway",
};

export function getCapabilityLabel(id: string, t: Translate): string {
  const key = capabilityTranslationKeys[id.toLowerCase()];
  return key === undefined ? id : t(key);
}
