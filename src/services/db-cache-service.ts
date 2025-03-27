// db-cache-service.ts
import { StringOutputParser } from "@langchain/core/output_parsers";

// Define the structure of the cache entries
interface CacheEntry {
  key: string;
  prompt: string;
  response: string;
  timestamp: number;
}

// Cache expiration time (in milliseconds)
const CACHE_EXPIRY = 3600000; // 1 hour

// Memory fallback cache for environments without IndexedDB
const memoryCache = new Map<string, { response: string, timestamp: number }>();

// Flag to track if we've encountered "this.data is undefined" error
let encounteredDataUndefinedError = false;

class DBCacheService {
  // Skip IDB completely if we've encountered the error
  private useMemoryOnly = false;

  constructor() {
    // Check for previous errors from localStorage
    try {
      const errorFlag = typeof window !== 'undefined' ?
        window.localStorage.getItem('db_error_flag') : null;
      if (errorFlag === 'true') {
        console.log('Previous IndexedDB errors detected, using memory cache only');
        this.useMemoryOnly = true;
        encounteredDataUndefinedError = true;
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  /**
   * Handles the "this.data is undefined" error
   */
  private handleDataUndefinedError(error: any) {
    if (error && error.message && error.message.includes('this.data is undefined')) {
      console.warn('⚠️ Encountered "this.data is undefined" error - switching to memory-only mode');
      this.useMemoryOnly = true;
      encounteredDataUndefinedError = true;

      // Save error state to localStorage to persist across page reloads
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('db_error_flag', 'true');
        }
      } catch (e) {
        // Ignore localStorage errors
      }

      return true;
    }
    return false;
  }

  /**
   * Get an item from cache - handles all errors safely
   */
  async get(key: string): Promise<string | null> {
    // If we've already encountered the error, use memory only
    if (this.useMemoryOnly || encounteredDataUndefinedError) {
      return this.getFromMemory(key);
    }

    try {
      // Try to use IndexedDB if available
      if (typeof window !== 'undefined' && window.indexedDB) {
        try {
          // Wrap in try-catch to handle ANY IndexedDB errors
          const db = await this.safeOpenDatabase();
          if (!db) {
            throw new Error('Failed to open database');
          }

          // Get the entry
          const entry = await this.safeGetEntry(db, key);
          if (!entry) {
            return null;
          }

          // Check if expired
          if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
            try {
              await this.safeDeleteEntry(db, key);
            } catch {
              // Ignore delete errors
            }
            return null;
          }

          return entry.response;
        } catch (error) {
          // Check if it's our specific error
          if (this.handleDataUndefinedError(error)) {
            // If so, try memory cache instead
            return this.getFromMemory(key);
          }

          // For other errors, also fall back to memory
          console.error('Error getting from IndexedDB, using memory:', error);
          return this.getFromMemory(key);
        }
      } else {
        // No IndexedDB available
        return this.getFromMemory(key);
      }
    } catch (error) {
      // Catch-all for any unexpected errors
      console.error('Unexpected error in get:', error);
      this.handleDataUndefinedError(error);
      return this.getFromMemory(key);
    }
  }

  /**
   * Get from memory cache
   */
  private getFromMemory(key: string): string | null {
    this.cleanupMemoryCache();
    const entry = memoryCache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
      memoryCache.delete(key);
      return null;
    }

