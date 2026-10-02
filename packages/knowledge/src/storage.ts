import { existsSync } from 'node:fs';
import path from 'node:path';

export interface StoredObject {
  storageKey: string;
  bytes: Buffer;
}

export interface KnowledgeObjectStore {
  put(input: { organisationId: string; documentId: string; versionId: string; bytes: Buffer }): Promise<string>;
  get(organisationId: string, storageKey: string): Promise<Buffer>;
  delete(organisationId: string, storageKey: string): Promise<void>;
}

export function defaultKnowledgeStorageDir(start = process.cwd()): string {
  const configured = process.env.KNOWLEDGE_STORAGE_DIR;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  let directory = start;
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      return path.join(directory, '.local', 'knowledge');
    }
    directory = path.dirname(directory);
  }
  return path.resolve(start, '.local', 'knowledge');
}

export function objectKey(organisationId: string, documentId: string, versionId: string): string {
  return `knowledge/${organisationId}/${documentId}/${versionId}/original`;
}

export function assertObjectTenant(organisationId: string, storageKey: string): void {
  const expected = `knowledge/${organisationId}/`;
  if (!storageKey.startsWith(expected) || storageKey.includes('..')) {
    throw Object.assign(new Error('knowledge_object_forbidden'), { code: 'knowledge_object_forbidden' });
  }
}

export class FileKnowledgeObjectStore implements KnowledgeObjectStore {
  constructor(private readonly rootDirectory: string) {}

  async put(input: { organisationId: string; documentId: string; versionId: string; bytes: Buffer }): Promise<string> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const storageKey = objectKey(input.organisationId, input.documentId, input.versionId);
    assertObjectTenant(input.organisationId, storageKey);
    const path = join(this.rootDirectory, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    return storageKey;
  }

  async get(organisationId: string, storageKey: string): Promise<Buffer> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    assertObjectTenant(organisationId, storageKey);
    try {
      return await readFile(join(this.rootDirectory, storageKey));
    } catch {
      throw Object.assign(new Error('knowledge_object_missing'), { code: 'knowledge_object_missing', retryable: true });
    }
  }

  async delete(organisationId: string, storageKey: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    assertObjectTenant(organisationId, storageKey);
    await rm(join(this.rootDirectory, storageKey), { force: true });
  }
}

export class MemoryKnowledgeObjectStore implements KnowledgeObjectStore {
  private readonly objects = new Map<string, Buffer>();

  async put(input: { organisationId: string; documentId: string; versionId: string; bytes: Buffer }): Promise<string> {
    const storageKey = objectKey(input.organisationId, input.documentId, input.versionId);
    this.objects.set(storageKey, Buffer.from(input.bytes));
    return storageKey;
  }

  async get(organisationId: string, storageKey: string): Promise<Buffer> {
    assertObjectTenant(organisationId, storageKey);
    const bytes = this.objects.get(storageKey);
    if (!bytes) {
      throw Object.assign(new Error('knowledge_object_missing'), { code: 'knowledge_object_missing', retryable: true });
    }
    return bytes;
  }

  async delete(organisationId: string, storageKey: string): Promise<void> {
    assertObjectTenant(organisationId, storageKey);
    this.objects.delete(storageKey);
  }
}

export class LocalKnowledgeObjectStore extends FileKnowledgeObjectStore {}

export interface ObjectBodyClient {
  put(storageKey: string, bytes: Buffer): Promise<void>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}

export class PrivateObjectStorageKnowledgeObjectStore implements KnowledgeObjectStore {
  constructor(private readonly body: ObjectBodyClient) {}

  async put(input: { organisationId: string; documentId: string; versionId: string; bytes: Buffer }): Promise<string> {
    const storageKey = objectKey(input.organisationId, input.documentId, input.versionId);
    assertObjectTenant(input.organisationId, storageKey);
    await this.body.put(storageKey, input.bytes);
    return storageKey;
  }

  async get(organisationId: string, storageKey: string): Promise<Buffer> {
    assertObjectTenant(organisationId, storageKey);
    return this.body.get(storageKey);
  }

  async delete(organisationId: string, storageKey: string): Promise<void> {
    assertObjectTenant(organisationId, storageKey);
    await this.body.delete(storageKey);
  }
}

export async function createS3BodyClient(env: NodeJS.ProcessEnv = process.env): Promise<ObjectBodyClient> {
  const bucket = env.KNOWLEDGE_S3_BUCKET ?? '';
  if (!bucket) {
    throw new Error('Invalid environment configuration: KNOWLEDGE_S3_BUCKET');
  }
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: env.KNOWLEDGE_S3_REGION || 'us-east-1',
    endpoint: env.KNOWLEDGE_S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(env.KNOWLEDGE_S3_ENDPOINT),
    credentials: {
      accessKeyId: env.KNOWLEDGE_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.KNOWLEDGE_S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  return {
    async put(storageKey, bytes) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: bytes }));
    },
    async get(storageKey) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) {
        throw Object.assign(new Error('knowledge_object_missing'), { code: 'knowledge_object_missing', retryable: true });
      }
      return Buffer.from(bytes);
    },
    async delete(storageKey) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    },
  };
}

export async function createKnowledgeObjectStore(env: NodeJS.ProcessEnv = process.env): Promise<KnowledgeObjectStore> {
  const mode = env.KNOWLEDGE_STORAGE === 's3' ? 's3' : 'local';
  if (env.VHALCHA_ENV === 'production' && mode !== 's3') {
    throw new Error('Invalid environment configuration: KNOWLEDGE_STORAGE');
  }
  if (mode === 's3') {
    return new PrivateObjectStorageKnowledgeObjectStore(await createS3BodyClient(env));
  }
  return new LocalKnowledgeObjectStore(defaultKnowledgeStorageDir());
}
