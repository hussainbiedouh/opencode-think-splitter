# opencode-think-splitter

An [OpenCode](https://opencode.ai) plugin that moves a model's inline thinking out of the visible reply and into OpenCode's reasoning channel.

## The problem

Some OpenAI-compatible models stream their chain of thought inside the ordinary text channel, wrapped in a tag such as `think` or `thinking` between angle brackets:

```
<thinking>the user probably wants X, so ...</thinking>Here is your answer.
```

OpenCode renders and stores that as a normal assistant text part. So the private reasoning ends up mixed into the answer, and the message gets no `reasoning` part at all — the reasoning counter stays at zero.

## What it does

The plugin attaches to `session.http.response`, which hands it the raw provider response before any provider driver parses it. For every OpenAI-style chunk it moves the tagged span out of the content field and into the chunk's reasoning field.

- Streaming: rewrites `choices[].delta.content` and writes `choices[].delta.reasoning_content`.
- Non-streaming JSON: rewrites `choices[].message.content` and writes `choices[].message.reasoning_content`.
- Anything else — other protocols, other field shapes, an explicit `content-encoding` — is passed through byte for byte.

OpenCode's provider drivers already read the reasoning field to build a `reasoning` message part, so the thinking shows up where it belongs and the visible text is clean.

## Install

```
opencode plugin add opencode-think-splitter
```

Or add it to `opencode.jsonc` by hand:

```jsonc
{
  "plugins": ["opencode-think-splitter"]
}
```

## Options

Options are passed per plugin entry, so you can scope the rewrite or trim the tag list:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-think-splitter",
      "options": {
        "tags": ["think", "thinking"],
        "providers": ["my-relay"]
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tags` | `string[]` | `["think", "thinking", "thought", "reasoning", "reflection"]` | Tag names to recognise. Angle brackets are optional in the value; matching is case-insensitive. |
| `providers` | `string[]` | `[]` (every provider) | Restrict the hook to these provider ids. |

## Behaviour details

- **Unclosed tag**: everything after it is treated as reasoning and flushed when the stream ends.
- **Native reasoning is preserved**: if a chunk already carries `reasoning_content`, `reasoning`, or `reasoning_text`, the moved text is appended to that field rather than competing with it.
- **Split tags**: a tag may arrive split across two or more stream chunks; the plugin holds back the trailing bytes until it can decide.
- **Headers**: a rewritten response drops `content-length` and `content-encoding`, since the body is re-emitted as identity-encoded text.

## Caveats

- Some providers are strict about `reasoning_content` being echoed back in the follow-up request. If a provider errors after a rewrite, scope the plugin away from it with `options.providers`.
- Built for the OpenCode **V2** plugin API (developed against `@opencode/plugin` 2.0.21). It uses `ctx.session.hook("http.response", ...)`, which does not exist in the V1 API.
- Don't run this plugin twice. If you already have it installed as a local file plugin (`~/.opencode/plugins/think-splitter/`), delete that copy after installing the package. Both declare the id `think-splitter`, and only one instance of a given id registers, so the plugin you did not intend can silently win.

## Development

```
bun install
bun run bundle    # -> dist/server.js
bun run test      # 22 checks: unit, SSE, JSON, guards
bun run typecheck
```

`src/server.ts` is the plugin. `test/split.ts` drives the registered hook with synthetic provider responses.

Do not rename `bundle` to `build`, and do not add a `prepare`, `prepack`, `install`, `preinstall` or `postinstall` script. `pacote` treats exactly those script names as a signal to run a full "git dep preparation" step when the package is installed from a git spec (see `#prepareDir` in `pacote/lib/git.js`). OpenCode's bundled runtime passes an invalid `npmBin` to that step, so `opencode plugin add <git spec>` dies with `git dep preparation failed`. Because `dist/server.js` is committed, the git install path needs no build at all — keeping the script off that list is what makes `opencode plugin add github:hussainbiedouh/opencode-think-splitter` work.

## License

MIT
