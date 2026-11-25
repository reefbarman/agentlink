# Semantic Search and Embeddings

AgentLink indexes each workspace on your machine so agents can search code. By default that search matches text and code structure only, and nothing leaves your machine. Semantic search adds embeddings, so a query can find code by meaning even when the words differ. It is off until you turn it on.

## What changes when it is on

|                | Off (default)                      | On                                       |
| -------------- | ---------------------------------- | ---------------------------------------- |
| Ranking        | Text (lexical) plus code structure | Hybrid: text and meaning                 |
| Sent to OpenAI | Nothing                            | Indexed source chunks and search queries |
| Cost           | None                               | Billed by OpenAI to your API key         |
| Credentials    | None                               | An OpenAI API key                        |
| Index location | This machine                       | This machine                             |

Files left out of the index, such as ignored files and `agentlink.indexExclusions` matches, are not sent. A ChatGPT or Codex sign-in covers model chat only and cannot create embeddings. Having an API key never turns this on by itself.

The first rebuild after turning it on embeds the whole workspace. After that only changed files and search queries are sent.

## Turn it on

1. Open the AgentLink sidebar, find **Codebase Index**, and choose **Turn On…** under **Semantic search**. You can also run **AgentLink: Turn On Semantic Search Embeddings**.
2. Review what will be sent and the approximate size, then choose where it applies:
   - **This workspace only** saves `agentlink.semanticEmbeddingsEnabled` in workspace settings. That file may be committed, which would turn it on for other people who open the project and have a key.
   - **All workspaces** saves it in your user settings, so every project you open sends its indexed code.
3. Enter an OpenAI API key if you have not set one. Cancelling leaves semantic search off.
4. Choose **Rebuild Index**. Files that are already indexed and unchanged are skipped otherwise, so they get no embeddings until they change or you rebuild.

To set it by hand, add this to settings, store a key with **AgentLink: Set OpenAI API Key for Embeddings** (or set `OPENAI_API_KEY`), and run **AgentLink: Rebuild Codebase Index**:

```jsonc
{
  "agentlink.semanticEmbeddingsEnabled": true,
}
```

## Check its health

In VS Code, **Context health** in the sidebar has an **Embeddings** section, and **Codebase Index** shows the same state with actions. The browser remote does not show it.

| Status           | Meaning                                                              | What to do                              |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------- |
| Disabled         | Semantic search is off                                               | Nothing, or turn it on                  |
| Ready            | Every indexed chunk has an embedding                                 | Nothing                                 |
| Working          | Indexing is running                                                  | Wait                                    |
| Degraded         | Some chunks have no embedding                                        | **Rebuild to Embed**                    |
| Unavailable      | No API key, or nothing is embedded                                   | **Set API Key** or **Rebuild to Embed** |
| Not yet measured | Indexing has not finished, or files were indexed by an older version | Wait, then rebuild if it stays          |

Coverage is counted as files are indexed and updates when a run finishes. In a workspace with several folders it reflects the latest indexing run.

If embedding requests fail, files are still indexed for text search and the failure is listed in the AgentLink output channel. Query results also report the ranking used: `embeddings_disabled` means semantic search is off, and `embedding_auth_missing` means it is on without a key.

## Turn it off

Choose **Turn Off** in the sidebar or run **AgentLink: Turn Off Semantic Search Embeddings**. It clears the setting everywhere it was set to `true`, including your user settings. AgentLink then stops sending code and queries. Existing embeddings stay on this machine, and text search keeps working.
