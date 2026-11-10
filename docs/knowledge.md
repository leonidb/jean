# Knowledge

Agents in a dojo work in parallel sessions, and each session starts with an empty context. Knowledge gives them one memory per dojo: shared by every agent, focused on the project, and kept current without a human curating it.

A dojo keeps several kinds of memory, each for a different use: the **wiki** at `.jean/context/`, which the librarian distills and every agent reads; the **event log**, with every memory, task thread and conversation with the human as it happened; **raw sources** in `.jean/raw_context/`, documents captured as they arrived; and the **workspace**, `.jean/workspace/`, for systems and records kept exactly as written. Together they are the dojo's knowledge. One search covers the wiki, the memories not yet in it, the tasks and the conversation. The wiki matters most: it is distilled knowledge about the project and the human's preferences, and it keeps improving with every run.

The wiki has its own chapter, [The wiki](wiki.md): how it is fed, distilled, read and kept true.

## Where a dojo keeps what it knows

| Store | What it holds | Written by | Searched under |
|---|---|---|---|
| The wiki, `.jean/context/` | Distilled, durable knowledge: findings, conventions, decisions, pointers | the librarian | `knowledge` |
| Memories, in the event log | What agents recorded with `memorize` | any agent | `knowledge`, until consolidated |
| Tasks | Each task's title, description and curated comments | the sensei and workers | `tasks` |
| Conversation | What the human and the agents said through a bridge (Telegram, Slack) | the human and the agents | `channel` |
| Raw sources, `.jean/raw_context/` | Documents captured for the dojo to learn from | added, never changed | the librarian's input |
| Workspace, `.jean/workspace/` | Systems the sensei runs and records it wrote, kept as written | the sensei | through the wiki's pointers |

The workspace is mainly for projects whose repo is shared with other people: documents and systems you want to manage and commit explicitly, but not into the shared repo. Unlike the wiki, where the librarian decides how a fact is filed and phrased, the workspace keeps things exactly as written. Every system or document in it has a pointer in the wiki.

## Search

Left to themselves, agents read a wiki inconsistently: they open one page and miss a more relevant one, skip a page on its description, or grep the event log. An index alone doesn't fix that, since navigating it takes two reads where grep takes one, and the wiki lacks what isn't consolidated yet. Search makes the cheap path the right one: one call that ranks every source, with an empty result an agent can trust.

```
GET /context/search?q=<terms>[&scope=all|knowledge|tasks|channel][&topN=5]
```

`knowledge` is the wiki's pages plus the memories not yet consolidated; `tasks` is each task as one document; `channel` is the conversation in windows of six messages; `all`, the default, ranks them together. The corpus is read fresh on every query. `index.md` and `log.md` are left out, since they name every topic and would outrank the pages they point to.

**Ranking.** A term in a page's title or description outranks one in its headings, which outranks one in its body: the page about a topic names it up top. Among equal placements, more of the query's distinct terms ranks higher, and ties sort by id, so results are deterministic. The contract sets ranking as these properties rather than as an engine, so the scoring can change without changing what agents rely on. Each hit carries its page's description, a snippet around its densest matches, and the query terms it matched.

**An empty result is definitive for what was searched**: no document in that scope contains any of the query's terms, as whole words. An empty all-scope search is what lets an agent stop instead of grepping the raw log. A source that can't be read fails the search rather than shrinking it, so `empty` never stands in for a failed read.

## Planned

- **Ranking by term density**: BM25 over page bodies, on top of the field ordering.
- **Read logging**: reads aren't events, so the log has no record of them; logging searches and page reads will let the balance of reads and writes be followed.
