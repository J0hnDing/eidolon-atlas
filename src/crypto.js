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
export const BACKUP_V2_MAGIC = Buffer.from('EIDOLON-ATLAS-BACKUP-V2\0', 'ascii');
export const BACKUP_V2_MAX_HEADER_BYTES = 64 * 1024;
export const BACKUP_V2_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const BACKUP_V2_TAG_BYTES = 16;

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

export function encryptBinary(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function decryptBinary(key, stored, aad) {
  try {
    const bytes = Buffer.isBuffer(stored)
      ? stored
      : (stored instanceof Uint8Array ? Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength) : null);
    if (!bytes || bytes.length < 28) throw new Error('format');
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(bytes.length - 16);
    const ciphertext = bytes.subarray(12, bytes.length - 16);
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

function uint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function strictBase64(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    fail(400, 'INVALID_BACKUP', `${label} is invalid.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) {
    fail(400, 'INVALID_BACKUP', `${label} is invalid.`);
  }
  return bytes;
}

export async function createBackupV2Stream(passphrase, plaintextLength, plaintextSource) {
  requirePassphrase(passphrase, 'backup passphrase');
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) {
    fail(500, 'INVALID_BACKUP_STATE', 'The backup plaintext length is invalid.');
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const kdf = { ...DEFAULT_KDF };
  const header = Buffer.from(JSON.stringify({
    format: 'eidolon-atlas-backup',
    version: 2,
    kdf: { ...kdf, salt: salt.toString('base64') },
    cipher: { algorithm: 'aes-256-gcm', nonce: nonce.toString('base64') },
  }), 'utf8');
  if (header.length > BACKUP_V2_MAX_HEADER_BYTES) fail(500, 'INVALID_BACKUP_STATE', 'The backup header is too large.');
  const prefix = Buffer.concat([BACKUP_V2_MAGIC, uint32(header.length), header]);
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: BACKUP_V2_TAG_BYTES });
  cipher.setAAD(prefix);
  async function* encrypted() {
    let seen = 0;
    try {
      yield prefix;
      for await (const value of plaintextSource) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        seen += chunk.length;
        if (seen > plaintextLength) fail(500, 'INVALID_BACKUP_STATE', 'The backup source exceeded its declared length.');
        const ciphertext = cipher.update(chunk);
        if (ciphertext.length) yield ciphertext;
      }
      if (seen !== plaintextLength) fail(500, 'INVALID_BACKUP_STATE', 'The backup source did not match its declared length.');
      const final = cipher.final();
      if (final.length) yield final;
      yield cipher.getAuthTag();
    } finally {
      key.fill(0);
    }
  }
  return { stream: encrypted(), byteLength: prefix.length + plaintextLength + BACKUP_V2_TAG_BYTES };
}

export function parseBackupV2Prefix(prefix) {
  const minimum = BACKUP_V2_MAGIC.length + 4;
  if (!Buffer.isBuffer(prefix) || prefix.length < minimum ||
      !prefix.subarray(0, BACKUP_V2_MAGIC.length).equals(BACKUP_V2_MAGIC)) {
    fail(400, 'INVALID_BACKUP', 'The backup is not a supported v2 container.');
  }
  const headerLength = prefix.readUInt32BE(BACKUP_V2_MAGIC.length);
  if (headerLength < 2 || headerLength > BACKUP_V2_MAX_HEADER_BYTES || prefix.length !== minimum + headerLength) {
    fail(400, 'INVALID_BACKUP', 'The backup header length is invalid.');
  }
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(minimum)));
  } catch {
    fail(400, 'INVALID_BACKUP', 'The backup header is invalid.');
  }
  if (!header || header.format !== 'eidolon-atlas-backup' || header.version !== 2 ||
      !header.kdf || !header.cipher || header.cipher.algorithm !== 'aes-256-gcm') {
    fail(400, 'INVALID_BACKUP', 'The backup header is invalid or unsupported.');
  }
  const salt = strictBase64(header.kdf.salt, 16, 'The backup salt');
  const nonce = strictBase64(header.cipher.nonce, 12, 'The backup nonce');
  const parameters = { ...header.kdf };
  delete parameters.salt;
  if (parameters.version !== DEFAULT_KDF.version || parameters.name !== DEFAULT_KDF.name ||
      parameters.N !== DEFAULT_KDF.N || parameters.r !== DEFAULT_KDF.r ||
      parameters.p !== DEFAULT_KDF.p || parameters.keyLength !== DEFAULT_KDF.keyLength) {
    fail(400, 'INVALID_BACKUP', 'The backup key derivation parameters are unsupported.');
  }
  return { header, headerLength, salt, nonce, parameters };
}

export async function createBackupV2Decipher(passphrase, prefix) {
  requirePassphrase(passphrase, 'backup passphrase');
  const parsed = parseBackupV2Prefix(prefix);
  const key = await deriveKey(passphrase, parsed.salt, parsed.parameters);
  const decipher = createDecipheriv('aes-256-gcm', key, parsed.nonce, { authTagLength: BACKUP_V2_TAG_BYTES });
  decipher.setAAD(prefix);
  return { decipher, key, tagBytes: BACKUP_V2_TAG_BYTES };
}
