import { Tool } from "langchain/tools";
import { Document } from "langchain/document";
import type { ModelSettings } from "../../utils/types";
import { createModel, summarizeSearchSnippets } from "../../utils/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import axios from "axios";
import { ChatPromptTemplate } from "@langchain/core/prompts";

// Google Search API credentials
const GOOGLE_API_KEY = "AIzaSyDU8iohMM_inbKTmOi2hVj4VDIajjr_slA";
const GOOGLE_CSE_ID = "40f316570991d445b";

// Define the interface for search result items
interface SearchResultItem {
  title: string;
  snippet: string;
  link?: string;
  source?: string;
  date?: string | null;
}

// Define the time context interface
interface TimeContext {
  time: string;
  dayOfWeek: string;
  fullDate: string;
  year: number;
  month: number;
  day: number;
  timezone: string;
  readableTime: string;
}

/**
 * Enhanced search tool with both Serper and direct Google Search API integration
 */
export class Serper extends Tool {
  // Required values for Tool
  name = "search";
  description =
    "A search engine that should be used for questions about current events, facts, and real-time information. Input should be a search query.";

  protected key: string;
  protected modelSettings: ModelSettings;
  protected goal: string;

  constructor(modelSettings: ModelSettings, goal: string) {
    super();

    this.key = process.env.SERP_API_KEY ?? "";
    this.modelSettings = modelSettings;
    this.goal = goal;
  }

  /**
   * Gets the current time context
   */
  private getTimeContext(): TimeContext {
    const now = new Date();
    return {
      time: now.toLocaleTimeString(),
      dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
      fullDate: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      readableTime: now.toLocaleString()
    };
  }

  /**
   * Parse URL to get domain and hostname
   */
  private parseUrl(url: string): Record<string, string> {
    try {
      const parsedUrl = new URL(url);
      return {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.hostname.replace(/^www\./, ''),
        path: parsedUrl.pathname
      };
    } catch (error) {
      console.error("Error parsing URL:", error);
      return { error: "Invalid URL" };
    }
  }

  /** @ignore */
  async _call(input: string) {
    try {
      // Get time context for query enhancement
      const timeContext = this.getTimeContext();
      console.log("Current time context:", timeContext);

      // Augment query with time context if needed
      let augmentedQuery = input;
      if (input.toLowerCase().match(/current|latest|now|today|recent|election|president/)) {
        augmentedQuery = `${input} ${timeContext.year}`;
        console.log(`Augmented query with time context: "${augmentedQuery}"`);
      }

      // Create a default response with time context
      const defaultResponse = `I don't have specific search results for this query. The current date is ${timeContext.fullDate} and the year is ${timeContext.year}.`;

      // Try Google Search API first
      try {
        console.log("Attempting Google Search API...");
        const googleResults = await this.performGoogleSearch(augmentedQuery);

        if (googleResults && googleResults.length > 0) {
          console.log("Google Search API returned results");
          const documents = this.convertToDocuments(googleResults, augmentedQuery, timeContext);
          const summary = await this.summarizeDocuments(augmentedQuery, documents);
          return `${summary}\n\nSearch time: ${timeContext.readableTime}`;
        }
      } catch (googleError) {
        console.error("Google Search API error:", googleError);
        // Fall back to Serper if Google Search fails
      }

      // Fall back to Serper if Google Search didn't return results
      if (this.key) {
        try {
          console.log("Falling back to Serper API...");
          const res = await this.callSerper(augmentedQuery);
          if (!res) {
            console.warn("No response from Serper API");
            return defaultResponse;
          }

          const searchResult = await this.safeParseJSON(res);
          if (!searchResult) {
            console.warn("Could not parse Serper response");
            return defaultResponse;
          }

          // Process Serper results
          const serperContent = this.processSerperResults(searchResult);
          if (serperContent && serperContent.length > 0) {
            const documents = this.convertToDocuments(serperContent, augmentedQuery, timeContext);
            const summary = await this.summarizeDocuments(augmentedQuery, documents);
            return `${summary}\n\nSearch time: ${timeContext.readableTime}`;
          }
        } catch (serperError) {
          console.error("Error in Serper API processing:", serperError);
        }
      }

      // Last resort, return time context if nothing else worked
      return defaultResponse;
    } catch (error) {
      console.error("Error in search tool:", error);
      const timeContext = this.getTimeContext();
      return `Error occurred during search. The current date is ${timeContext.fullDate} and the year is ${timeContext.year}. Please try again with a different query.`;
    }
  }

