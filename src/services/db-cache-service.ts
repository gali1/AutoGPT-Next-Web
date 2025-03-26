import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

// Define the structure of the cache entries
interface CacheEntry {
  key: string;
  prompt: string;
  response: string;
  timestamp: number;
}

// Define the database schema
interface GroqCacheDB extends DBSchema {
  responses: {
    key: string;
    value: CacheEntry;
    indexes: { 'by-timestamp': number };
  };
}

// Cache expiration time (in milliseconds)
const CACHE_EXPIRY = 3600000; // 1 hour

// Memory fallback cache for environments without IndexedDB
const memoryCache = new Map<string, { response: string, timestamp: number }>();

// Check if we're in a browser environment
const isBrowser = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

class DBCacheService {
  private db: Promise<IDBPDatabase<GroqCacheDB>> | null = null;

  constructor() {
    if (isBrowser) {
      try {
        this.db = this.initDB();
      } catch (error) {
        console.error('Failed to initialize IndexedDB, falling back to memory cache:', error);
        this.db = null;
      }
    } else {
      console.log('Running in a non-browser environment, using memory cache instead of IndexedDB');
      this.db = null;
    }
  }

  private async initDB(): Promise<IDBPDatabase<GroqCacheDB>> {
    try {
      console.log('Initializing response cache database...');

      const db = await openDB<GroqCacheDB>('groq-response-cache', 1, {
        upgrade(db) {
          const store = db.createObjectStore('responses', { keyPath: 'key' });
          store.createIndex('by-timestamp', 'timestamp');
          console.log('Response cache database created successfully');
        },
      });

      // Clean up old cache entries on startup
      void this.cleanupCache(db);

      return db;
    } catch (error) {
      console.error('Failed to initialize response cache database:', error);
      throw error;
    }
  }

  private async cleanupCache(db: IDBPDatabase<GroqCacheDB>): Promise<void> {
    try {
      const now = Date.now();
      const tx = db.transaction('responses', 'readwrite');
      const index = tx.store.index('by-timestamp');

      let cursor = await index.openCursor();

      while (cursor) {
        const entry = cursor.value;

        if (now - entry.timestamp > CACHE_EXPIRY) {
          await cursor.delete();
          console.log(`Deleted expired cache entry: ${entry.key}`);
        }

        cursor = await cursor.continue();
      }

      await tx.done;
    } catch (error) {
      console.error('Error cleaning up cache:', error);
    }
  }

  // Clean up memory cache
  private cleanupMemoryCache(): void {
    const now = Date.now();
    for (const [key, value] of memoryCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY) {
        memoryCache.delete(key);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      // If we have a DB, use it
      if (this.db) {
        const db = await this.db;
        const entry = await db.get('responses', key);

        if (!entry) {
          return null;
        }

        // Check if the cache entry has expired
        if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
          await db.delete('responses', key);
          return null;
        }

        console.log(`IndexedDB cache hit for: ${key.substring(0, 50)}...`);
        return entry.response;
      }
      // Otherwise use memory cache
      else {
        this.cleanupMemoryCache();
        const entry = memoryCache.get(key);

        if (!entry) {
          return null;
        }

        // Check if the cache entry has expired
        if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
          memoryCache.delete(key);
          return null;
        }

        console.log(`Memory cache hit for: ${key.substring(0, 50)}...`);
        return entry.response;
      }
    } catch (error) {
      console.error('Error retrieving from cache:', error);
      return null;
    }
  }

  async set(key: string, prompt: string, response: string): Promise<void> {
    try {
      // If we have a DB, use it
      if (this.db) {
        const db = await this.db;
        const timestamp = Date.now();

        await db.put('responses', {
          key,
          prompt,
          response,
          timestamp,
        });

        console.log(`Cached response in IndexedDB for: ${key.substring(0, 50)}...`);
      }
      // Otherwise use memory cache
      else {
        memoryCache.set(key, {
          response,
          timestamp: Date.now(),
        });

        console.log(`Cached response in memory for: ${key.substring(0, 50)}...`);
      }
    } catch (error) {
      console.error('Error writing to cache:', error);
    }
  }

  // Create a hash key for the input parameters
  createCacheKey(input: Record<string, any>): string {
    try {
      // Create a stable representation of the input for caching
      const stableInput = JSON.stringify(input, Object.keys(input).sort());

      // Create a simple hash of the input (for efficiency)
      let hash = 0;
      for (let i = 0; i < stableInput.length; i++) {
        const char = stableInput.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }

      return `${hash.toString(16)}_${stableInput.substring(0, 100)}`;
    } catch (error) {
      console.error('Error creating cache key:', error);
      // Fallback to a timestamp-based key if JSON.stringify fails
      return `fallback_${Date.now()}_${Object.keys(input).join('-')}`;
    }
  }
}

// Export a singleton instance
export const dbCacheService = new DBCacheService();