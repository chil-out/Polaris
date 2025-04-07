import assert from "assert";
import { join } from "path";
import { promises as fs } from "fs";
import { Octokit } from "octokit";
import commitPlugin from "octokit-commit-multiple-files";
import { PlatformSdk, PlatformType, TriggerEvent, Issue, IssueEvent } from "../types.js";

// Use GITHUB_WORKSPACE if set, otherwise default to current working directory
let WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
assert(WORKSPACE, "WORKSPACE could not be determined");

let REPO = "";
let OWNER = "";
if (process.env.GITHUB_REPOSITORY) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  REPO = repo || "";
  OWNER = owner || "";
}

let BRANCH = process.env.BRANCH || "";

export { WORKSPACE, REPO, OWNER, BRANCH };

export async function getTriggerEvent(): Promise<TriggerEvent | null> {
  let eventName = process.env.GITHUB_EVENT_NAME || "";
  assert(eventName, "GITHUB_EVENT_NAME is not set");

  // deno-lint-ignore no-explicit-any
  let eventPayload: any = {};
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (eventPath) {
    try {
      eventPayload = JSON.parse(await fs.readFile(eventPath, "utf-8"));
    } catch (error) {
      console.error(`Failed to read or parse event payload from ${eventPath}:`, error);
      // Decide if you want to return null or throw here
      return null;
    }
  }

  if (eventName === "issues" || eventName === "issue_comment") {
    return {
      name: "issues",
      action: eventPayload.action,
      issue: {
        owner: eventPayload.repository.owner.login,
        repo: eventPayload.repository.name,
        id: eventPayload.issue.number,
      },
    };
  }

  if (eventName === "schedule") {
    return {
      name: "schedule",
    };
  }

  console.warn(`Unsupported event: ${eventName}`);

  return null;
}

const PatchedOctokit = Octokit.plugin(commitPlugin);

export function getPlatformSdk(type: PlatformType): PlatformSdk {
  switch (type) {
    case "github": {
      const ghToken = process.env.GITHUB_TOKEN;
      assert(ghToken, "GITHUB_TOKEN is not set");
      const octokit: Octokit = new PatchedOctokit({
        auth: ghToken,
      });
      return {
        getIssueFromEvent: async (event: IssueEvent): Promise<Issue> => {
          const { owner, repo, id } = event.issue;
          const { data } = await octokit.rest.issues.get({
            owner,
            repo,
            issue_number: id,
          });
          const issueComments = (
            await octokit.rest.issues.listComments({
              owner,
              repo,
              issue_number: id,
            })
          ).data;
          return {
            owner,
            repo,
            id,
            title: data.title,
            content: data.body ?? "",
            state: data.state,
            labels: data.labels.map((l) => {
              if (typeof l === "string") {
                return { name: l };
              }
              return { name: l.name ?? "" };
            }),
            comments: issueComments.map((comment) => ({
              author: {
                name: comment.user?.login ?? "-",
              },
              content: comment.body ?? "",
            })),
          };
        },
        listIssues: async ({ owner, repo, labels }: { owner: string, repo: string, labels?: string[] }): Promise<Issue[]> => {
          const { repository } = await octokit.graphql<{
            repository: any;
          }>({
            query: /* GraphQL */ `
              query ($owner: String!, $repo: String!, $labels: [String!]) {
                repository(owner: $owner, name: $repo) {
                  issues(labels: $labels, first: 10) {
                    nodes {
                      number
                      title
                      body
                      state
                      labels(first: 10) {
                        nodes {
                          name
                        }
                      }
                      comments(first: 10) {
                        nodes {
                          author {
                            login
                          }
                          body
                        }
                      }
                    }
                  }
                }
              }
            `,
            owner,
            repo,
            labels,
          });

          console.log(repository.issues.nodes);
          return repository.issues.nodes.map((issue: any) => ({
            owner: owner,
            repo: repo,
            id: issue.number,
            title: issue.title,
            content: issue.body,
            state: issue.state,
            labels: issue.labels.nodes.map((l: any) => ({
              name: l.name,
            })),
            comments: issue.comments.nodes.map((comment: any) => ({
              author: {
                name: comment.author.login,
              },
              content: comment.body,
            })),
          }));
        },
        createIssueComment: async (issue: Issue, content: string): Promise<void> => {
          await octokit.rest.issues.createComment({
            owner: issue.owner,
            repo: issue.repo,
            issue_number: issue.id,
            body: content,
          });
        },
      };
    }
    default:
      throw new Error(`Invalid platform type "${type}"`);
  }
}
