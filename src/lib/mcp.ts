import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpServer } from "../types.js";
import {
  CreateMessageRequestSchema,
  LoggingMessageNotificationSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { LanguageModelV1 } from "ai";
import { generateText, transformMessages } from "./llm.js";

export interface McpHubOptions {
  servers: McpServer[];
}

export class McpHub {
  private clients: Array<[Client, McpServer]> = [];
  private servers: McpServer[] = [];

  constructor({ servers }: McpHubOptions) {
    this.servers = servers;
  }

  public async connect({ model }: { model: LanguageModelV1 }) {
    for (const server of this.servers) {
      const transport =
        server.type === "stdio"
          ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: { ...getDefaultEnvironment(), ...server.env },
          })
          : server.type === "sse"
            ? new SSEClientTransport(new URL(server.url))
            : null;
      if (!transport) {
        throw new Error(`Unsupported transport type: ${server.type}`);
      }

      const client = new Client(
        {
          name: "polaris",
          version: "1.0.0",
        },
        {
          capabilities: {
            sampling: {},
          },
        }
      );

      client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        ({ params }: { params: any }) => {
          console.log(params.data);
        }
      );

      client.setRequestHandler(CreateMessageRequestSchema, async (request: any) => {
        const { messages, maxTokens, systemPrompt, temperature } =
          request.params;

        console.log("[INTERNAL]Sampling Request:", {
          messages,
          systemPrompt,
        });

        //         await this.onSampling([
        //           `[INTERNAL]Sampling Request:
        // \`\`\`json
        // ${JSON.stringify(
        //   {
        //     messages,
        //     systemPrompt,
        //   },
        //   null,
        //   2
        // )}
        // \`\`\`
        // `,
        //         ]);

        const fullMessages = transformMessages(messages);
        if (systemPrompt) {
          fullMessages.unshift({
            role: "system",
            content: systemPrompt,
          });
        }

        const { text } = await generateText({
          messages: fullMessages,
          maxTokens: maxTokens,
          model,
          temperature,
        });

        console.log("[INTERNAL]Sampling Result:", text);

        //         await this.onSampling([
        //           `[INTERNAL]Sampling Result:
        // \`\`\`
        // ${text}
        // \`\`\`
        // `,
        //         ]);

        return {
          content: {
            type: "text",
            text,
          },
          model: model.modelId,
          role: "assistant",
        };
      });

      await client.connect(transport);

      this.clients.push([client, server]);
    }
  }

  public async disconnect() {
    await Promise.all(this.clients.map(([client]) => client.close()));
  }

  public async listTools(): Promise<Array<Tool & { client: Client }>> {
    const tools = await Promise.all(
      this.clients.map(async ([client, server]) => {
        const result = await client.listTools();
        return {
          ...result,
          client,
          server,
        };
      })
    );

    return tools.reduce<Array<Tool & { client: Client }>>(
      (acc, { tools, client, server }) => {
        return acc.concat(
          tools
            .filter((t: Tool) => {
              if (!server.tools) {
                // allow all
                return true;
              }
              if (server.tools[t.name]) {
                // whitelist
                return true;
              }
              return false;
            })
            .map((t: Tool) => ({
              ...t,
              client,
            }))
        );
      },
      []
    );
  }
}
