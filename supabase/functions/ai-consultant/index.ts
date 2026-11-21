// AI Financial Consultant Edge Function
//
// Proxies user messages to an AI provider chosen automatically by the Finora
// AI Hub router: the router classifies the question, picks the best available
// model (secret configured + adapter registered), and falls back to the next
// candidate on transient failures. API keys never reach the browser.
// Authenticates via the Supabase JWT, enforces a per-user daily message
// limit, reads the user's financial data directly from Supabase (Financial
// Context Builder + Financial Engine), and persists all messages to
// ai_conversations/ai_messages so conversation history is maintained.
//
// If no provider secret is configured, or every provider fails, the function
// returns a 502 with aiUnavailable so the frontend can inform the user — it
// never pretends to work.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { AiProviderError } from "../_shared/ai/errors.ts";
import { chatWithRouting } from "../_shared/ai/router.ts";
import type { AiChatResponse, AiMessage } from "../_shared/ai/types.ts";
import { buildFinancialContext, formatFinancialContext } from "../_shared/financial/builder.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_DAILY_MESSAGES = 30;
const SYSTEM_PROMPT = `Anda adalah Konsultan Keuangan AI Finora — asisten keuangan pribadi yang membantu pengguna berbahasa Indonesia.

PRINSIP KERJA:
1. Jawab selalu dalam bahasa Indonesia yang natural dan mudah dipahami.
2. Anda adalah pendidik keuangan, BUKAN penasihat keuangan berizin (regulated financial advisor). Selalu klarifikasi: "Ini adalah edukasi keuangan, bukan saran dari penasihat keuangan berizin."
3. JANGAN PERNAH menjamin imbal hasil investasi. Gunakan kata "diperkirakan" atau "berpotensi" untuk proyeksi.
4. JANGAN PERNAH menghitung angka finansial sendiri. Jika pengguna meminta perhitungan, arahkan mereka ke fitur Analisis Keuangan atau Transaksi di Finora. Jika data finansial disertakan dalam pesan atau melalui persetujuan profil, gunakan angka tersebut apa adanya — jangan dibuat-buat angka baru.
5. Jika informasi pengguna tidak lengkap untuk memberikan jawaban relevan, AJUKAN PERTANYAAN KLARIFIKASI terlebih dahulu sebelum memberikan rekomendasi. Jangan berasumsi tentang angka atau situasi yang tidak disebutkan.
6. Berikan rekomendasi langkah demi langkah yang realistis dan dapat ditindaklanjuti.
7. Jika pengguna memberikan data profil finansial (dengan persetujuan), gunakan data tersebut sebagai konteks untuk jawaban yang lebih personal.
8. Ketika membandingkan skenario keuangan (misalnya dua strategi pelunasan utang atau dua pilihan anggaran), gunakan HANYA angka yang telah diverifikasi — yakni angka yang diberikan pengguna atau data profil yang disertakan. Jangan mengarang angka perbandingan. Tampilkan perbandingan dalam struktur yang jelas (tabel atau daftar bersisian) dan jelaskan konsekuensi logis dari masing-masing skenario berdasarkan angka tersebut.
9. Jelaskan masalah keuangan dengan bahasa sederhana sebelum memberikan solusi. Pastikan pengguna memahami akar masalahnya terlebih dahulu.

DATA KEUANGAN PENGGUNA:
- Jika konteks data keuangan disertakan, itu adalah data NYATA yang dibaca langsung dari database Finora. Gunakan angka tersebut apa adanya — JANGAN menghitung ulang, JANGAN mengarang angka baru.
- Nilai "BELUM TERSEDIO (not_provided)" berarti data belum pernah diisi. Data yang belum tersedia BUKAN bernilai nol. JANGAN pernah menyimpulkan bahwa pendapatan, tabungan, utang, atau pengeluaran pengguna bernilai 0 hanya karena datanya tidak ada.
- JANGAN memberikan kesimpulan kesehatan keuangan (sehat/bermasalah) jika data belum mencukupi. Ajukan pertanyaan klarifikasi atau sarankan pengguna mengisi fitur Analisis Keuangan terlebih dahulu.
- Jika pengguna menyebutkan angka sendiri dalam pesan, gunakan angka tersebut untuk diskusi, tetapi tetap arahkan perhitungan resmi ke fitur Analisis Keuangan.

FORMAT JAWABAN:
- Gunakan paragraf singkat dan jelas.
- Untuk langkah-langkah, gunakan penomoran.
- Jika membandingkan skenario, tampilkan dengan struktur yang mudah dibaca (daftar bersisian atau tabel sederhana).
- Jika informasi tidak cukup, mulai dengan pertanyaan klarifikasi sebelum memberikan jawaban.
- Selalu akhiri dengan penegasan bahwa ini adalah edukasi, bukan saran terikat regulasi.`;

