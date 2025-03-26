type Constructor<T> = new (...args: unknown[]) => T;
import { safeParseJSON } from './error-recovery';

/* Check whether array is of the specified type */
export const isArrayOfType = <T>(
  arr: unknown[] | unknown,
  type: Constructor<T> | string
): arr is T[] => {
  return (
    Array.isArray(arr) &&
    arr.every((item): item is T => {
      if (typeof type === "string") {
        return typeof item === type;
      } else {
        return item instanceof type;
      }
    })
  );
};

// Keep the rest of your existing helper functions below
export const removeTaskPrefix = (input: string): string => {
  // Regular expression to match task prefixes. Consult tests to understand regex
  const prefixPattern =
    /^(Task\s*\d*\.\s*|Task\s*\d*[-:]?\s*|-?\d+\s*[-:]?\s*)/i;

  // Replace the matched prefix with an empty string
  return input.replace(prefixPattern, "");
};

export const extractTasks = (
  text: string,
  completedTasks: string[]
): string[] => {
  // Clean the input text first
  const cleanedText = text.trim();

  console.log("Attempting to extract tasks from:", cleanedText);

  try {
    // First try direct JSON parsing if it looks like JSON
    if (cleanedText.startsWith('[') && cleanedText.endsWith(']')) {
      try {
        const parsed = safeParseJSON<string[]>(cleanedText, []);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(item => typeof item === 'string')
            .filter(realTasksFilter)
            .filter((task) => !(completedTasks || []).includes(task))
            .map(removeTaskPrefix);
        }
      } catch (e) {
        console.log("Direct JSON parse failed:", e);
      }
    }

    // Then try the regex extraction approach
    const extractedArray = extractArray(cleanedText);
    return extractedArray
      .filter(realTasksFilter)
      .filter((task) => !(completedTasks || []).includes(task))
      .map(removeTaskPrefix);

  } catch (e) {
    console.error("Task extraction failed:", e);

    // Fallback: Try to extract any lines that look like tasks
    const lines = cleanedText.split('\n');
    const potentialTasks = lines
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .filter(line => !line.startsWith('[') && !line.endsWith(']'))
      .filter(line => !line.includes('objective') && !line.toLowerCase().includes('goal'))
      .filter(realTasksFilter)
      .filter((task) => !(completedTasks || []).includes(task))
      .map(removeTaskPrefix);

    if (potentialTasks.length > 0) {
      console.log("Using fallback task extraction, found:", potentialTasks);
      return potentialTasks;
    }

    // If we really can't find any tasks, return an empty array
    return [];
  }
};

export const extractArray = (inputStr: string): string[] => {
  // Match an outer array of strings (including nested arrays)
  const regex =
    /(\[(?:\s*(?:"(?:[^"\\]|\\.|\n)*"|'(?:[^'\\]|\\.|\n)*')\s*,?)+\s*\])/;
  const match = inputStr.match(regex);

  if (match && match[0]) {
    try {
      // Parse the matched string to get the array
      return safeParseJSON<string[]>(match[0], []);
    } catch (error) {
      console.error("Error parsing the matched array:", error);
    }
  }

  console.warn("Error, could not extract array from inputString:", inputStr);
  return [];
};

// Model will return tasks such as "No tasks added". We should filter these
export const realTasksFilter = (input: string): boolean => {
  const noTaskRegex =
    /^No( (new|further|additional|extra|other))? tasks? (is )?(required|needed|added|created|inputted).*$/i;
  const taskCompleteRegex =
    /^Task (complete|completed|finished|done|over|success).*/i;
  const doNothingRegex = /^(\s*|Do nothing(\s.*)?)$/i;

  return (
    !noTaskRegex.test(input) &&
    !taskCompleteRegex.test(input) &&
    !doNothingRegex.test(input)
  );
};
