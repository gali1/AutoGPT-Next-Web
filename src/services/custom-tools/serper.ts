import { Tool } from "langchain/tools";
import type { ModelSettings } from "../../utils/types";
import { createModel, summarizeSearchSnippets } from "../../utils/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

/**
 * Wrapper around Serper adapted from LangChain: https://github.com/hwchase17/langchainjs/blob/main/langchain/src/tools/serper.ts
 *
 * You can create a free API key at https://serper.dev.
 *
 * To use, you should have the SERP_API_KEY environment variable set.
 */
export class Serper extends Tool {
  // Required values for Tool
  name = "search";
  description =
    "A search engine that should be used sparingly and only for questions about current events. Input should be a search query.";

  protected key: string;
  protected modelSettings: ModelSettings;
  protected goal: string;

  constructor(modelSettings: ModelSettings, goal: string) {
    super();

    this.key = process.env.SERP_API_KEY ?? "";
    this.modelSettings = modelSettings;
    this.goal = goal;
    if (!this.key) {
      throw new Error(
        "Serper API key not set. You can set it as SERP_API_KEY in your .env file, or pass it to Serper."
      );
    }
  }

  /** @ignore */
  async _call(input: string) {
    try {
      const res = await this.callSerper(input);
      const searchResult = await this.safeParseJSON(res);

      if (!searchResult) {
        return "Error: Could not parse search results.";
      }

      // Link means it is a snippet from a website and should not be viewed as a final answer
      if (searchResult.answerBox && !searchResult.answerBox.link) {
        const answerValues: string[] = [];
        if (searchResult.answerBox.title) {
          answerValues.push(searchResult.answerBox.title);
        }

        if (searchResult.answerBox.answer) {
          answerValues.push(searchResult.answerBox.answer);
        }

        if (searchResult.answerBox.snippet) {
          answerValues.push(searchResult.answerBox.snippet);
        }

        return answerValues.join("\n");
      }

      if (searchResult.sportsResults?.game_spotlight) {
        return searchResult.sportsResults.game_spotlight;
      }

      if (searchResult.knowledgeGraph?.description) {
        // TODO: use Title description, attributes
        return searchResult.knowledgeGraph.description;
      }

      if (searchResult.organic?.[0]?.snippet) {
        const snippets = this.safeExtractSnippets(searchResult);
        const summary = await this.summarizeSnippets(input, snippets);
        const resultsToLink = searchResult.organic?.slice(0, 3) || [];
        const links = resultsToLink.map((result) => result.link || "");

        return `${summary}\n\nLinks:\n${links
          .map((link) => `- ${link}`)
          .join("\n")}`;
      }

      return "No good search result found";
    } catch (error) {
      console.error("Error in Serper _call:", error);
      return "Error occurred during search. Please try again with a different query.";
    }
  }

  private safeParseJSON(response: Response): Promise<SearchResult | null> {
    return response.json().catch(err => {
      console.error("Error parsing JSON from Serper:", err);
      return null;
    });
  }

  private safeExtractSnippets(searchResult: SearchResult): string[] {
    try {
      if (!searchResult.organic || !Array.isArray(searchResult.organic)) {
        return [];
      }
      return searchResult.organic
        .filter(result => result && typeof result === 'object')
        .map(result => result.snippet || "")
        .filter(snippet => snippet);
    } catch (error) {
      console.error("Error extracting snippets:", error);
      return [];
    }
  }

  async callSerper(input: string) {
    try {
      const options = {
        method: "POST",
        headers: {
          "X-API-KEY": this.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: input,
        }),
      };

      const res = await fetch("https://google.serper.dev/search", options);

      if (!res.ok) {
        console.error(`Got ${res.status} error from serper: ${res.statusText}`);
      }

      return res;
    } catch (error) {
      console.error("Error calling Serper API:", error);
      throw error;
    }
  }

  private async summarizeSnippets(
    query: string,
    snippets: string[]
  ): Promise<string> {
    try {
      if (!snippets || snippets.length === 0) {
        return "No relevant information found.";
      }

      const model = createModel(this.modelSettings);
      const outputParser = new StringOutputParser();

      const chain = RunnableSequence.from([
        summarizeSearchSnippets,
        model,
        outputParser,
      ]);

      const response = await chain.invoke({
        goal: this.goal,
        query,
        snippets: snippets.join("\n\n"),
      });

      return response ? response.toString() : "No summary available.";
    } catch (error) {
      console.error("Error summarizing snippets:", error);
      return "Error creating summary from search results.";
    }
  }
}

interface SearchResult {
  answerBox?: AnswerBox;
  knowledgeGraph?: KnowledgeGraph;
  organic?: OrganicResult[];
  relatedSearches?: RelatedSearch[];
  sportsResults?: SportsResults;
}

interface AnswerBox {
  title?: string;
  answer?: string;
  snippet?: string;
  link?: string;
}

interface SportsResults {
  game_spotlight: string;
}

interface KnowledgeGraph {
  title: string;
  type: string;
  imageUrl: string;
  description: string;
  descriptionLink: string;
  attributes: object;
}

interface OrganicResult {
  title: string;
  link: string;
  snippet: string;
  attributes?: object;
}

interface RelatedSearch {
  query: string;
}