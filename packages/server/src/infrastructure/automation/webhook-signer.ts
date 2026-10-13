import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
export function webhookSecret(secret: string): Buffer {
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : '';
  const decoded = Buffer.from(encoded, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || decoded.length < 24 || decoded.length > 64
    || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('Invalid webhook secret.');
  return decoded;
}
export function signWebhook(input: { id: string; subscriptionId: string; body: string; secret: string;
  previous?: { secret: string; until: Date }; now?: Date }): Record<string, string> {
  const now = input.now ?? new Date(), timestamp = String(Math.floor(now.getTime()/1000));
  const keys = [input.secret];
  if (input.previous && input.previous.until > now && input.previous.secret !== input.secret) keys.push(input.previous.secret);
  const signatures = keys.map(key => 'v1,'+createHmac('sha256',webhookSecret(key)).update(`${input.id}.${timestamp}.${input.body}`).digest('base64'));
  return { 'content-type': 'application/json', 'webhook-id': input.id, 'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': input.subscriptionId };
}
/**
 * Domain-separated AES-GCM; a ciphertext cannot be moved to another subscription. Encryption always
 * uses the current master key; a previous key (during rotation) only decrypts, until every
 * subscription has refreshed its secret under the current key.
 */
export function createWebhookCipher(masterKey: Buffer,previousMasterKey?: Buffer) {
  const derive = (master: Buffer) => {
    if (master.length !== 32) throw new Error('Webhook master key must contain 32 bytes.');
    return Buffer.from(hkdfSync('sha256',master,'','colp/automation/webhook/v1',32));
  };
  const key = derive(masterKey),keys = previousMasterKey ? [key,derive(previousMasterKey)] : [key];
  const open = (value: string,id: string,candidate: Buffer): string => {
    const [version,nonce,body,tag,...extra] = value.split('.');
    if (version !== 'v1' || !nonce || !body || !tag || extra.length) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm',candidate,Buffer.from(nonce,'base64url'));
    decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(tag,'base64url'));
    const secret = Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8');
    webhookSecret(secret);return secret;
  };
  return {
    encrypt(secret: string,id: string): string {
      webhookSecret(secret);
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
      cipher.setAAD(Buffer.from(id));
      const ciphertext = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
      return ['v1',nonce.toString('base64url'),ciphertext.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
    },
    decrypt(value: string,id: string): string {
      for (const candidate of keys) { try { return open(value,id,candidate); } catch { /* try the previous key */ } }
      throw new Error('Webhook secret is unavailable.');
    },
  };
}
