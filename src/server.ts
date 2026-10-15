/**
 * think-splitter — OpenCode V2 plugin
 *
 * Problem: some OpenAI-compatible models stream their chain of thought inline
 * in the normal assistant text, wrapped in a thinking tag (a tag name such as
 * `think` or `thinking` between angle brackets). OpenCode renders that as
 * ordinary answer text, so the thinking is mixed into the reply and the
 * reasoning counter stays at zero.
 *
 * Fix: move the wrapped span into the streamed reasoning channel
 * (`choices[].delta.reasoning_content`), which OpenCode's provider drivers
 * already read to build a `reasoning` message part.
 *
 * Where it hooks in:
 *   `ctx.session.hook("http.response", …)` hands the plugin the raw provider
 *   Response before any provider driver parses it. Only the OpenAI chat
 *   completions shape is rewritten (`choices[].delta` for SSE,
 *   `choices[].message` for JSON). Every other body — other protocols, other
 *   field shapes, encoded payloads — is passed through byte for byte.
 *
 * `@opencode/plugin` is imported for types only; it is erased at runtime, so
 * the plugin needs no installed dependencies. The runtime contract is the
 * default-exported `{ id, setup }` object (`Plugin.define` is the identity
 * function).
 */

import type { Plugin } from "@opencode/plugin"

/**
 * Tag names recognised by default. Each name N matches `<N>` … `</N>`.
 * Override with `options.tags` on the plugin entry.
 */
const DEFAULT_TAGS = ["think", "thinking", "thought", "reasoning", "reflection"]

/** The delta fields OpenCode reads reasoning from, in driver priority order. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"]
type Split = { content: string; reasoning: string }

/** The part of a session `http.response` hook event this plugin touches. */
type HttpResponseEvent = { response: Response }

/** A registered hook, disposed on plugin teardown. */
type Registration = { dispose: () => Promise<void> }

/**
 * Stateful scanner that splits a token stream into visible content and
 * reasoning. Text before an opening tag is content, text between a matched
 * open/close pair is reasoning, and everything after the close tag is content
 * again.
 *
 * `feed` may hold back a few trailing characters when they could be the start
 * of a tag split across two deltas (`<thi` + `nk>`). `flush` releases them.
 */
class ThinkSplitter {
  private readonly openMarkers: string[]
  private pending = ""
  private inReasoning = false
  private closeMarker = ""

  constructor(tags: string[]) {
    this.openMarkers = tags.map((tag) => "<" + tag + ">")
  }

  feed(text: string): Split {
    this.pending += text
    return this.drain(false)
  }

  flush(): Split {
    return this.drain(true)
  }

  private drain(final: boolean): Split {
    let content = ""
    let reasoning = ""

    for (;;) {
      const lower = this.pending.toLowerCase()

      if (!this.inReasoning) {
        const hit = earliest(lower, this.openMarkers)
        if (hit) {
          content += this.pending.slice(0, hit.index)
          this.pending = this.pending.slice(hit.index + hit.marker.length)
          this.inReasoning = true
          this.closeMarker = "</" + hit.marker.slice(1)
          continue
        }
        const hold = final ? 0 : suffixHold(lower, this.openMarkers)
        content += this.pending.slice(0, this.pending.length - hold)
        this.pending = this.pending.slice(this.pending.length - hold)
        break
      }

      const index = lower.indexOf(this.closeMarker)
      if (index !== -1) {
        reasoning += this.pending.slice(0, index)
        this.pending = this.pending.slice(index + this.closeMarker.length)
        this.inReasoning = false
        this.closeMarker = ""
        continue
      }
      const hold = final ? 0 : suffixHold(lower, [this.closeMarker])
      reasoning += this.pending.slice(0, this.pending.length - hold)
      this.pending = this.pending.slice(this.pending.length - hold)
      break
    }

    return { content, reasoning }
  }
}

/** Earliest occurrence of any marker in an already lower-cased string. */
function earliest(lower: string, markers: string[]): { index: number; marker: string } | null {
  let best: { index: number; marker: string } | null = null
  for (const marker of markers) {
    const index = lower.indexOf(marker)
    if (index !== -1 && (best === null || index < best.index)) best = { index, marker }
  }
  return best
}

/**
 * Longest trailing slice of `lower` that is a proper prefix of a marker — the
 * characters we must not emit yet because a tag may be completing them.
 */
function suffixHold(lower: string, markers: string[]): number {
  let hold = 0
  for (const marker of markers) {
    const max = Math.min(marker.length - 1, lower.length)
    for (let size = max; size > hold; size--) {
      if (lower.endsWith(marker.slice(0, size))) {
        hold = size
        break
      }
    }
  }
  return hold
}

/** The reasoning field already present on a chunk, so we extend it instead of competing with it. */
function reasoningField(target: Record<string, unknown>): string | null {
  for (const field of REASONING_FIELDS) {
    if (typeof target[field] === "string") return field
  }
  return null
}

/** Append reasoning text to the chunk's own reasoning field, or `reasoning_content` when it has none. */
function appendReasoning(target: Record<string, unknown>, text: string): void {
  const field = reasoningField(target) ?? "reasoning_content"
  const existing = target[field]
  target[field] = typeof existing === "string" ? existing + text : text
}

/** One-shot split of a complete string (used for non-streaming bodies). */
export function splitText(text: string, tags: string[]): Split {
  const splitter = new ThinkSplitter(tags)
  const head = splitter.feed(text)
  const tail = splitter.flush()
  return { content: head.content + tail.content, reasoning: head.reasoning + tail.reasoning }
}

