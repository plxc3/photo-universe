declare module '*.css' {}

interface ImportMetaEnv {
  readonly BASE_URL?: string;
  readonly MODE?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}

interface Navigator {
  readonly deviceMemory?: number;
}

interface Window {
  __memoria?: Record<string, unknown>;
}