interface ChatRequest {
  message: string;
  conversationId?: string;
  /** Consent flag: when true, the backend attaches the user's verified
   *  financial context (read server-side from Supabase). */
  includeProfile?: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }


  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Metode tidak didukung" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ─── 1. Authenticate via JWT ────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Otorisasi diperlukan" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create a supabase client with the user's JWT to verify identity
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Sesi tidak valid. Silakan masuk kembali." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service role client for DB operations (bypasses RLS)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ─── 2. Rate limiting: count messages today ────────────────
    const today = new Date().toISOString().split("T")[0];
    const { count: todayCount } = await adminClient
      .from("ai_messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", `${today}T00:00:00Z`);

    if ((todayCount ?? 0) >= MAX_DAILY_MESSAGES) {
      return new Response(
        JSON.stringify({
          error: `Batas harian tercapai. Anda telah mengirim ${MAX_DAILY_MESSAGES} pesan hari ini. Coba lagi besok.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── 3. Parse request body ─────────────────────────────────
    const body: ChatRequest = await req.json();
    const { message, conversationId, includeProfile } = body;

    if (!message || !message.trim()) {
      return new Response(
        JSON.stringify({ error: "Pesan tidak boleh kosong" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── 4. Get or create conversation ─────────────────────────
    let convId = conversationId;
    if (!convId) {
      const title = message.trim().slice(0, 60) + (message.length > 60 ? "..." : "");
      const { data: newConv, error: convError } = await adminClient
        .from("ai_conversations")
        .insert({ user_id: user.id, title })
        .select("id")
        .single();

      if (convError || !newConv) {
        return new Response(
          JSON.stringify({ error: "Gagal membuat percakapan" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      convId = newConv.id;
    } else {
      // Verify ownership
      const { data: conv } = await adminClient
        .from("ai_conversations")
        .select("id, user_id")
        .eq("id", convId)
        .maybeSingle();

      if (!conv || conv.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: "Percakapan tidak ditemukan" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── 5. Save user message ──────────────────────────────────
    await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "user",
        content: message.trim(),
      });

    // ─── 6. Fetch conversation history (last 20 messages) ──────
    const { data: history } = await adminClient
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

    // ─── 7. Build messages array for AI API ────────────────────
    const messages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // If user consented, read their verified financial data server-side and
    // run it through the Financial Engine. Frontend-supplied numbers are
    // never used as an analysis source.
    if (includeProfile) {
      const financialContext = await buildFinancialContext(adminClient, user.id);
      messages.push({ role: "system", content: formatFinancialContext(financialContext) });
    }

    // Append conversation history
    for (const msg of history ?? []) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // ─── 8. Call AI via the router: classify → route → fallback ─
    // Collect which provider secrets exist so the router only considers
    // providers that are actually configured. Keys themselves stay in env —
    // only their presence is recorded here.
    const providerSecrets: Record<string, string | undefined> = {
      openai: Deno.env.get("OPENAI_API_KEY"),
      gemini: Deno.env.get("GEMINI_API_KEY"),
      anthropic: Deno.env.get("ANTHROPIC_API_KEY"),
      groq: Deno.env.get("GROQ_API_KEY"),
      openrouter: Deno.env.get("OPENROUTER_API_KEY"),
      deepseek: Deno.env.get("DEEPSEEK_API_KEY"),
      mistral: Deno.env.get("MISTRAL_API_KEY"),
    };

    const aiResult: AiChatResponse & { fallbackTrail: string[] } =
      await chatWithRouting({
        message,
        secrets: providerSecrets,
        messages: messages as AiMessage[],
        maxOutputTokens: 1200,
        temperature: 0.7,
      });

    if (aiResult.fallbackTrail.length > 0) {
      console.warn(`AI router fallback trail: ${aiResult.fallbackTrail.join(" -> ")}`);
    }

    const reply = aiResult.text;

    // ─── 9. Save assistant message ─────────────────────────────
    await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "assistant",
        content: reply,
      });

    // Update conversation timestamp
    await adminClient
      .from("ai_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convId);

    return new Response(
      JSON.stringify({ reply, conversationId: convId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // Provider failures get specific, honest user messages — no secrets,
    // no provider details beyond what the user needs to act on.
    if (err instanceof AiProviderError) {
      console.error(`AI provider error (${err.code}):`, err.message);

      if (err.code === "quota" || err.code === "authentication") {
        return new Response(
          JSON.stringify({
            error:
              "Layanan AI sedang tidak tersedia karena masalah konfigurasi atau kuota. Silakan hubungi administrator.",
            aiUnavailable: true,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const errorMsg =
        err.code === "rate_limit"
          ? "Layanan AI sedang sibuk. Silakan coba lagi dalam beberapa saat."
          : "Terjadi kesalahan saat menghubungi layanan AI. Silakan coba lagi.";

      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Terjadi kesalahan sistem. Silakan coba lagi." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
