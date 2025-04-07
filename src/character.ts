import { join } from "path";
import { promises as fs } from "fs";
import {
  DEFAULT_GLOBAL_CONFIG,
  loadGlobalConfig,
  merge,
  parseYamlWithVariables,
} from "./lib/config.js";
import { CharacterConfig, DeepPartial, Issue, IssueComment, PlatformSdk } from "./types.js";
import {
  generateText,
  getModel,
  tool,
  jsonSchema,
  ToolSet,
} from "./lib/llm.js";
import { CoreMessage } from "ai";
import { McpHub } from "./lib/mcp.js";
import { BRANCH, OWNER, REPO, WORKSPACE } from "./lib/platform.js";
import { getPlatformSdk } from "./lib/platform.js";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  name: "",
  labels: [],
  systemPrompt: "",
};

const CONTEXT = {
  WORKSPACE,
  REPO,
  OWNER,
  CURRENT_BRANCH: BRANCH,
};

export class Character {
  private config: CharacterConfig;
  private mcpHub: McpHub;
  private sdk: PlatformSdk;

  constructor(config: DeepPartial<CharacterConfig>) {
    if (!config.name) {
      throw new Error("name is required in character config");
    }

    this.config = merge(DEFAULT_CHARACTER_CONFIG, config);
    this.mcpHub = new McpHub({
      servers: this.config.mcp.servers,
    });
    this.sdk = getPlatformSdk("github");
  }

  get name(): string {
    return this.config.name;
  }

  get model() {
    return getModel(this.config.llm.provider, this.config.llm.model);
  }

  public async initialize() {
    await this.mcpHub.connect({ model: this.model });
  }

  public async finalize() {
    await this.mcpHub.disconnect();
  }

  public matchesLabels(issueLabels: Issue["labels"]): boolean {
    const issueLabelSet = new Set(issueLabels.map((label: { name: string }) => label.name));

    return this.config.labels.some((label: string) => issueLabelSet.has(label));
  }

  private issueToPrompt(issue: Issue): {
    messages: CoreMessage[];
  } {
    return {
      messages: [
        {
          role: "system",
          content: `<context>${JSON.stringify({
            ...CONTEXT,
            ISSUE_ID: issue.id,
            CURRENT_TIME: new Date().toISOString(),
          })}</context>\n<character>${this.config.systemPrompt}</character>`,
        },
        {
          role: "user",
          content: `<title>${issue.title}</title><content>${issue.content}</content>`,
        },
        ...issue.comments
          // .filter((c) => !c.content.includes("[INTERNAL]"))
          .map((c: IssueComment) => {
            const m: CoreMessage = {
              role: "user",
              content: c.content,
            };

            return m;
          }),
      ],
    };
  }

  public async doTask(issue: Issue) {
    const { messages } = this.issueToPrompt(issue);
    const tools = await this.mcpHub.listTools();

    const { text, steps } = await generateText({
      model: this.model,
      messages,
      tools: tools.reduce((acc: ToolSet, t: Tool & { client: Client }) => {
        // console.log("appending", t.name, t.description);
        acc[t.name] = tool({
          description: t.description,
          parameters: jsonSchema(t.inputSchema),
          execute: async (input: any) => {
            console.log("going to execute", { name: t.name, input });
            try {
              const { content } = await t.client.callTool({
                name: t.name,
                arguments: input as unknown as Record<string, string>,
              });

              return JSON.stringify(content);
            } catch (error: any) {
              console.error(error);
              return JSON.stringify({
                error: {
                  message: error?.message,
                  name: error?.name,
                  stack: error?.stack,
                  ...error,
                },
              });
            }
          },
        });
        return acc;
      }, {} as ToolSet),
      maxSteps: this.config.llm.maxSteps,
      temperature: this.config.llm.temperature,
      maxTokens: this.config.llm.maxTokens,
      maxRetries: this.config.llm.maxRetries,
      onStepFinish: async (result: any) => {
        console.debug("debug:", result);
        const parts: string[] = [result.text].concat(
          result.toolCalls
            .map((tc: any) => {
              return `[INTERNAL]Tool Call:
\`\`\`json
${JSON.stringify(
                {
                  toolName: tc.toolName,
                  args: tc.args,
                  toolCallId: tc.toolCallId,
                },
                null,
                2
              )}
\`\`\``;
            })
            .concat(
              result.toolResults.map((tr: any) => {
                const { toolName, result, toolCallId } = tr as unknown as {
                  toolName: string;
                  result: unknown;
                  toolCallId: string;
                };
                return `[INTERNAL]Tool Result:
\`\`\`json
${JSON.stringify(
                  {
                    toolName,
                    result,
                    toolCallId,
                  },
                  null,
                  2
                )}
\`\`\``;
              })
            )
        );
        await this.addInternalMessages(issue, parts);
      },
    });

    return {
      text,
      steps,
    };
  }

  private async addInternalMessages(issue: Issue, parts: string[]) {
    return await this.sdk.createIssueComment(
      issue,
      `[Polaris]\n${parts.filter(Boolean).join("\n\n")}`
    );
  }
}

export async function loadAllCharacters(
  basePath: string,
  data: Record<string, string>
): Promise<Character[]> {
  const characters: Character[] = [];
  const charactersDir = join(basePath, ".polaris", "characters");
  const globalConfig = await loadGlobalConfig(basePath, data);

  try {
    // Check if directory exists using fs.stat
    try {
      await fs.stat(charactersDir);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.warn(`Characters config folder "${charactersDir}" does not exist.`);
        return characters; // Directory doesn't exist, return empty array
      } else {
        throw error; // Re-throw other errors
      }
    }

    // Read directory contents
    for (const entry of await fs.readdir(charactersDir, { withFileTypes: true })) {
      const isYaml =
        entry.name.endsWith(".yaml") || entry.name.endsWith(".yml");
      if (entry.isFile() && isYaml) {
        try {
          const filePath = join(charactersDir, entry.name);
          const content = await fs.readFile(filePath, "utf-8");
          const config = parseYamlWithVariables(
            content,
            data
          ) as CharacterConfig;
          characters.push(new Character(merge(globalConfig, config)));
          console.log(`character "${config.name}" loaded`);
        } catch (error) {
          console.error(`failed to load character "${entry.name}":`, error);
        }
      }
    }
  } catch (error) {
    console.error(`failed to load characters:`, error);
  }

  return characters;
}
