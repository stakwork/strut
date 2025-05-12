import { createAnthropic, AnthropicProviderOptions } from "@ai-sdk/anthropic";
import {
  createGoogleGenerativeAI,
  GoogleGenerativeAIProviderOptions,
} from "@ai-sdk/google";
import { createOpenAI, OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

export type Provider = "anthropic" | "google" | "openai";

export const PROVIDERS: Provider[] = ["anthropic", "google", "openai"];

const SOTA = {
  anthropic: "claude-3-7-sonnet-20250219",
  google: "gemini-2.5-pro-preview-05-06",
  openai: "gpt-4.1",
};

export async function getModel(provider: Provider, apiKey: string) {
  switch (provider) {
    case "anthropic":
      const anthropic = createAnthropic({
        apiKey,
      });
      return anthropic(SOTA[provider]);
    case "google":
      const google = createGoogleGenerativeAI({
        apiKey,
      });
      return google(SOTA[provider]);
    case "openai":
      const openai = createOpenAI({
        apiKey,
        compatibility: "strict",
      });
      return openai(SOTA[provider]);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

export function getProviderOptions(provider: Provider) {
  switch (provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 24000 },
        } satisfies AnthropicProviderOptions,
      };
    case "google":
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: 16384,
          },
        } satisfies GoogleGenerativeAIProviderOptions,
      };
    case "openai":
      return {
        openai: {} satisfies OpenAIResponsesProviderOptions,
      };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
