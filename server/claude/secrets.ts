// server/claude/secrets.ts — request_secret lagrar värdet i apps/<id>/data/secrets.json (CONTRACT §8.7).
// Filen har läge 0600 och skrivs atomiskt. Före skrivningen görs lstat på apps/<id>/data, och en symbolisk
// länk vägras (§4.6). Värdet loggas, sparas och sänds aldrig någon annanstans; felmeddelanden innehåller det aldrig.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SECRET_KEY_RE = /^[a-z0-9_]{1,64}$/;

export class SecretStoreError extends Error {}

/** Läser befintliga secrets.json utan att följa en symbolisk länk. */
function readExisting(file: string): Record<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return {};
    throw new SecretStoreError('data/secrets.json is not a regular file; refusing to store the secret.');
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new SecretStoreError('data/secrets.json is not a regular file; refusing to store the secret.');
    const text = fs.readFileSync(fd, 'utf8');
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, string> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') out[k] = x;
        return out;
      }
    } catch {
      /* trasig fil: börja om */
    }
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lägger in key = value i <appDir>/data/secrets.json.
 * Kastar SecretStoreError (utan värdet i meddelandet) om data/ eller filen är en symbolisk länk.
 */
export function storeSecret(appDir: string, key: string, value: string): void {
  if (!SECRET_KEY_RE.test(key)) throw new SecretStoreError('Invalid key.');
  const dataDir = path.join(appDir, 'data');
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new SecretStoreError('data/ cannot be inspected; refusing to store the secret.');
  }
  if (st && st.isSymbolicLink()) throw new SecretStoreError('data/ is a symbolic link; refusing to store the secret.');
  if (st && !st.isDirectory()) throw new SecretStoreError('data/ is not a directory; refusing to store the secret.');
  if (!st) fs.mkdirSync(dataDir, { mode: 0o700 });
  const file = path.join(dataDir, 'secrets.json');
  const all = readExisting(file);
  all[key] = value;
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, JSON.stringify(all, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* finns inte */ }
    throw new SecretStoreError('data/secrets.json could not be written.');
  }
}
