import { Redis } from 'ioredis';

// Create a mock Redis implementation for testing environments
class MockRedis {
  private data: Map<string, { value: any; expiresAt?: number }> = new Map();

  async get(key: string) {
    const item = this.data.get(key);
    if (item?.expiresAt && item.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return item?.value;
  }

  async set(key: string, value: any, ...args: any[]) {
    if (args.includes('NX') && (await this.get(key)) !== undefined) return null;
    const expiryIndex = args.findIndex((arg) => arg === 'EX');
    const ttl = expiryIndex === -1 ? undefined : Number(args[expiryIndex + 1]);
    this.data.set(key, {
      value,
      ...(Number.isFinite(ttl) ? { expiresAt: Date.now() + ttl * 1000 } : {}),
    });
    return 'OK';
  }

  async del(key: string) {
    this.data.delete(key);
    return 1;
  }

  // Add other Redis methods as needed for your tests
}

// Use real Redis if REDIS_URL is defined, otherwise use MockRedis
export const ioRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
      family: 0,
    })
  : (new MockRedis() as unknown as Redis); // Type cast to Redis to maintain interface compatibility
