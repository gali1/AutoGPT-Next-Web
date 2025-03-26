/**
 * Utility for handling common error patterns and recovery
 */

// Handle the "inTable" error specifically
export function isInTableError(error: unknown): boolean {
  if (!error) return false;

  // Handle error as any to check message property
  const err = error as any;
  return (
    err.message &&
    typeof err.message === 'string' &&
    (err.message.includes("inTable") ||
     err.message.includes("this.data is undefined"))
  );
}

// Parse JSON with fallback for common formatting issues
export function safeParseJSON<T>(text: string, defaultValue: T): T {
  if (!text || typeof text !== 'string') {
    return defaultValue;
  }

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    // Try to recover from common JSON formatting issues
    try {
      // Some models add markdown code blocks
      if (text.includes('```json')) {
        // Safely handle splitting the string
        const segments = text.split('```json');
        if (segments && segments.length > 1 && segments[1]) {
          const codeContent = segments[1].split('```');
          if (codeContent && codeContent.length > 0 && codeContent[0]) {
            const jsonContent = codeContent[0].trim();
            if (jsonContent) {
              return JSON.parse(jsonContent) as T;
            }
          }
        }
      }

      // Some models add explanation text before or after JSON
      // Using a simpler regex that should work in older ES versions
      const arrayMatch = text.match(/\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/);
      const objectMatch = text.match(/\{[^\{\}]*(?:\{[^\{\}]*\}[^\{\}]*)*\}/);

      // Try array match first
      if (arrayMatch && arrayMatch[0]) {
        return JSON.parse(arrayMatch[0]) as T;
      }

      // Then try object match
      if (objectMatch && objectMatch[0]) {
        return JSON.parse(objectMatch[0]) as T;
      }

      // If all else fails, return the default value
      console.error("Failed to parse JSON:", e);
      return defaultValue;
    } catch (innerError) {
      console.error("All JSON parsing recovery attempts failed:", innerError);
      return defaultValue;
    }
  }
}

// Retry a function with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000
): Promise<T> {
  let retries = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;

      if (retries > maxRetries) {
        console.error(`Failed after ${maxRetries} retries:`, error);
        throw error;
      }

      // Calculate exponential backoff
      const delay = initialDelay * Math.pow(2, retries - 1);
      console.log(`Retry ${retries}/${maxRetries} in ${delay}ms`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}