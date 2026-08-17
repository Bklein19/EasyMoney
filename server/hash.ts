import crypto from 'node:crypto';

export function hashContent(content: string | Uint8Array) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