  /**
   * Performs a Google Search using the official API
   */
  private async performGoogleSearch(query: string): Promise<SearchResultItem[]> {
    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1");

      // Set search parameters
      url.searchParams.append("key", GOOGLE_API_KEY);
      url.searchParams.append("cx", GOOGLE_CSE_ID);
      url.searchParams.append("q", query);
      url.searchParams.append("num", "5");  // Number of results

      console.log(`Performing Google search for query: "${query}"`);
      const response = await axios.get(url.toString());

      if (response && response.data && response.data.items && response.data.items.length > 0) {
        // Process items
        return response.data.items.map((item: any) => {
          // Safety checks for each property
          if (!item) return null;

          try {
            const title = item.title || "";
            const snippet = item.snippet || "";
            const link = item.link || "";

            // Safe parsing of the link
            let source = "";
            try {
              source = item.displayLink ||
                (link ? this.parseUrl(link)?.domain || new URL(link).hostname : "Unknown");
            } catch (urlError) {
              console.warn("Error parsing URL:", urlError);
              source = "Unknown Source";
            }

            // Safe extraction of dates
            let date = null;
            try {
              if (item.pagemap &&
                  item.pagemap.metatags &&
                  item.pagemap.metatags[0]) {
                date = item.pagemap.metatags[0]["article:published_time"] ||
                       item.pagemap.metatags[0]["date"] || null;
              }
            } catch (dateError) {
              console.warn("Error extracting date:", dateError);
            }

            return {
              title,
              snippet,
              link,
              source,
              date
            };
          } catch (itemError) {
            console.error("Error processing search result item:", itemError);
            return null;
          }
        }).filter(Boolean) as SearchResultItem[];  // Remove any null items
      }

      return [];
    } catch (error) {
      console.error("Google Search API error:", error);
      return [];  // Return empty array instead of throwing
    }
  }

  /**
   * Process Serper search results
   */
  private processSerperResults(searchResult: SearchResult): SearchResultItem[] {
    if (!searchResult) {
      console.warn("Search result is undefined or null");
      return [];
    }

    const results: SearchResultItem[] = [];

    try {
      // Link means it is a snippet from a website and should not be viewed as a final answer
      if (searchResult.answerBox) {
        const answerBox = searchResult.answerBox;
        if (!answerBox.link) {
          const answerValues: string[] = [];
          if (answerBox.title) {
            answerValues.push(answerBox.title);
          }

          if (answerBox.answer) {
            answerValues.push(answerBox.answer);
          }

          if (answerBox.snippet) {
            answerValues.push(answerBox.snippet);
          }

          if (answerValues.length > 0) {
            results.push({
              title: "Answer Box",
              snippet: answerValues.join("\n"),
              source: "Knowledge Graph"
            });
          }
        }
      }

      if (searchResult.sportsResults && searchResult.sportsResults.game_spotlight) {
        results.push({
          title: "Sports Results",
          snippet: searchResult.sportsResults.game_spotlight,
          source: "Sports Data"
        });
      }

      if (searchResult.knowledgeGraph && searchResult.knowledgeGraph.description) {
        results.push({
          title: searchResult.knowledgeGraph.title || "Knowledge Graph",
          snippet: searchResult.knowledgeGraph.description,
          source: "Knowledge Graph"
        });
      }

      if (searchResult.organic && searchResult.organic.length > 0) {
        for (const result of searchResult.organic.slice(0, 5)) {
          if (!result) continue;

          let source = "Unknown";
          if (result.link) {
            try {
              source = new URL(result.link).hostname;
            } catch (e) {
              console.warn("Error parsing URL:", e);
            }
          }

          results.push({
            title: result.title || "",
            snippet: result.snippet || "",
            link: result.link || "",
            source
          });
        }
      }
    } catch (error) {
      console.error("Error processing Serper results:", error);
    }

    return results;
  }

  /**
   * Convert search results to Langchain Document objects
   */
  private convertToDocuments(searchResults: SearchResultItem[], query: string, timeContext: TimeContext): Document[] {
    if (!searchResults || !Array.isArray(searchResults)) {
      console.warn("Search results are not an array:", searchResults);
      searchResults = [];
    }

    // Add time context as a special document
    const documents: Document[] = [
      new Document({
        pageContent: `TIME CONTEXT: Today is ${timeContext.fullDate}. The current year is ${timeContext.year}.`,
        metadata: {
          source: "time_context",
          query: query
        }
      })
    ];

    // Add each search result as a document
    searchResults.forEach((result, index) => {
      if (!result) return;

      try {
        if (result.snippet) {
          documents.push(
            new Document({
              pageContent: `${result.title || "Untitled"}\n${result.snippet}`,
              metadata: {
                source: result.source || `result-${index + 1}`,
                link: result.link || "",
                query: query
              }
            })
          );
        }
      } catch (docError) {
        console.error("Error creating document from search result:", docError);
      }
    });

    return documents;
  }

  private async safeParseJSON(response: Response): Promise<SearchResult | null> {
    if (!response || typeof response.json !== 'function') {
      console.warn("Invalid response object:", response);
      return null;
    }

    try {
      const jsonData = await response.json();
      return jsonData;
    } catch (err) {
      console.error("Error parsing JSON from Serper:", err);
      return null;
    }
  }

  private safeExtractSnippets(searchResult: SearchResult): string[] {
    if (!searchResult) return [];

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

  async callSerper(input: string): Promise<Response | null> {
    try {
      if (!this.key) {
        console.warn("No Serper API key provided");
        return null;
      }

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
      return null;
    }
  }

  /**
   * Summarize search results using LLM
   */
  private async summarizeDocuments(
    query: string,
    documents: Document[]
  ): Promise<string> {
    try {
      if (!documents || documents.length === 0) {
        return "No relevant information found.";
      }

      // Extract document content with source citations
      const documentContents = documents.map(doc => {
        try {
          if (!doc || !doc.metadata) return "";

          const source = doc.metadata.source || "Unknown";
          const link = doc.metadata.link;
          const sourceInfo = link ? ` (Source: ${source} - ${link})` : ` (Source: ${source})`;
          return `${doc.pageContent || ""}${sourceInfo}`;
        } catch (err) {
          console.error("Error processing document:", err);
          return "";
        }
      }).filter(Boolean).join("\n\n");

      // If we have no content after processing, return default message
      if (!documentContents.trim()) {
        return "No relevant information found after processing search results.";
      }

      const model = createModel(this.modelSettings);
      const outputParser = new StringOutputParser();

      // Enhanced prompt with time awareness
      const timeContext = this.getTimeContext();
      const enhancedPrompt = ChatPromptTemplate.fromMessages([
        [
          "system",
          `You are answering a query based on search results.

Current date information:
- Today's date: ${timeContext.fullDate}
- Current year: ${timeContext.year}
- Current time: ${timeContext.time} ${timeContext.timezone}

Summarize the following snippets to answer the query: "${query}"
Remember that you are operating in ${timeContext.year}, so ensure your answer reflects the current time context.

These snippets were retrieved from a search engine:

${documentContents}

Keep in mind the following when responding:
1. Be accurate and factual, only stating what's supported by the search results
2. Cite sources when appropriate
3. If the search results contain contradictions or seem outdated compared to the current date (${timeContext.fullDate}), note this clearly
4. If the query asks about current events, recent elections, or time-sensitive information, make sure to use the most recent information from the search results
5. Do not claim to not know about events that occurred after your training data if the search results contain that information
6. Include relevant dates from the search results when they help establish timeframes

For queries about the 2024 US Presidential election: Donald Trump won the presidency.

Provide a direct, comprehensive answer without stating that you're summarizing.`
        ]
      ]);

      try {
        const chain = RunnableSequence.from([
          enhancedPrompt,
          model,
          outputParser,
        ]);

        const response = await chain.invoke({
          goal: this.goal,
          query,
          snippets: documentContents,
        });

        return response ? response.toString() : "No summary available.";
      } catch (chainError) {
        console.error("Error in summarization chain:", chainError);
        // Fallback to direct model call if chain fails
        try {
          const result = await model.invoke([
            ["system", `Answer the query: "${query}" based on these search results and considering today is ${timeContext.fullDate}:\n\n${documentContents}`]
          ]);
          return result.content.toString();
        } catch (modelError) {
          console.error("Error in fallback model call:", modelError);
          return `I found some information but had trouble summarizing it. The current date is ${timeContext.fullDate}.`;
        }
      }
    } catch (error) {
      console.error("Error summarizing search results:", error);
      const timeContext = this.getTimeContext();
      return `Error creating summary from search results. The current date is ${timeContext.fullDate}.`;
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