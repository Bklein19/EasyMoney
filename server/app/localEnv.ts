import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = path.resolve(import.meta.dir, '..', '..', '.env.local');

function parseEnvFile(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function serializeEnv(values: Map<string, string>) {
  return `${[...values.entries()]
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
}

export function loadLocalEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const values = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  for (const [key, value] of values) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function saveLocalEnvValue(key: string, value: string) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid env key: ${key}`);
  const existing = fs.existsSync(ENV_FILE)
    ? parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'))
    : new Map<string, string>();
  existing.set(key, value);
  fs.writeFileSync(ENV_FILE, serializeEnv(existing), { mode: 0o600 });
  process.env[key] = value;
  return { path: ENV_FILE };
}
