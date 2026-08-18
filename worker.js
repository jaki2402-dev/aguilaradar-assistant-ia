// Relais IA gratuit pour l'Assistant AguilaRadar — Cloudflare Worker + Workers AI.
//
// Rôle unique : recevoir { question, context } (le contexte = données réelles déjà calculées
// par le site, construites par buildAiContext() dans js/assistant.js), demander au modèle de
// répondre STRICTEMENT à partir de ce contexte, renvoyer { answer }. Aucune clé API à gérer :
// Workers AI (binding env.AI) est natif à Cloudflare, gratuit dans les limites du palier
// gratuit du compte. Syntaxe vérifiée le 18/08/2026 contre la documentation Cloudflare à jour
// (developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct/).
//
// Déploiement : voir cloudflare-worker/README.md pour les étapes exactes (dashboard, aucune
// ligne de commande nécessaire). Après déploiement, reporter l'URL obtenue dans
// AI_RELAY_URL (js/config.js) à la place du placeholder.
//
// Volontairement minimal, une seule responsabilité — même principe que les routines
// AguilaRadar existantes (voir CLAUDE.md) : ne fait qu'un relais IA, rien d'autre.

const ALLOWED_ORIGIN = "https://jaki2402-dev.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

const SYSTEM_PROMPT_PREFIX =
  "Tu es l'assistant du site AguilaRadar, un radar de marché crypto. Réponds UNIQUEMENT à partir " +
  "des données ci-dessous — jamais un prix, un fait ou un verdict qui n'y figure pas explicitement. " +
  "Si les données ne permettent pas de répondre à la question, dis-le clairement plutôt que " +
  "d'inventer. Jamais de conseil d'investissement réglementé (\"achète\", \"vends\", \"place ton " +
  "argent sur\") — analyse informative uniquement. Réponds en français, 5 phrases maximum.\n\n" +
  "Données actuelles du site :\n";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid_json" }, 400);
    }

    const question = String(body.question || "").slice(0, 500).trim();
    const context = String(body.context || "").slice(0, 6000);
    if (!question) return json({ error: "empty_question" }, 400);

    try {
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          { role: "system", content: SYSTEM_PROMPT_PREFIX + (context || "(aucune donnée fournie ce tour-ci)") },
          { role: "user", content: question },
        ],
        max_tokens: 400,
      });
      return json({ answer: (result && result.response) || "" }, 200);
    } catch (e) {
      return json({ error: "ai_error" }, 500);
    }
  },
};
