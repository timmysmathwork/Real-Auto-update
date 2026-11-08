// Supabase Edge Function: ai-chat
// Provider keys are configured in Supabase Function secrets, never in the browser.
// This function requires a signed-in Supabase user. Gateway JWT verification must remain enabled.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const MAX_BODY_BYTES = 24 * 1024;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 1_000;
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 24 * 60 * 60;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const origin = req.headers.get("origin");
  const allowedOrigin = Deno.env.get("SITE_ORIGIN");
  if (allowedOrigin && origin && origin !== allowedOrigin) return json({ error: "Origin not allowed" }, 403);

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in to use chat." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Chat service is not configured." }, 503);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Sign in to use chat." }, 401);

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: { provider?: unknown; messages?: unknown };
  try { body = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON." }, 400); }

  const provider = body.provider;
  if (provider !== "freeai" && provider !== "zai") return json({ error: "Provider must be freeai or zai." }, 400);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES) {
    return json({ error: `Send between 1 and ${MAX_MESSAGES} messages.` }, 400);
  }

  let totalChars = 0;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== "object" || !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string") {
      return json({ error: "Each message must contain a supported role and text content." }, 400);
    }
    const content = item.content.trim();
    if (!content || content.length > MAX_MESSAGE_CHARS) return json({ error: "A message is empty or too long." }, 400);
    totalChars += content.length;
    messages.push({ role: item.role, content });
  }
  if (totalChars > MAX_TOTAL_CHARS) return json({ error: "Conversation is too long. Start a new chat." }, 413);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rateAllowed, error: rateError } = await admin.rpc("consume_ai_chat_rate_limit", {
    p_user_id: user.id,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (rateError) {
    console.error("AI rate-limit check failed", rateError.message);
    return json({ error: "Chat protection is unavailable. Try again later." }, 503);
  }
  if (rateAllowed !== true) return json({ error: "Daily chat limit reached. Try again tomorrow." }, 429);

  const apiKey = Deno.env.get(provider === "freeai" ? "FREE_AI_API_KEY" : "ZAI_API_KEY");
  if (!apiKey) return json({ error: `${provider === "freeai" ? "Free.ai" : "z.ai"} is not configured.` }, 503);

  const endpoint = provider === "freeai"
    ? "https://api.free.ai/v1/chat/"
    : "https://api.z.ai/api/paas/v4/chat/completions";
  const model = provider === "freeai" ? "qwen7b" : "glm-5.3";
  const providerBody = provider === "freeai"
    ? { model, messages, stream: false, max_tokens: MAX_OUTPUT_TOKENS }
    : { model, messages, stream: false, max_tokens: MAX_OUTPUT_TOKENS };

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(providerBody),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    console.error("AI provider request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "The AI provider could not be reached. Try again." }, 502);
  }

  if (!upstream.ok) {
    console.error("AI provider returned an error", provider, upstream.status);
    return json({ error: "The AI provider could not complete the request." }, 502);
  }

  let result: any;
  try { result = await upstream.json(); } catch { return json({ error: "The AI provider returned an invalid response." }, 502); }
  const answer = result?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) return json({ error: "The AI provider returned no text." }, 502);
  return json({ answer });
});
