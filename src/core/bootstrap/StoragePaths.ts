export const CLAUDIAN_STORAGE_PATH = '.claudian';

export const LEGACY_CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';
export const CLAUDIAN_SETTINGS_PATH = `${CLAUDIAN_STORAGE_PATH}/claudian-settings.json`;

export const LEGACY_SESSIONS_PATH = '.claude/sessions';
export const SESSIONS_PATH = `${CLAUDIAN_STORAGE_PATH}/sessions`;

/** Vault-relative folder for provider-native transcripts mirrored for cross-machine sync. */
export const SESSION_TRANSCRIPTS_PATH = `${SESSIONS_PATH}/transcripts`;
