import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Private object storage for message media. PostgreSQL stores only
 * (storage_provider, storage_key, mime_type, file_size, sha256).
 * No public/permanent URLs are ever produced: clients get short-lived S3
 * presigned URLs, or (local dev) a short-lived HMAC capability URL served by
 * the API's download endpoint (see api/media.controller.ts).
 */
export interface StoredObject { storageProvider: 'LOCAL_DEV' | 'S3'; storageKey: string; size: number; sha256: Buffer }

export interface SignedUrlOptions { expiresInSeconds: number; contentType: string; downloadName: string | null; inline: boolean }

export interface MediaStorageService {
  readonly provider: 'LOCAL_DEV' | 'S3';
  put(storageKey: string, data: Buffer, mimeType: string): Promise<StoredObject>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  /** Direct short-lived URL (S3 presign). null => serve through the API's token-protected download endpoint. */
  signedUrl(storageKey: string, opts: SignedUrlOptions): Promise<string | null>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

function assertSafeKey(key: string): void {
  if (!/^org\/[0-9a-f-]{36}\/[a-z]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key');
}

/** Local filesystem (development only). Keys are validated to prevent path traversal. */
export class LocalMediaStorage implements MediaStorageService {
  readonly provider = 'LOCAL_DEV' as const;
  private readonly root: string;

  constructor(rootDir: string) {
    if (process.env.NODE_ENV === 'production') throw new Error('LocalMediaStorage must not be used in production');
    this.root = resolve(rootDir);
  }

  private path(key: string): string {
    assertSafeKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(storageKey: string, data: Buffer): Promise<StoredObject> {
    const p = this.path(storageKey);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
    return { storageProvider: 'LOCAL_DEV', storageKey, size: data.length, sha256: createHash('sha256').update(data).digest() };
  }

  get(storageKey: string): Promise<Buffer> { return readFile(this.path(storageKey)); }

  async delete(storageKey: string): Promise<void> { await rm(this.path(storageKey), { force: true }); }

  async signedUrl(): Promise<string | null> { return null; }
}

/** Minimal S3-compatible client surface (keeps @aws-sdk/client-s3 an optional runtime dependency). */
export interface S3Like {
  putObject(input: { Bucket: string; Key: string; Body: Buffer; ContentType: string; ServerSideEncryption: 'aws:kms' | 'AES256' }): Promise<unknown>;
  getObject(input: { Bucket: string; Key: string }): Promise<Buffer>;
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>;
  presignGet(input: { Bucket: string; Key: string; ResponseContentType: string; ResponseContentDisposition: string }, expiresInSeconds: number): Promise<string>;
}

/** AWS SDK v3 implementation of the S3Like port. */
export class AwsS3Adapter implements S3Like {
  constructor(private readonly client: S3Client, private readonly kmsKeyId?: string) {}
  async putObject(i: Parameters<S3Like['putObject']>[0]): Promise<unknown> {
    return this.client.send(new PutObjectCommand({ ...i, ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}) }));
  }
  async getObject(i: { Bucket: string; Key: string }): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand(i));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async deleteObject(i: { Bucket: string; Key: string }): Promise<unknown> { return this.client.send(new DeleteObjectCommand(i)); }
  presignGet(i: Parameters<S3Like['presignGet']>[0], expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand(i), { expiresIn: expiresInSeconds });
  }
}

/** RFC 6266 disposition with a sanitised ASCII fallback + UTF-8 name. */
export function contentDisposition(inline: boolean, name: string | null): string {
  const kind = inline ? 'inline' : 'attachment';
  if (!name) return kind;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;\r\n]/g, '_').slice(0, 150) || 'file';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 150))}`;
}

/** Private S3 bucket (production). Block Public Access + SSE-KMS are expected on the bucket. */
export class S3MediaStorage implements MediaStorageService {
  readonly provider = 'S3' as const;
  constructor(private readonly s3: S3Like, private readonly bucket: string) {}

  async put(storageKey: string, data: Buffer, mimeType: string): Promise<StoredObject> {
    assertSafeKey(storageKey);
    await this.s3.putObject({ Bucket: this.bucket, Key: storageKey, Body: data, ContentType: mimeType, ServerSideEncryption: 'aws:kms' });
    return { storageProvider: 'S3', storageKey, size: data.length, sha256: createHash('sha256').update(data).digest() };
  }
  get(storageKey: string): Promise<Buffer> { assertSafeKey(storageKey); return this.s3.getObject({ Bucket: this.bucket, Key: storageKey }); }
  async delete(storageKey: string): Promise<void> { assertSafeKey(storageKey); await this.s3.deleteObject({ Bucket: this.bucket, Key: storageKey }); }
  async signedUrl(storageKey: string, o: SignedUrlOptions): Promise<string> {
    assertSafeKey(storageKey);
    return this.s3.presignGet({ Bucket: this.bucket, Key: storageKey, ResponseContentType: o.contentType,
      ResponseContentDisposition: contentDisposition(o.inline, o.downloadName) }, Math.min(o.expiresInSeconds, 900));
  }
}

export function mediaStorageFromEnv(): MediaStorageService {
  const provider = (process.env.MEDIA_STORAGE_PROVIDER ?? 'LOCAL_DEV').toUpperCase();
  if (provider === 'LOCAL_DEV') return new LocalMediaStorage(process.env.MEDIA_LOCAL_DIR ?? '.data/media');
  if (provider === 'S3') {
    const bucket = process.env.MEDIA_S3_BUCKET;
    if (!bucket) throw new Error('MEDIA_S3_BUCKET is required when MEDIA_STORAGE_PROVIDER=S3');
    return new S3MediaStorage(new AwsS3Adapter(new S3Client({ region: process.env.AWS_REGION }), process.env.MEDIA_S3_KMS_KEY_ID || undefined), bucket);
  }
  throw new Error(`Unsupported MEDIA_STORAGE_PROVIDER ${provider}`);
}
