import {
  createModel,
  startGoalPrompt,
  executeTaskPrompt,
  createTasksPrompt,
  analyzeTaskPrompt,
} from "../utils/prompts";
import type { ModelSettings } from "../utils/types";
import { env } from "../env/client.mjs";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { extractTasks } from "../utils/helpers";
import { Serper } from "./custom-tools/serper";
import { AIMessage } from "@langchain/core/messages";
import { dbCacheService } from "./db-cache-service";
import { withRetry } from "../utils/error-recovery";

// Type for chain input to improve type safety
type ChainInput = Record<string, any>;

// Helper function to extract string content from model response
function extractTextContent(response: any): string {
  // If it's already a string, return it directly
  if (typeof response === "string") return response;

  // If it's an AIMessage
  if (response instanceof AIMessage) {
    const content = response.content;

    // If content is a string, return it directly
    if (typeof content === "string") return content;

    // If content is an array, extract text parts
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          // Handle string items
          if (typeof item === "string") return item;

          // Handle objects with text property
          if (
            item &&
            typeof item === "object" &&
            "text" in item &&
            typeof item.text === "string"
          ) {
            return item.text;
          }

          return "";
        })
        .filter(Boolean)
        .join("");
    }

    // If we can't extract from content, try to stringify the whole thing
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }

  // Try to handle general objects
  if (response && typeof response === "object") {
    if ("text" in response && typeof response.text === "string") {
      return response.text;
    }

    if ("content" in response) {
      return extractTextContent(response.content);
    }

    // Last resort, try to stringify
    try {
      return JSON.stringify(response);
    } catch {
      return "";
    }
  }

  // If nothing works, return empty string
  return "";
}

// Safely invoke a chain with caching and error handling
async function safeInvoke(chain: any, input: ChainInput, defaultValue = ""): Promise<string> {
  try {
    // Create a cache key for this request
    const cacheKey = dbCacheService.createCacheKey(input);

    // Check if we have a cached response
    const cachedResponse = await dbCacheService.get(cacheKey);
    if (cachedResponse) {
      console.log("Using cached response");
      return cachedResponse;
    }

    // No cache hit, invoke the chain
    console.log("Cache miss, invoking chain");

    // Use withRetry for better resilience
    let result;
    try {
      result = await withRetry(() => chain.invoke(input), 3, 1000);
    } catch (invokeError) {
      console.error("Error in chain invocation, trying alternative approach:", invokeError);

      // Alternative approach if the chain invocation fails
      try {
        const model = createModel(input.modelSettings || input);
        const formattedPrompt = typeof input === 'string'
          ? input
          : JSON.stringify(input, null, 2);

        const messages = [
          { role: "system", content: "Please respond to the following:" },
          { role: "user", content: formattedPrompt }
        ];

        result = await model.invoke(messages);
      } catch (modelError) {
        console.error("Alternative approach also failed:", modelError);
        return defaultValue;
      }
    }

    // Extract text content from the result
    const extractedResult = typeof result === 'string' ? result : extractTextContent(result);

    // Cache the result for future use
    await dbCacheService.set(cacheKey, JSON.stringify(input), extractedResult);

    return extractedResult;
  } catch (error: any) {
    console.error("Error in safeInvoke:", error);
    return defaultValue;
  }
}

async function startGoalAgent(
  modelSettings: ModelSettings,
  goal: string,
  customLanguage: string,
): Promise<string[]> {
  try {
    console.log("Starting goal agent with parameters:", {
      goal,
      customLanguage,
    });

    const model = createModel(modelSettings);
    const outputParser = new StringOutputParser();

    const chain = RunnableSequence.from([startGoalPrompt, model, outputParser]);

    console.log("Invoking chain for goal agent");

    // Use the safe invoke method
    const completion = await safeInvoke(
      chain,
      {
        goal,
        customLanguage,
      },
      "[]",
    );

    console.log("Goal agent completion:", completion);
    return extractTasks(completion, []);
  } catch (error: unknown) {
    // Type-safe error handling
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in startGoalAgent:", errorMessage);
    // Return a simple task to allow the agent to continue
    return ["Analyze the goal and break it down into steps"];
  }
}

async function analyzeTaskAgent(
  modelSettings: ModelSettings,
  goal: string,
  task: string,
): Promise<Analysis> {
  try {
    console.log("Analyzing task with parameters:", { goal, task });

    const actions = ["reason", "search"];
    const model = createModel(modelSettings);
    const outputParser = new StringOutputParser();

    const chain = RunnableSequence.from([
      analyzeTaskPrompt,
      model,
      outputParser,
    ]);

    console.log("Invoking chain for task analysis");

    // Use the safe invoke method
    const completion = await safeInvoke(
      chain,
      {
        goal,
        actions,
        task,
      },
      '{"action":"reason","arg":"Analysis"}',
    );

    console.log("Analysis completion:", completion);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return JSON.parse(completion) as Analysis;
    } catch (e) {
      const parseErrorMessage = e instanceof Error ? e.message : String(e);
      console.error("Error parsing analysis:", parseErrorMessage);
      // Default to reasoning
      return DefaultAnalysis;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in analyzeTaskAgent:", errorMessage);
    return DefaultAnalysis;
  }
}

