import plugin, { splitText } from "../src/server.ts"

// Build tag strings programmatically: a literal angle-bracket tag in source
// gets mangled by the editor layer, so never write one inline.
const bracket = (name: string, closing = false) => "<" + (closing ? "/" : "") + name + ">"
const TAGS = ["think", "thinking", "thought", "reasoning", "reflection"]

let handler: ((event: { response: Response }) => void) | undefined
const ctx = {
  options: {},
  session: {
    hook: async (name: string, callback: (event: { response: Response }) => void) => {
      if (name === "http.response") handler = callback
      return { dispose: async () => {} }
    },
  },
}
// @ts-expect-error minimal context for the test
await plugin.setup(ctx)
if (!handler) throw new Error("hook was not registered")

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function runBody(chunks: string[], contentType: string): Promise<string> {
  const response = new Response(streamOf(chunks), { headers: { "content-type": contentType } })
  const event = { response }
  handler!(event)
  return await event.response.text()
}

function dataChunk(delta: unknown): string {
  return "data: " + JSON.stringify({ id: "1", choices: [{ index: 0, delta }] }) + "\n\n"
}

/** Collapse an SSE body into the concatenated content/reasoning it carries. */
function mergeSse(body: string): { content: string; reasoning: string; raw: string } {
  const merged = { content: "", reasoning: "", raw: body }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    const delta = JSON.parse(payload).choices[0].delta
    if (typeof delta.content === "string") merged.content += delta.content
    if (typeof delta.reasoning_content === "string") merged.reasoning += delta.reasoning_content
  }
  return merged
}

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  if (!ok) {
    console.log("   expected: " + JSON.stringify(expected))
    console.log("   actual:   " + JSON.stringify(actual))
  }
}

// --- splitText unit cases -------------------------------------------------
{
  const think = bracket("think")
  const r = splitText(think + "step 1" + bracket("think", true) + "Hello", TAGS)
  check("unit: think open+close", r, { content: "Hello", reasoning: "step 1" })
}
{
  const r = splitText(bracket("thinking") + "a" + bracket("thinking", true) + "b", TAGS)
  check("unit: thinking open+close", r, { content: "b", reasoning: "a" })
}
{
  const r = splitText(bracket("thinking") + "only thinking", TAGS)
  check("unit: unclosed becomes reasoning", r, { content: "", reasoning: "only thinking" })
}
{
  const r = splitText("just an answer", TAGS)
  check("unit: no tags untouched", r, { content: "just an answer", reasoning: "" })
}

// --- streaming ------------------------------------------------------------
{
  const think = bracket("think")
  const body = await runBody(
    [dataChunk({ role: "assistant", content: think + "step 1" + bracket("think", true) + "Hello" }), "data: [DONE]\n\n"],
    "text/event-stream",
  )
  const merged = mergeSse(body)
  check("sse: single delta content", merged.content, "Hello")
  check("sse: single delta reasoning", merged.reasoning, "step 1")
}
{
  // Tag split across deltas.
  const name = "think"
  const body = await runBody(
    [
      dataChunk({ content: "ab<" + "th" }),
      dataChunk({ content: "ink>reason" }),
      dataChunk({ content: "ing</thi" }),
      dataChunk({ content: "nk>cd" }),
      "data: [DONE]\n\n",
    ],
    "text/event-stream",
  )
  const merged = mergeSse(body)
  check("sse: split tag content", merged.content, "abcd")
  check("sse: split tag reasoning", merged.reasoning, "reasoning")
}
{
  // Open tag never closed: flushed at [DONE].
  const body = await runBody(
    [dataChunk({ content: bracket("thinking") + "only thinking" }), "data: [DONE]\n\n"],
    "text/event-stream",
  )
  const merged = mergeSse(body)
  check("sse: unclosed flushed content", merged.content, "")
  check("sse: unclosed flushed reasoning", merged.reasoning, "only thinking")
}
{
  // Case-insensitive tags.
  const body = await runBody(
    [dataChunk({ content: "<THINK>a</Think>b" }), "data: [DONE]\n\n"],
    "text/event-stream",
  )
  const merged = mergeSse(body)
  check("sse: case-insensitive content", merged.content, "b")
  check("sse: case-insensitive reasoning", merged.reasoning, "a")
}
{
  // No tags: byte-for-byte pass-through.
  const chunk = dataChunk({ content: "just an answer" })
  const body = await runBody([chunk, "data: [DONE]\n\n"], "text/event-stream")
  check("sse: pass-through untouched", body, chunk + "data: [DONE]\n\n")
}
{
  // Foreign protocol: untouched.
  const chunk = "data: " + JSON.stringify({ type: "content_block_delta", delta: { text: "x" } }) + "\n\n"
  const body = await runBody([chunk, "data: [DONE]\n\n"], "text/event-stream")
  check("sse: foreign protocol untouched", body, chunk + "data: [DONE]\n\n")
}
{
  // Provider already streams a native reasoning field: extend it, don't compete.
  const body = await runBody(
    [dataChunk({ content: bracket("think") + "x" + bracket("think", true) + "y", reasoning: "native-" }), "data: [DONE]\n\n"],
    "text/event-stream",
  )
  const first = JSON.parse(body.split("\n")[0].slice(5)).choices[0].delta
  check("sse: extends native reasoning field", first.reasoning, "native-x")
  check("sse: extends native field content", first.content, "y")
}
{
  // Tool call delta untouched.
  const chunk = dataChunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "{}" } }] })
  const body = await runBody([chunk, "data: [DONE]\n\n"], "text/event-stream")
  check("sse: tool delta untouched", body, chunk + "data: [DONE]\n\n")
}
{
  // CRLF framing is tolerated.
  const body = await runBody(
    [
      "data: " + JSON.stringify({ choices: [{ delta: { content: bracket("think") + "r" + bracket("think", true) + "c" } }] }) + "\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ],
    "text/event-stream",
  )
  const merged = mergeSse(body)
  check("sse: crlf content", merged.content, "c")
  check("sse: crlf reasoning", merged.reasoning, "r")
}

// --- non-streaming JSON ---------------------------------------------------
{
  const body = await runBody(
    [JSON.stringify({ choices: [{ message: { role: "assistant", content: bracket("think") + "p" + bracket("think", true) + "q" } }] })],
    "application/json",
  )
  const message = JSON.parse(body).choices[0].message
  check("json: content", message.content, "q")
  check("json: reasoning", message.reasoning_content, "p")
}
{
  // Encoded body: must be left alone.
  const original = "data: " + JSON.stringify({ choices: [{ delta: { content: "x" } }] }) + "\n\n"
  const response = new Response(streamOf([original]), {
    headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
  })
  const event = { response }
  handler!(event)
  check("guard: encoded body untouched", await event.response.text(), original)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
