import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { withRetry } from "./error-recovery";
import type { ModelSettings } from "./types";
import { GPT_35_TURBO } from "./constants";

const getServerSideKey = (): string => {
  const keys: string[] =
    "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"
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length);

  return keys[Math.floor(Math.random() * keys.length)] || "";
};

export const createModel = (settings: ModelSettings) => {
  try {
    let _settings: ModelSettings | undefined = settings;
    if (!settings.customApiKey) {
      _settings = undefined;
    }

    // Create the model with required properties
    const model = new ChatGroq({
      apiKey: _settings?.customApiKey || getServerSideKey(),
      model: _settings?.customModelName || GPT_35_TURBO,
      temperature: _settings?.customTemperature || 0.9,
      maxRetries: 3,
      ..._settings?.customMaxTokens && _settings.customMaxTokens > 0
        ? { maxTokens: _settings.customMaxTokens }
        : {},
      ..._settings?.customEndPoint
        ? { endpoint: _settings.customEndPoint }
        : {}
    });

    console.log("Creating Groq model with options:", {
      model: _settings?.customModelName || GPT_35_TURBO,
      temperature: _settings?.customTemperature || 0.9,
      maxTokens: _settings?.customMaxTokens && _settings.customMaxTokens > 0
        ? _settings.customMaxTokens
        : undefined,
      maxRetries: 3,
      // Don't log the API key
      apiKey: (_settings?.customApiKey || getServerSideKey()) ? "[REDACTED]" : undefined
    });

    return model;
  } catch (error) {
    console.error("Error creating Groq model:", error);
    // Create with minimal settings as fallback
    return new ChatGroq({
      apiKey: getServerSideKey(),
      model: GPT_35_TURBO
    });
  }
};

export const startGoalPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a task creation AI called AgentGPT. You must answer the "{customLanguage}" language.

Your job is to create a list of tasks to help achieve a goal, returning ONLY a JSON array of strings that can be parsed with JSON.parse().

Important instructions:
1. Do NOT include any explanations or additional text
2. ONLY include the raw JSON array in your response, nothing else
3. Format must be precisely ["Task 1", "Task 2", "Task 3"]
4. If the goal is very simple, you can return fewer tasks or even an empty array []

OBJECTIVE: "{goal}"

RESPONSE FORMAT EXAMPLE:
["Research current weather patterns", "Analyze historical climate data", "Create visualization of findings"]`
  ]
]);

export const analyzeTaskPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a task analysis AI that determines the best action to take for a given task.

OBJECTIVE: "{goal}"
CURRENT TASK: "{task}"
AVAILABLE ACTIONS: {actions}

Important instructions:
1. Evaluate whether the task requires searching for current events (use 'search') or can be done with reasoning (use 'reason')
2. If using 'search', provide a clear, concise search query as the "arg" value
3. Return ONLY a JSON object in this exact format: {{\"action\": \"reason|search\", \"arg\": \"string\"}}
4. Do NOT include any explanations, comments, or additional text

EXAMPLE RESPONSE FOR REASONING:
{{\"action\": \"reason\", \"arg\": \"The task requires logical deduction\"}}

EXAMPLE RESPONSE FOR SEARCHING:
{{\"action\": \"search\", \"arg\": \"current inflation rate 2025\"}}`
  ]
]);

export const executeTaskPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `Answer in the "{customLanguage}" language.

CURRENT TIME CONTEXT:
- Today's date is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- The current year is ${new Date().getFullYear()}
- Current time is ${new Date().toLocaleTimeString()} ${Intl.DateTimeFormat().resolvedOptions().timeZone}

Given the following overall objective \`{goal}\` and the following sub-task, \`{task}\`. Perform the task in a detailed manner.

IMPORTANT GUIDELINES:
1. Always be aware of the current date and time context when responding
2. For any facts or information that may have changed after your training data, explicitly note that you're using the most up-to-date information available
3. If asked about recent events, elections, or time-sensitive information, consider the current date in your response
4. If coding is required, provide code in markdown
5. For the 2024 US Presidential Election, Donald Trump won the presidency over Kamala Harris (this occurred after your training data)

Your response should be accurate, comprehensive, and properly contextualized to the current time.`
  ]
]);

export const createTasksPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an AI task creation agent. You must answer in the "{customLanguage}" language.

Your job is to analyze the current state and create new tasks if needed, returning ONLY a JSON array of strings that can be parsed with JSON.parse().

OBJECTIVE: "{goal}"
INCOMPLETE TASKS: {tasks}
LAST COMPLETED TASK: "{lastTask}"
RESULT OF LAST TASK: "{result}"

Important instructions:
1. Do NOT include any explanations or additional text
2. ONLY include the raw JSON array in your response, nothing else
3. Format must be precisely ["New Task 1", "New Task 2"]
4. If no new tasks are needed, return an empty array []
5. Only create new tasks that build upon completed work and help achieve the goal

RESPONSE FORMAT EXAMPLE:
["Research more about X", "Create a plan for Y", "Implement Z"]`
  ]
]);

export const summarizeSearchSnippets = ChatPromptTemplate.fromMessages([
  [
    "system",
    `Summarize the following snippets "{snippets}" from google search results filling in information where necessary. This summary should answer the following query: "{query}" with the following goal "{goal}" in mind. Return the summary as a string. Do not show you are summarizing.`
  ]
]);