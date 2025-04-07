import dotenv from "dotenv";
dotenv.config(); // Load environment variables from .env file

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  streamText,
  tool,
  jsonSchema,
  ToolSet,
  CoreMessage,
} from "ai";
import { PromptMessage } from "@modelcontextprotocol/sdk/types.js";

const google = createGoogleGenerativeAI({
  baseURL: process.env.GOOGLE_BASE_URL,
});

const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
});

const anthropic = createAnthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

export function getModel(provider: string, model: string) {
  switch (provider) {
    case "google":
      return google(model);
    case "openai":
      return openai(model);
    case "anthropic":
      return anthropic(model);
    default:
      throw new Error(`Invalid provider "${provider}"`);
  }
}

export function transformMessages(messages: PromptMessage[]): CoreMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: [
      {
        type: m.content.type as "text",
        text: m.content.text as string,
      },
    ],
  }));
}

export { generateText, streamText, tool, jsonSchema };
export type { ToolSet };