/** Copy the original response, dropping headers that no longer describe the rewritten body. */
function rebuild(response: Response, body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Rewrite a streamed OpenAI chat completion (SSE), moving tagged thinking from
 * `delta.content` into the delta's reasoning field as each line arrives.
 */
function transformEventStream(response: Response, tags: string[]): Response {
  const splitter = new ThinkSplitter(tags)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let carry = ""

  const syntheticDelta = (delta: Record<string, unknown>) =>
    "data: " + JSON.stringify({ choices: [{ index: 0, delta }] }) + "\n\n"

  const emitTail = (): string => {
    const tail = splitter.flush()
    let out = ""
    if (tail.reasoning.length > 0) out += syntheticDelta({ content: null, reasoning_content: tail.reasoning })
    if (tail.content.length > 0) out += syntheticDelta({ content: tail.content })
    return out
  }

  const processLine = (raw: string): string => {
    const hasNewline = raw.endsWith("\n")
    let body = hasNewline ? raw.slice(0, -1) : raw
    if (body.endsWith("\r")) body = body.slice(0, -1)
    if (!body.startsWith("data:")) return raw

    const payload = body.slice(5).trim()
    if (payload.length === 0) return raw
    if (payload === "[DONE]") return emitTail() + raw

    let parsed: { choices?: unknown }
    try {
      parsed = JSON.parse(payload)
    } catch {
      return raw
    }
    if (!parsed || !Array.isArray(parsed.choices)) return raw

    let changed = false
    for (const choice of parsed.choices as Array<Record<string, any>>) {
      const delta = choice?.delta
      if (!delta || typeof delta.content !== "string" || delta.content.length === 0) continue

      const original = delta.content
      const split = splitter.feed(original)
      if (split.reasoning.length > 0) {
        appendReasoning(delta, split.reasoning)
        changed = true
      }
      if (split.content !== original) {
        delta.content = split.content.length > 0 ? split.content : null
        changed = true
      }
    }

    return changed ? "data: " + JSON.stringify(parsed) + (hasNewline ? "\n" : "") : raw
  }

  const body = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        carry += decoder.decode(chunk, { stream: true })
        let index: number
        while ((index = carry.indexOf("\n")) !== -1) {
          const raw = carry.slice(0, index + 1)
          carry = carry.slice(index + 1)
          controller.enqueue(encoder.encode(processLine(raw)))
        }
      },
      flush(controller) {
        if (carry.length > 0) {
          controller.enqueue(encoder.encode(processLine(carry)))
          carry = ""
        }
        const tail = emitTail()
        if (tail.length > 0) controller.enqueue(encoder.encode(tail))
      },
    }),
  )

  return rebuild(response, body)
}

/** Rewrite a non-streamed OpenAI chat completion body, lazily so the hook stays synchronous. */
function transformJson(response: Response, tags: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text: string
      try {
        text = await response.text()
      } catch {
        controller.close()
        return
      }

      let output = text
      try {
        const parsed = JSON.parse(text) as { choices?: unknown }
        if (parsed && Array.isArray(parsed.choices)) {
          let changed = false
          for (const choice of parsed.choices as Array<Record<string, any>>) {
            const message = choice?.message
            if (!message || typeof message.content !== "string" || message.content.length === 0) continue

            const split = splitText(message.content, tags)
            if (split.reasoning.length > 0) {
              appendReasoning(message, split.reasoning)
              changed = true
            }
            if (split.content !== message.content) {
              message.content = split.content
              changed = true
            }
          }
          if (changed) output = JSON.stringify(parsed)
        }
      } catch {
        // Not JSON we understand — emit the original body unchanged.
      }

      controller.enqueue(encoder.encode(output))
      controller.close()
    },
  })

  return rebuild(response, body)
}

/** Normalise `options.tags`, stripping optional angle brackets. */
function readTags(options: Plugin.Context["options"]): string[] {
  const raw = options?.tags
  if (Array.isArray(raw)) {
    const tags = raw
      .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      .map((tag) => tag.trim().toLowerCase().replace(/^</, "").replace(/>$/, ""))
      .filter((tag) => tag.length > 0)
    if (tags.length > 0) return tags
  }
  return DEFAULT_TAGS
}

/** Normalise `options.providers`; empty means every provider. */
function readProviders(options: Plugin.Context["options"]): string[] {
  const raw = options?.providers
  if (Array.isArray(raw)) {
    return raw.filter((provider): provider is string => typeof provider === "string" && provider.trim().length > 0)
  }
  return []
}

export default {
  id: "think-splitter",

  async setup(ctx: Plugin.Context) {
    const tags = readTags(ctx.options)
    const providers = readProviders(ctx.options)

    const handle = (event: HttpResponseEvent) => {
      const response = event?.response
      if (!response || !response.body) return

      const encoding = (response.headers.get("content-encoding") ?? "").toLowerCase()
      if (encoding.length > 0 && encoding !== "identity") return

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
      if (contentType.includes("text/event-stream")) {
        event.response = transformEventStream(response, tags)
      } else if (contentType.includes("application/json")) {
        event.response = transformJson(response, tags)
      }
    }

    const registrations: Registration[] = []
    if (providers.length === 0) {
      registrations.push(await ctx.session.hook("http.response", handle))
    } else {
      for (const providerID of providers) {
        registrations.push(await ctx.session.hook("http.response", handle, { providerID }))
      }
    }

    console.warn(
      `[think-splitter] loaded tags=${tags.join(",")} providers=${providers.length > 0 ? providers.join(",") : "*"}`,
    )

    return async () => {
      for (const registration of registrations) await registration.dispose()
    }
  },
}
