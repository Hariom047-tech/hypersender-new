import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard KDF, built into Node - no native
 * dependency). Parameters follow OWASP guidance (N=2^17, r=8, p=1). Format:
 *   $scrypt$ln=17,r=8,p=1$<salt b64>$<hash b64>
 * The users.password_hash CHECK accepts only '$scrypt$' / '$argon2id$' strings,
 * so a plaintext password can never be stored by mistake. Swapping to argon2id
 * later only needs a new prefix + verify branch (rehash on next login).
 */
const DEFAULT_LOG_N = 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string, logN = DEFAULT_LOG_N): Promise<string> {
  if (password.length < 8 || password.length > 1024) throw new Error('password length must be 8..1024');
  const salt = randomBytes(16);
  const N = 2 ** logN;
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: 256 * N * R });
  return `$scrypt$ln=${logN},r=${R},p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const [, ln, r, p, saltB64, keyB64] = m;
  const N = 2 ** Number(ln);
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N, r: Number(r), p: Number(p), maxmem: 256 * N * Number(r) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
