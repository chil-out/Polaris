import { Character, loadAllCharacters } from "./character.js";
import {
  getPlatformSdk,
  getTriggerEvent,
  WORKSPACE,
  REPO,
  OWNER,
} from "./lib/platform.js";
import { Issue, PlatformSdk } from "./types.js";

console.log("hello v2");

const data: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  data[`env_${key}`] = value as string;
}

const characters = await loadAllCharacters(WORKSPACE, data);

const event = await getTriggerEvent();

const sdk = getPlatformSdk("github");

switch (event?.name) {
  case "issues": {
    const issue = await sdk.getIssueFromEvent(event);

    await letCharacterDoTask(sdk, characters, issue);
    break;
  }
  case "schedule": {
    const issues = await sdk.listIssues({
      owner: OWNER,
      repo: REPO,
      labels: ["schedule"],
    });
    for (const issue of issues) {
      await letCharacterDoTask(sdk, characters, issue);
    }
    break;
  }
  default:
    console.warn(`Unsupported event`);
}

async function letCharacterDoTask(
  sdk: PlatformSdk,
  characters: Character[],
  issue: Issue
) {
  if (issue.state.toLowerCase() !== "open") {
    return;
  }

  for (const character of characters) {
    if (!character.matchesLabels(issue.labels)) {
      continue;
    }

    // TODO: parallel
    await character.initialize();

    await character.doTask(issue);

    await character.finalize();
  }
}
