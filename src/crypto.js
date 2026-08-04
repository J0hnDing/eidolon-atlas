import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { promisify } from 'node:util';
import { AtlasError, fail } from './errors.js';

const scrypt = promisify(scryptCallback);
export const DEFAULT_KDF = Object.freeze({ version: 1, name: 'scrypt', N: 1 << 15, r: 8, p: 1, keyLength: 32 });

function requirePassphrase(passphrase, label = 'passphrase') {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    fail(400, 'INVALID_PASSPHRASE', `${label} must be at least 8 characters.`);
  }
  if (Buffer.byteLength(passphrase, 'utf8') > 1024) {
    fail(400, 'INVALID_PASSPHRASE', `${label} is too long.`);
  }
}

export async function deriveKey(passphrase, salt, parameters = DEFAULT_KDF) {
  requirePassphrase(passphrase);
  if (!parameters || parameters.version !== 1 || parameters.name !== 'scrypt' ||
      !Number.isInteger(parameters.N) || !Number.isInteger(parameters.r) ||
      !Number.isInteger(parameters.p) || parameters.keyLength !== 32) {
    fail(500, 'UNSUPPORTED_KDF', 'The stored key derivation parameters are unsupported.');
  }
  return scrypt(passphrase, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * parameters.N * parameters.r + 1024 * 1024),
  });
}

export function objectAad(kind, id, revision, category) {
  return Buffer.from(`eidolon-atlas:v1:${kind}:${id}:${revision}:${category}`, 'utf8');
}

export function encryptBytes(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptBytes(key, envelope, aad) {
  try {
    if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('format');
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof AtlasError) throw error;
    fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted data could not be authenticated.');
  }
}

export function encryptJson(key, value, aad) {
  return JSON.stringify(encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'), aad));
}

export function decryptJson(key, stored, aad) {
  let envelope;
  try {
    envelope = typeof stored === 'string' ? JSON.parse(stored) : stored;
  } catch {
    fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted data has an invalid envelope.');
  }
  const bytes = decryptBytes(key, envelope, aad);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted data has an invalid payload.');
  } finally {
    bytes.fill(0);
  }
}

export function makeKeyCheck(key) {
  return encryptBytes(key, randomBytes(32), objectAad('key-check', 'local', 1, 'system'));
}

export function verifyKeyCheck(key, envelope) {
  const value = decryptBytes(key, envelope, objectAad('key-check', 'local', 1, 'system'));
  const valid = value.length === 32;
  value.fill(0);
  if (!valid) fail(422, 'DATA_INTEGRITY_ERROR', 'The key check has an invalid payload.');
  return valid;
}

export async function createBackupEnvelope(passphrase, snapshot) {
  requirePassphrase(passphrase, 'backup passphrase');
  const salt = randomBytes(16);
  const kdf = { ...DEFAULT_KDF };
  const key = await deriveKey(passphrase, salt, kdf);
  try {
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
    try {
      return {
        format: 'eidolon-atlas-backup',
        version: 1,
        kdf: { ...kdf, salt: salt.toString('base64') },
        cipher: encryptBytes(key, plaintext, Buffer.from('eidolon-atlas:backup:v1', 'utf8')),
      };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export async function openBackupEnvelope(passphrase, envelope) {
  requirePassphrase(passphrase, 'backup passphrase');
  if (!envelope || envelope.format !== 'eidolon-atlas-backup' || envelope.version !== 1 ||
      !envelope.kdf || typeof envelope.kdf.salt !== 'string') {
    fail(400, 'INVALID_BACKUP', 'The backup envelope is invalid or unsupported.');
  }
  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  if (salt.length !== 16) fail(400, 'INVALID_BACKUP', 'The backup salt is invalid.');
  const parameters = { ...envelope.kdf };
  delete parameters.salt;
  const key = await deriveKey(passphrase, salt, parameters);
  try {
    let plaintext;
    try {
      plaintext = decryptBytes(key, envelope.cipher, Buffer.from('eidolon-atlas:backup:v1', 'utf8'));
    } catch (error) {
      if (error instanceof AtlasError && error.code === 'DATA_INTEGRITY_ERROR') {
        fail(401, 'INVALID_BACKUP_PASSPHRASE', 'The backup passphrase is incorrect or the backup was modified.');
      }
      throw error;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch {
      fail(400, 'INVALID_BACKUP', 'The decrypted backup is not valid JSON.');
    } finally {
      plaintext?.fill(0);
    }
  } finally {
    key.fill(0);
  }
}