export type Analysis = {
  action: "reason" | "search";
  arg: string;
};

export const DefaultAnalysis: Analysis = {
  action: "reason",
  arg: "Fallback due to parsing failure",
};

async function executeTaskAgent(
  modelSettings: ModelSettings,
  goal: string,
  task: string,
  analysis: Analysis,
  customLanguage: string,
): Promise<string> {
  try {
    console.log("Executing task with parameters:", {
      goal,
      task,
      analysis,
      customLanguage,
    });

    if (analysis.action == "search" && process.env.SERP_API_KEY) {
      return await new Serper(modelSettings, goal)._call(analysis.arg);
    }

    const model = createModel(modelSettings);
    const outputParser = new StringOutputParser();

    const chain = RunnableSequence.from([
      executeTaskPrompt,
      model,
      outputParser,
    ]);

    console.log("Invoking chain for task execution");

    // Use the safe invoke method
    const completion = await safeInvoke(
      chain,
      {
        goal,
        task,
        customLanguage,
      },
      "Unable to complete the task due to technical issues. Please try a different approach.",
    );

    // For local development when no SERP API Key provided
    if (analysis.action == "search" && !process.env.SERP_API_KEY) {
      return `\`ERROR: Failed to search as no SERP_API_KEY is provided in ENV.\` \n\n${completion}`;
    }

    return completion;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in executeTaskAgent:", errorMessage);
    return "Unable to complete the task due to technical issues. Please try a different approach.";
  }
}

async function createTasksAgent(
  modelSettings: ModelSettings,
  goal: string,
  tasks: string[],
  lastTask: string,
  result: string,
  completedTasks: string[] | undefined,
  customLanguage: string,
): Promise<string[]> {
  try {
    console.log("Creating tasks with parameters:", {
      goal,
      tasksCount: tasks.length,
      lastTask,
      completedTasksCount: completedTasks?.length || 0,
      customLanguage,
    });

    const model = createModel(modelSettings);
    const outputParser = new StringOutputParser();

    const chain = RunnableSequence.from([
      createTasksPrompt,
      model,
      outputParser,
    ]);

    console.log("Invoking chain for task creation");

    // Use the safe invoke method
    const completion = await safeInvoke(
      chain,
      {
        goal,
        tasks,
        lastTask,
        result,
        customLanguage,
      },
      "[]",
    );

    console.log("Create tasks completion:", completion);
    return extractTasks(completion, completedTasks || []);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in createTasksAgent:", errorMessage);
    return [];
  }
}

interface AgentService {
  startGoalAgent: (
    modelSettings: ModelSettings,
    goal: string,
    customLanguage: string,
  ) => Promise<string[]>;
  analyzeTaskAgent: (
    modelSettings: ModelSettings,
    goal: string,
    task: string,
  ) => Promise<Analysis>;
  executeTaskAgent: (
    modelSettings: ModelSettings,
    goal: string,
    task: string,
    analysis: Analysis,
    customLanguage: string,
  ) => Promise<string>;
  createTasksAgent: (
    modelSettings: ModelSettings,
    goal: string,
    tasks: string[],
    lastTask: string,
    result: string,
    completedTasks: string[] | undefined,
    customLanguage: string,
  ) => Promise<string[]>;
}

const OpenAIAgentService: AgentService = {
  startGoalAgent: startGoalAgent,
  analyzeTaskAgent: analyzeTaskAgent,
  executeTaskAgent: executeTaskAgent,
  createTasksAgent: createTasksAgent,
};

const MockAgentService: AgentService = {
  startGoalAgent: async (modelSettings, goal, customLanguage) => {
    return await new Promise((resolve) => resolve(["Task 1"]));
  },

  createTasksAgent: async (
    modelSettings: ModelSettings,
    goal: string,
    tasks: string[],
    lastTask: string,
    result: string,
    completedTasks: string[] | undefined,
    customLanguage: string,
  ) => {
    return await new Promise((resolve) => resolve(["Task 4"]));
  },

  analyzeTaskAgent: async (
    modelSettings: ModelSettings,
    goal: string,
    task: string,
  ) => {
    return await new Promise((resolve) =>
      resolve({
        action: "reason",
        arg: "Mock analysis",
      }),
    );
  },

  executeTaskAgent: async (
    modelSettings: ModelSettings,
    goal: string,
    task: string,
    analysis: Analysis,
    customLanguage: string,
  ) => {
    return await new Promise((resolve) => resolve("Result: " + task));
  },
};

export default env.NEXT_PUBLIC_FF_MOCK_MODE_ENABLED
  ? MockAgentService
  : OpenAIAgentService;