    console.log(`Memory cache hit for: ${key.substring(0, 30)}...`);
    return entry.response;
  }

  /**
   * Set an item in cache - handles all errors safely
   */
  async set(key: string, prompt: string, response: string): Promise<void> {
    // If we've already encountered the error, use memory only
    if (this.useMemoryOnly || encounteredDataUndefinedError) {
      this.setToMemory(key, response);
      return;
    }

    try {
      // Try to use IndexedDB if available
      if (typeof window !== 'undefined' && window.indexedDB) {
        try {
          // Wrap in try-catch to handle ANY IndexedDB errors
          const db = await this.safeOpenDatabase();
          if (!db) {
            throw new Error('Failed to open database');
          }

          // Add the entry
          await this.safePutEntry(db, {
            key,
            prompt,
            response,
            timestamp: Date.now()
          });

          console.log(`Cached in IndexedDB: ${key.substring(0, 30)}...`);
        } catch (error) {
          // Check if it's our specific error
          if (this.handleDataUndefinedError(error)) {
            // If so, try memory cache instead
            this.setToMemory(key, response);
            return;
          }

          // For other errors, also fall back to memory
          console.error('Error setting in IndexedDB, using memory:', error);
          this.setToMemory(key, response);
        }
      } else {
        // No IndexedDB available
        this.setToMemory(key, response);
      }
    } catch (error) {
      // Catch-all for any unexpected errors
      console.error('Unexpected error in set:', error);
      this.handleDataUndefinedError(error);
      this.setToMemory(key, response);
    }
  }

  /**
   * Set to memory cache
   */
  private setToMemory(key: string, response: string): void {
    memoryCache.set(key, {
      response,
      timestamp: Date.now()
    });
    console.log(`Cached in memory: ${key.substring(0, 30)}...`);
  }

  /**
   * Clean up memory cache
   */
  private cleanupMemoryCache(): void {
    const now = Date.now();
    for (const [key, value] of memoryCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY) {
        memoryCache.delete(key);
      }
    }
  }

  /**
   * Safely open the database with error handling
   */
  private async safeOpenDatabase(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }

      try {
        const request = window.indexedDB.open('response-cache', 1);

        request.onupgradeneeded = (event) => {
          try {
            const db = (event.target as IDBOpenDBRequest).result;
            const store = db.createObjectStore('responses', { keyPath: 'key' });
            store.createIndex('by-timestamp', 'timestamp');
          } catch (error) {
            console.error('Error in onupgradeneeded:', error);
            resolve(null);
          }
        };

        request.onsuccess = (event) => {
          try {
            const db = (event.target as IDBOpenDBRequest).result;
            resolve(db);
          } catch (error) {
            console.error('Error in onsuccess:', error);
            resolve(null);
          }
        };

        request.onerror = (event) => {
          console.error('Error opening DB:', event);
          resolve(null);
        };

        // Add timeout to prevent hanging
        setTimeout(() => {
          resolve(null);
        }, 3000);
      } catch (error) {
        console.error('Error in safeOpenDatabase:', error);
        resolve(null);
      }
    });
  }

  /**
   * Safely get an entry from the database
   */
  private async safeGetEntry(db: IDBDatabase, key: string): Promise<CacheEntry | null> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(['responses'], 'readonly');
        const store = transaction.objectStore('responses');
        const request = store.get(key);

        request.onsuccess = (event) => {
          try {
            const result = (event.target as IDBRequest).result;
            resolve(result || null);
          } catch (error) {
            console.error('Error in get onsuccess:', error);
            resolve(null);
          }
        };

        request.onerror = (event) => {
          console.error('Error getting entry:', event);
          resolve(null);
        };

        // Add timeout to prevent hanging
        setTimeout(() => {
          resolve(null);
        }, 3000);
      } catch (error) {
        console.error('Error in safeGetEntry:', error);
        resolve(null);
      }
    });
  }

  /**
   * Safely put an entry in the database
   */
  private async safePutEntry(db: IDBDatabase, entry: CacheEntry): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(['responses'], 'readwrite');
        const store = transaction.objectStore('responses');
        const request = store.put(entry);

        request.onsuccess = () => {
          resolve(true);
        };

        request.onerror = (event) => {
          console.error('Error putting entry:', event);
          resolve(false);
        };

        // Add timeout to prevent hanging
        setTimeout(() => {
          resolve(false);
        }, 3000);
      } catch (error) {
        console.error('Error in safePutEntry:', error);
        resolve(false);
      }
    });
  }

  /**
   * Safely delete an entry from the database
   */
  private async safeDeleteEntry(db: IDBDatabase, key: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(['responses'], 'readwrite');
        const store = transaction.objectStore('responses');
        const request = store.delete(key);

        request.onsuccess = () => {
          resolve(true);
        };

        request.onerror = (event) => {
          console.error('Error deleting entry:', event);
          resolve(false);
        };

        // Add timeout to prevent hanging
        setTimeout(() => {
          resolve(false);
        }, 3000);
      } catch (error) {
        console.error('Error in safeDeleteEntry:', error);
        resolve(false);
      }
    });
  }

  /**
   * Create a hash key for the input parameters
   */
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

  /**
   * Reset error status (for testing)
   */
  resetErrorStatus(): void {
    this.useMemoryOnly = false;
    encounteredDataUndefinedError = false;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('db_error_flag');
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  /**
   * Force memory-only mode
   */
  forceMemoryOnlyMode(): void {
    this.useMemoryOnly = true;
    encounteredDataUndefinedError = true;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('db_error_flag', 'true');
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }
}

// Export a singleton instance
export const dbCacheService = new DBCacheService();