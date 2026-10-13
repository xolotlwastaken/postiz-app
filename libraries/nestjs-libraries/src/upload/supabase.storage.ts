import { randomUUID } from 'node:crypto';
import type { IUploadProvider } from './upload.interface';
import { isSafePublicHttpsUrl } from '../dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '../dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from './data.url';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/bmp', 'image/tiff', 'video/mp4', 'audio/mpeg', 'audio/mp4',
  'audio/wav', 'audio/ogg',
]);

/** Final publishing media lives in a public bucket; credentials stay server-side. */
export class SupabaseStorage implements IUploadProvider {
  private readonly origin: string;
  private readonly publicPrefix: string;

  constructor(url: string, private readonly key: string, private readonly bucket: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash ||
        !parsed.hostname.endsWith('.supabase.co')) {
      throw new Error('Supabase publishing storage requires a hosted Supabase HTTPS project URL.');
    }
    if (!key || !/^[a-zA-Z0-9_-]+$/.test(bucket)) {
      throw new Error('Set the server-only Supabase storage key and bucket.');
    }
    this.origin = parsed.origin;
    this.publicPrefix = `${this.origin}/storage/v1/object/public/${bucket}/`;
  }

  private async request(path: string, init: RequestInit) {
    // Secret API keys use apikey only; legacy service_role JWTs also use Bearer.
    const headers: Record<string, string> = { apikey: this.key };
    if (!this.key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${this.key}`;
    const response = await fetch(`${this.origin}/storage/v1/${path}`, {
      ...init, headers: { ...headers, ...init.headers }, redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // Do not expose response bodies, credentials or upstream diagnostics.
      throw new Error(`Supabase publishing storage request failed (${response.status}).`);
    }
    return response;
  }

  async uploadFile(file: Express.Multer.File) {
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MIME.has(detected.mime)) throw new Error('Unsupported file type.');
    if (file.buffer.length > 50 * 1024 * 1024) throw new Error('File is too large.');
    const filename = `${randomUUID()}.${detected.ext}`;
    const objectPath = `${new Date().toISOString().slice(0, 10)}/${filename}`;
    await this.request(`object/${this.bucket}/${objectPath}`, {
      method: 'POST',
      headers: { 'Content-Type': detected.mime, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' },
      body: new Uint8Array(file.buffer),
    });
    const path = `${this.publicPrefix}${objectPath}`;
    return { ...file, filename, originalname: filename, mimetype: detected.mime, size: file.buffer.length, path, destination: path };
  }

  async uploadSimple(path: string) {
    const data = path.startsWith('data:') ? parseDataUrl(path) : null;
    let buffer: Buffer;
    if (data) buffer = data.buffer;
    else {
      if (!(await isSafePublicHttpsUrl(path))) throw new Error('Unsafe URL');
      const response = await fetch(path, {
        // @ts-ignore — undici dispatcher guards against DNS rebinding
        dispatcher: ssrfSafeDispatcher,
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error('Failed to fetch media.');
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return (await this.uploadFile({ buffer } as Express.Multer.File)).path;
  }

  async removeFile(filePath: string): Promise<void> {
    if (!filePath.startsWith(this.publicPrefix)) throw new Error('Media is outside the publishing bucket.');
    const objectPath = filePath.slice(this.publicPrefix.length);
    if (!/^\d{4}-\d{2}-\d{2}\/[-a-f0-9]+\.[a-z0-9]+$/.test(objectPath)) throw new Error('Invalid publishing media path.');
    await this.request(`object/${this.bucket}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [objectPath] }),
    });
  }
}
