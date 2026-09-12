/**
 * Model providers for eval mode. Only two shapes are supported on purpose:
 *  - openai-compatible (covers OpenAI + DeepSeek + Moonshot + most CN relays via --base-url)
 *  - anthropic
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool role: id of the assistant tool_call this result answers */
  toolCallId?: string;
  /** assistant role: tool calls the model made in this turn */
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderTurn {
  content: string;
  toolCalls: ToolCallRequest[];
}

export interface EvalProvider {
  readonly label: string;
  chat(model: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ProviderTurn>;
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function openaiCompatibleProvider(baseUrl: string, apiKey: string): EvalProvider {
  const endpoint = baseUrl.replace(/\/$/, "") + "/chat/completions";
  return {
    label: `openai-compatible (${baseUrl})`,
    async chat(model, messages, tools) {
      const wire = messages.map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            })),
          };
        }
        return { role: m.role, content: m.content };
      });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: wire,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          temperature: 0,
        }),
      });
      if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as any;
      const msg = j.choices?.[0]?.message ?? {};
      return {
        content: typeof msg.content === "string" ? msg.content : "",
        toolCalls: (msg.tool_calls ?? []).map((tc: any) => ({
          id: String(tc.id ?? ""),
          name: String(tc.function?.name ?? ""),
          args: safeParseArgs(tc.function?.arguments),
        })),
      };
    },
  };
}

export function anthropicProvider(apiKey: string): EvalProvider {
  return {
    label: "anthropic",
    async chat(model, messages, tools) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const convo: Array<Record<string, unknown>> = [];
      for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "user") {
          convo.push({ role: "user", content: [{ type: "text", text: m.content }] });
        } else if (m.role === "assistant") {
          const content: Array<Record<string, unknown>> = [];
          if (m.content) content.push({ type: "text", text: m.content });
          for (const tc of m.toolCalls ?? []) {
            content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
          }
          if (content.length) convo.push({ role: "assistant", content });
        } else if (m.role === "tool") {
          convo.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
          });
        }
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0,
          system: system || undefined,
          messages: convo,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }),
      });
      if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as any;
      let content = "";
      const toolCalls: ToolCallRequest[] = [];
      for (const block of j.content ?? []) {
        if (block.type === "text") content += block.text;
        if (block.type === "tool_use") {
          toolCalls.push({ id: String(block.id ?? ""), name: String(block.name ?? ""), args: safeParseArgs(block.input) });
        }
      }
      return { content, toolCalls };
    },
  };
}
