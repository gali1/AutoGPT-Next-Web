export const GPT_35_TURBO = "llama3-8b-8192" as const;
export const GPT_4 = "llama3-70b-8192" as const;
export const GPT_MODEL_NAMES = [
  "llama3-8b-8192",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
  "gemma-7b-it",
];

export const DEFAULT_MAX_LOOPS_FREE = 4 as const;
export const DEFAULT_MAX_LOOPS_PAID = 16 as const;
export const DEFAULT_MAX_LOOPS_CUSTOM_API_KEY = 50 as const;
export const DEFAULT_MAX_TOKENS = 400 as const;
export const DEFAULT_TEMPERATURE = 0.9 as const;