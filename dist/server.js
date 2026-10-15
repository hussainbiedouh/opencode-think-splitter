// src/server.ts
var DEFAULT_TAGS = ["think", "thinking", "thought", "reasoning", "reflection"];
var REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];

class ThinkSplitter {
  openMarkers;
  pending = "";
  inReasoning = false;
  closeMarker = "";
  constructor(tags) {
    this.openMarkers = tags.map((tag) => "<" + tag + ">");
  }
  feed(text) {
    this.pending += text;
    return this.drain(false);
  }
  flush() {
    return this.drain(true);
  }
  drain(final) {
    let content = "";
    let reasoning = "";
    for (;; ) {
      const lower = this.pending.toLowerCase();
      if (!this.inReasoning) {
        const hit = earliest(lower, this.openMarkers);
        if (hit) {
          content += this.pending.slice(0, hit.index);
          this.pending = this.pending.slice(hit.index + hit.marker.length);
          this.inReasoning = true;
          this.closeMarker = "</" + hit.marker.slice(1);
          continue;
        }
        const hold = final ? 0 : suffixHold(lower, this.openMarkers);
        content += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        break;
      }
      const index = lower.indexOf(this.closeMarker);
      if (index !== -1) {
        reasoning += this.pending.slice(0, index);
        this.pending = this.pending.slice(index + this.closeMarker.length);
        this.inReasoning = false;
        this.closeMarker = "";
        continue;
      }
      const hold = final ? 0 : suffixHold(lower, [this.closeMarker]);
      reasoning += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      break;
    }
    return { content, reasoning };
  }
}
function earliest(lower, markers) {
  let best = null;
  for (const marker of markers) {
    const index = lower.indexOf(marker);
    if (index !== -1 && (best === null || index < best.index))
      best = { index, marker };
  }
  return best;
}
function suffixHold(lower, markers) {
  let hold = 0;
  for (const marker of markers) {
    const max = Math.min(marker.length - 1, lower.length);
    for (let size = max;size > hold; size--) {
      if (lower.endsWith(marker.slice(0, size))) {
        hold = size;
        break;
      }
    }
  }
  return hold;
}
function reasoningField(target) {
  for (const field of REASONING_FIELDS) {
    if (typeof target[field] === "string")
      return field;
  }
  return null;
}
function appendReasoning(target, text) {
  const field = reasoningField(target) ?? "reasoning_content";
  const existing = target[field];
  target[field] = typeof existing === "string" ? existing + text : text;
}
function splitText(text, tags) {
  const splitter = new ThinkSplitter(tags);
  const head = splitter.feed(text);
  const tail = splitter.flush();
  return { content: head.content + tail.content, reasoning: head.reasoning + tail.reasoning };
}
function rebuild(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
function transformEventStream(response, tags) {
  const splitter = new ThinkSplitter(tags);
  const decoder = new TextDecoder;
  const encoder = new TextEncoder;
  let carry = "";
  const syntheticDelta = (delta) => "data: " + JSON.stringify({ choices: [{ index: 0, delta }] }) + `

`;
  const emitTail = () => {
    const tail = splitter.flush();
    let out = "";
    if (tail.reasoning.length > 0)
      out += syntheticDelta({ content: null, reasoning_content: tail.reasoning });
    if (tail.content.length > 0)
      out += syntheticDelta({ content: tail.content });
    return out;
  };
  const processLine = (raw) => {
    const hasNewline = raw.endsWith(`
`);
    let body = hasNewline ? raw.slice(0, -1) : raw;
    if (body.endsWith("\r"))
      body = body.slice(0, -1);
    if (!body.startsWith("data:"))
      return raw;
    const payload = body.slice(5).trim();
    if (payload.length === 0)
      return raw;
    if (payload === "[DONE]")
      return emitTail() + raw;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return raw;
    }
    if (!parsed || !Array.isArray(parsed.choices))
      return raw;
    let changed = false;
    for (const choice of parsed.choices) {
      const delta = choice?.delta;
      if (!delta || typeof delta.content !== "string" || delta.content.length === 0)
        continue;
      const original = delta.content;
      const split = splitter.feed(original);
      if (split.reasoning.length > 0) {
        appendReasoning(delta, split.reasoning);
        changed = true;
      }
      if (split.content !== original) {
        delta.content = split.content.length > 0 ? split.content : null;
        changed = true;
      }
    }
    return changed ? "data: " + JSON.stringify(parsed) + (hasNewline ? `
` : "") : raw;
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = carry.indexOf(`
`)) !== -1) {
        const raw = carry.slice(0, index + 1);
        carry = carry.slice(index + 1);
        controller.enqueue(encoder.encode(processLine(raw)));
      }
    },
    flush(controller) {
      if (carry.length > 0) {
        controller.enqueue(encoder.encode(processLine(carry)));
        carry = "";
      }
      const tail = emitTail();
      if (tail.length > 0)
        controller.enqueue(encoder.encode(tail));
    }
  }));
  return rebuild(response, body);
}
function transformJson(response, tags) {
  const encoder = new TextEncoder;
  const body = new ReadableStream({
    async start(controller) {
      let text;
      try {
        text = await response.text();
      } catch {
        controller.close();
        return;
      }
      let output = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.choices)) {
          let changed = false;
          for (const choice of parsed.choices) {
            const message = choice?.message;
            if (!message || typeof message.content !== "string" || message.content.length === 0)
              continue;
            const split = splitText(message.content, tags);
            if (split.reasoning.length > 0) {
              appendReasoning(message, split.reasoning);
              changed = true;
            }
            if (split.content !== message.content) {
              message.content = split.content;
              changed = true;
            }
          }
          if (changed)
            output = JSON.stringify(parsed);
        }
      } catch {}
      controller.enqueue(encoder.encode(output));
      controller.close();
    }
  });
  return rebuild(response, body);
}
function readTags(options) {
  const raw = options?.tags;
  if (Array.isArray(raw)) {
    const tags = raw.filter((tag) => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim().toLowerCase().replace(/^</, "").replace(/>$/, "")).filter((tag) => tag.length > 0);
    if (tags.length > 0)
      return tags;
  }
  return DEFAULT_TAGS;
}
function readProviders(options) {
  const raw = options?.providers;
  if (Array.isArray(raw)) {
    return raw.filter((provider) => typeof provider === "string" && provider.trim().length > 0);
  }
  return [];
}
var server_default = {
  id: "think-splitter",
  async setup(ctx) {
    const tags = readTags(ctx.options);
    const providers = readProviders(ctx.options);
    const handle = (event) => {
      const response = event?.response;
      if (!response || !response.body)
        return;
      const encoding = (response.headers.get("content-encoding") ?? "").toLowerCase();
      if (encoding.length > 0 && encoding !== "identity")
        return;
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        event.response = transformEventStream(response, tags);
      } else if (contentType.includes("application/json")) {
        event.response = transformJson(response, tags);
      }
    };
    const registrations = [];
    if (providers.length === 0) {
      registrations.push(await ctx.session.hook("http.response", handle));
    } else {
      for (const providerID of providers) {
        registrations.push(await ctx.session.hook("http.response", handle, { providerID }));
      }
    }
    console.warn(`[think-splitter] loaded tags=${tags.join(",")} providers=${providers.length > 0 ? providers.join(",") : "*"}`);
    return async () => {
      for (const registration of registrations)
        await registration.dispose();
    };
  }
};
export {
  server_default as default,
  splitText
};
