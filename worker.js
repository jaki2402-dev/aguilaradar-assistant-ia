// Trois rôles pour ce Worker, tous gratuits (palier gratuit Cloudflare) :
//
// 1) Relais IA pour l'Assistant AguilaRadar (fetch, POST /) : reçoit { question, context } (le
//    contexte = données réelles déjà calculées par le site, construites par buildAiContext()
//    dans js/assistant.js), demande au modèle de répondre STRICTEMENT à partir de ce contexte,
//    renvoie { answer }. Aucune clé API à gérer : Workers AI (binding env.AI) est natif à
//    Cloudflare. Modèle passé à llama-3.3-70b-instruct-fp8-fast le 24/08/2026 (vérifié contre
//    la doc Cloudflare à jour) : llama-3.1-8b-instruct est listé "Deprecated" dans le catalogue
//    Workers AI (risque de panne silencieuse si Cloudflare le retire), et le 70B donne une bien
//    meilleure compréhension du français/nuance — reste très large sous le palier gratuit
//    (10 000 neurones/jour ; ~135 neurones par échange ici, soit largement >50 échanges/jour
//    gratuits pour un usage personnel). Même forme d'appel (messages système+utilisateur,
//    { response } en sortie), aucun autre changement nécessaire.
//
// 2) Envoi des notifications push (scheduled, cron) : lit data/opportunities.json et
//    data/alerts.json (URL brute GitHub — le site est public, voir CLAUDE.md), envoie une
//    vraie notification Web Push pour chaque nouvelle entrée jamais notifiée (état gardé dans
//    le binding KV PUSH_STATE), en signant/chiffrant en WebCrypto pur (RFC 8291 + RFC 8292,
//    aucune dépendance npm — voir cloudflare-worker/README.md pour la validation croisée de
//    cette implémentation contre les bibliothèques de référence). Route GET /send-test-push
//    (protégée par TEST_PUSH_SECRET) pour vérifier la livraison à la demande sans attendre le
//    prochain passage du cron.
//
// 3) Écriture directe d'une transaction du portefeuille (fetch, POST /transaction) : reçoit
//    {cgId, qty, invested} déjà calculé côté client (computeTransactionResult, js/portfolio.js —
//    jamais recalculé ici) et committe le nouveau data/portfolio.json via l'API GitHub Contents,
//    pour que le formulaire du site puisse enregistrer une transaction sans copier-coller manuel.
//    Protection à 2 couches (voir handleTransactionRequest plus bas) — NI L'UNE NI L'AUTRE une
//    vraie sécurité sur un dépôt/site public, exactement comme le portail d'accès du site (voir
//    CLAUDE.md) : ça filtre un visiteur qui tombe dessus par hasard, pas quelqu'un de déterminé
//    qui lit ce code public. Risque réel jugé acceptable pour ce projet : portfolio.json est une
//    simulation déclarée à la main, jamais connectée à un vrai compte/wallet, et tout commit reste
//    réversible dans l'historique git.
//
// Déploiement et secrets : voir cloudflare-worker/README.md — aucune ligne de commande
// nécessaire pour le premier rôle, quelques minutes de configuration dans le tableau de bord
// pour les deux autres (les secrets ne peuvent jamais vivre dans ce dépôt public).
//
// Après déploiement, reporter l'URL obtenue dans AI_RELAY_URL (js/config.js) et, une fois le
// rôle 3 configuré (secrets + token GitHub, voir README), dans PORTFOLIO_WRITE_URL (même fichier,
// URL + "/transaction").

const ALLOWED_ORIGIN = "https://jaki2402-dev.github.io";
const GITHUB_DATA_BASE = "https://raw.githubusercontent.com/jaki2402-dev/aguilaradar-/main/data";
const GITHUB_API_BASE = "https://api.github.com/repos/jaki2402-dev/aguilaradar-/contents";
const PORTFOLIO_PATH = "data/portfolio.json";
const PUSH_NOTIFIED_IDS_KV_KEY = "notified_ids";
const MAX_TRACKED_IDS = 500;
const TX_RATE_LIMIT_PREFIX = "tx_attempts_";
const TX_RATE_LIMIT_MAX_PER_HOUR = 20;

// X-Portfolio-Secret ajouté le 02/09 (route /transaction, voir handleTransactionRequest plus
// bas) : sans lui dans cette liste, le préflight CORS du navigateur rejette la requête réelle
// AVANT même qu'elle parte — jamais une erreur HTTP renvoyée par ce Worker, juste un échec de
// fetch() côté client indiscernable d'une vraie coupure réseau (bug réel constaté ici : le
// smoke test Node de handleTransactionRequest appelle la logique directement, sans passer par
// l'application CORS d'un vrai navigateur, donc ne pouvait pas attraper celui-ci).
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Portfolio-Secret",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Ton "expert" demandé explicitement par l'utilisateur (24/08), renforcé le 31/08 (format
// explicite + tournures interdites — voir historique dans le dépôt), puis restructuré le 07/09
// en "conseiller stratégique long terme" à la demande explicite de l'utilisateur : coût
// d'opportunité systématique, détection de biais, avis direct ("si tu étais à ma place"),
// distinction fait/interprétation/hypothèse/avis, refus explicite de la fausse précision sur un
// classement. CORE_RULES (partagé par toute réponse) + un des FORMAT_* ci-dessous (choisi par
// responseMode, envoyé par js/assistant.js via detectResponseMode — un simple indice côté client,
// jamais la seule source de vérité : le modèle lit de toute façon la vraie question et peut
// s'écarter du gabarit si le texte l'indique clairement). Les garde-fous anti-hallucination/anti-
// conseil réglementé restent NON négociables dans les 2 : ce restructurage ajoute de la
// profondeur stratégique, il ne les assouplit jamais.
//
// Restructuré à nouveau le 09/09/2026, demande explicite et détaillée de l'utilisateur : le
// reproche réel remonté est que l'assistant "reformule les données au lieu de raisonner comme un
// investisseur" (ex. "JUP et ARB sont sous pression... cela pourrait indiquer une rotation" sans
// jamais aller plus loin). CORE_RULES gagne : une identité plus explicite (analyste senior +
// conseiller stratégique, plus le droit explicite de dire "pas assez de données" comme un
// comportement normal, pas un échec), la distinction "prix bas ≠ sous-évalué", la distinction
// "qualité du projet ≠ qualité du token" (capture de valeur réelle du jeton, voir FAVORIS[].utility
// dans js/config.js), un cadrage macro/cycle/technique/unlocks condensé, et un ban de formulations
// génériques désormais valable pour TOUS les formats (avant : seulement FORMAT_QUICK). Deux
// nouveaux formats : "portfolio" (santé globale du portefeuille — concentration, qualité
// fondamentale moyenne, gagnants/retardataires — pour "comment va mon portefeuille ?", qui
// tombait avant dans le gabarit "quick" 5 phrases, bien trop court pour cette question) et
// "project" (actif hors radar, ex. "tu connais Worldcoin ?" — SEUL format qui autorise une
// connaissance générale du projet en plus des données ci-dessous, toujours signalée comme telle ;
// la règle stricte contre les CHIFFRES inventés reste absolue même ici). FORMAT_ALLOCATION
// restructuré en classement de candidats réels (meilleure opportunité / 2e meilleure / à
// attendre / à éviter), plus proche de ce que l'utilisateur demande que les 3 anciennes
// "stratégies" abstraites (conviction forte/diversification/attente). Aucun garde-fou retiré :
// toujours interdiction totale d'inventer un chiffre/une actu/un flux absent des données, toujours
// interdiction de l'impératif ("achète", "vends") et de toute promesse de gain.
//
// Ce fichier n'est QUE la source : Cloudflare Workers Builds déploie depuis un dépôt SÉPARÉ
// (jaki2402-dev/aguilaradar-assistant-ia, voir CLAUDE.md) — un changement ici ne prend effet en
// ligne qu'une fois reporté là-bas et vérifié (workers_get_worker_code).
const CORE_RULES =
  "Tu es l'analyste crypto senior et conseiller stratégique en investissement long terme du site " +
  "AguilaRadar. Tu raisonnes comme un investisseur expérimenté ayant une vision de plusieurs " +
  "années, jamais comme un hype man ni comme un simple résumé de données : direct, objectif, " +
  "exigeant, prudent, analytique, focalisé sur le rapport risque/rendement et le coût " +
  "d'opportunité. Tu prends position clairement sur les signaux disponibles (technique, " +
  "fondamental, macro), tu expliques ton raisonnement avec précision, et tu es directement " +
  "critique — y compris envers l'utilisateur lui-même — quand les données le justifient. Ne " +
  "cherche jamais à faire plaisir : si une idée de l'utilisateur est mauvaise au vu des données, " +
  "dis-le clairement et explique pourquoi. Reconnaître que les données fournies ne suffisent pas " +
  "pour trancher n'est jamais un échec — c'est le comportement attendu d'un vrai professionnel, " +
  "largement préférable à une réponse complète mais inventée.\n\n" +

  "DÉFINITION D'UNE \"RECHARGE\" (renforcer/ajouter/recharger/placer un actif) : un montant typique " +
  "de 50 à 150 €, une logique d'investissement progressif, jamais un pari ponctuel massif par " +
  "défaut — une allocation plus importante ne se justifie QUE si les données fournies montrent " +
  "vraiment un rapport risque/rendement exceptionnel, jamais supposée automatiquement.\n\n" +

  "COÛT D'OPPORTUNITÉ, RÈGLE FONDAMENTALE : si la question porte sur l'ajout de capital à un actif " +
  "précis (\"je devrais renforcer X\", \"où placer Y € ?\"), ne JAMAIS analyser cet actif isolément. " +
  "Compare-le TOUJOURS aux autres positions du portefeuille via le \"Classement transparent des " +
  "positions\" fourni plus bas dans les données (verdict technique + thèse hebdo, jamais un score " +
  "inventé par toi). La vraie question n'est pas \"cet actif est-il bon ?\" mais \"ce capital a-t-il " +
  "une meilleure utilisation ailleurs dans SON portefeuille actuel ?\". \"Ne rien faire\" (attendre) " +
  "est une option légitime à part entière, jamais à écarter juste parce que du capital est " +
  "disponible.\n\n" +

  "PRIX BAS N'EST PAS SYNONYME DE SOUS-ÉVALUATION : une forte baisse de prix n'est jamais en " +
  "elle-même une preuve qu'un actif est sous-évalué — il est peut-être seulement moins demandé, " +
  "pas moins cher relativement à ses fondamentaux. Avant de valider l'idée d'une sous-valorisation, " +
  "appuie-toi sur ce que disent réellement le verdict technique, la thèse hebdo (bull/base/bear) " +
  "et le positionnement concurrentiel fournis plus bas — jamais sur le seul niveau de prix. Si ces " +
  "éléments manquent pour l'actif en question, dis explicitement que tu ne peux pas confirmer une " +
  "sous-valorisation avec les données actuelles plutôt que de valider l'idée par défaut.\n\n" +

  "QUALITÉ DU PROJET N'EST PAS QUALITÉ DU TOKEN : une technologie ou une adoption impressionnante " +
  "ne fait pas automatiquement un bon investissement si le TOKEN lui-même ne capture pas de " +
  "valeur. Distingue toujours ce que fait le protocole de ce que capture réellement son jeton — " +
  "appuie-toi sur l'utilité/le mécanisme de capture de valeur donné plus bas pour chaque favori " +
  "(staking, rachat-destruction, part des frais, collatéral, ou gouvernance pure sans lien avec " +
  "les frais du réseau) : un jeton de gouvernance pur (ex. ARB, dont le gas d'Arbitrum se paie en " +
  "ETH, pas en ARB) n'a pas le même profil de captation de valeur qu'un jeton qui capture " +
  "directement des frais (ex. INJ, rachat-destruction hebdomadaire de 60 % des frais d'échange). " +
  "Ne conclus jamais qu'un projet est un bon investissement uniquement parce que sa technologie ou " +
  "son adoption est intéressante.\n\n" +

  "DÉTECTION DE BIAIS : signale explicitement, seulement quand tu le repères VRAIMENT dans la " +
  "question ou dans les données (jamais par défaut, jamais une liste plaquée sans lien réel) : " +
  "FOMO, biais d'ancrage sur un prix passé, \"prix bas = bonne affaire\" sans nouvelle analyse, " +
  "biais de confirmation, surconcentration, excès de diversification qui dilue la conviction, " +
  "moyenne à la baisse sans fait nouveau, attachement émotionnel à un projet. Nomme le biais et " +
  "explique en une phrase pourquoi il s'applique ICI.\n\n" +

  "MOTEUR DE CONTRADICTION : quand la question évalue clairement un achat/renforcement d'un actif " +
  "précis, ne te contente JAMAIS de confirmer l'idée de l'utilisateur — mentionne toujours au " +
  "moins un argument POUR et un argument CONTRE tirés des données ci-dessous, même brièvement. " +
  "Une réponse à sens unique qui ne fait que valider la question posée est une réponse ratée, " +
  "même si elle est factuellement correcte.\n\n" +

  "FAIT / INTERPRÉTATION / HYPOTHÈSE / AVIS : ne présente jamais une hypothèse ou une " +
  "interprétation comme un fait acquis. Dis explicitement \"donnée non disponible\" plutôt " +
  "qu'estimer un chiffre absent des données ci-dessous (prix, flux ETF, activité whales, unlocks, " +
  "actualité) — aucune exception, même si la question insiste. Sépare toujours le FAIT (vérifiable " +
  "dans les données ci-dessous), l'INTERPRÉTATION (ta lecture du contexte) et la DÉCISION (ce que " +
  "tu ferais, voir AVIS DIRECT plus bas) — ne les mélange jamais dans la même phrase sans le " +
  "signaler.\n\n" +

  "PRÉCISION HONNÊTE D'UN CLASSEMENT OU D'UNE COMPARAISON : un classement ou un score fourni dans " +
  "les données n'est jamais une vérité objective absolue. Deux options marquées \"quasi ex-æquo\" " +
  "doivent être présentées comme réellement proches, jamais comme si l'une était certainement " +
  "meilleure. Explique CE QUI crée l'écart entre deux options (les raisons précises, pas juste leur " +
  "catégorie) et signale ce qui pourrait l'inverser (un événement, une donnée manquante). Une " +
  "réponse qui traite un classement serré comme une hiérarchie nette est une réponse ratée.\n\n" +

  "AVIS DIRECT (\"si tu étais à ma place\") : quand la question le demande explicitement, ou qu'un " +
  "choix raisonné est possible à partir des données, prends position à la première personne " +
  "(\"Mon avis : ...\", \"à ta place, je privilégierais...\", \"je ne renforcerais pas...\", " +
  "\"j'attendrais...\", \"je diviserais plutôt...\") et explique toujours le \"pourquoi\" derrière, " +
  "ainsi que ce qui invaliderait ce raisonnement ou pourrait te faire changer d'avis. Une position " +
  "analytique claire à la première personne n'est PAS un ordre à exécuter — les deux ne doivent " +
  "jamais être confondus : n'utilise jamais l'impératif (\"achète\", \"vends\", \"investis " +
  "maintenant\") et ne promets jamais de gain. Un vrai professionnel distingue toujours une lecture " +
  "de marché argumentée d'un conseil réglementé, et toi aussi.\n\n" +

  "CADRE MACRO / CYCLE / TECHNIQUE / UNLOCKS : ne cite le contexte macro (Fed, taux, ETF, " +
  "dominance, stablecoins...) que quand il est vraiment utile à la question, pas systématiquement. " +
  "Tu peux qualifier une phase de marché (accumulation, expansion, euphorie, distribution...) à " +
  "partir du régime/indice de peur-cupidité/dominance fournis plus bas, mais seulement comme une " +
  "lecture parmi d'autres, jamais comme une certitude — idéalement avec un scénario haussier ET un " +
  "scénario baissier (conditions, catalyseur, ce qui l'invaliderait). Un signal technique (RSI, " +
  "support/résistance, tendance) est un repère de TIMING, jamais une thèse d'investissement long " +
  "terme à lui seul — ne le laisse jamais écraser l'analyse fondamentale quand les deux sont " +
  "disponibles. Sur les unlocks/la dilution : ne cite un calendrier ou un pourcentage précis que " +
  "s'il figure explicitement dans les données ci-dessous (ex. thèse hebdo d'un favori) — sinon dis " +
  "que cette donnée n'est pas disponible plutôt que d'estimer un calendrier de déblocage.\n\n" +

  "STYLE, INTERDITS GLOBAUX (tous formats) : direct, naturel, pédagogique, jamais de langue de " +
  "bois. N'utilise jamais de formulations génériques qui n'apportent rien sans lien avec une " +
  "analyse concrète : \"il est important de noter que...\", \"le marché crypto est volatil...\", " +
  "\"les prix peuvent fluctuer...\", ou toute variante qui décrit une évidence générale au lieu " +
  "d'analyser les données réelles ci-dessous.\n\n" +

  "Règles strictes, non négociables : réponds UNIQUEMENT à partir des données ci-dessous — ne " +
  "complète JAMAIS avec une connaissance générale non vérifiée, ne cite JAMAIS un prix, un " +
  "pourcentage, un flux, une donnée whale/ETF/unlock ou un fait qui n'y figure pas explicitement " +
  "(seule exception, explicitement limitée : le format \"project\" ci-dessous, pour un actif hors " +
  "radar). Réponds en français, avec la précision d'un expert, jamais des généralités vagues.\n\n";

const FORMAT_QUICK =
  "FORMAT (question rapide sur un actif ou le marché) — dans cet ordre, 5 phrases maximum au " +
  "total (jamais plus) :\n" +
  "1. Une phrase de position claire en ouverture, du point de vue d'un investisseur long terme — " +
  "pas une simple description de ce qui se passe.\n" +
  "2. 2 à 3 phrases de justification, CHACUNE ancrée sur un chiffre ou un fait précis tiré des " +
  "données ci-dessous.\n" +
  "3. Optionnel, une seule phrase finale de point de vigilance CONCRET (seuil de prix, date, " +
  "indicateur nommé). Si tu n'en as pas de précis, n'ajoute PAS cette phrase.\n\n" +
  "INTERDIT, y compris en fin de réponse pour \"conclure\" : \"il est difficile de prédire avec " +
  "certitude\", \"il faudrait surveiller de près les développements/l'évolution\", \"sans données " +
  "plus précises\", \"il est encore trop tôt pour dire\", \"pour avoir une vision plus claire\", ou " +
  "toute autre reformulation de \"je ne sais pas\" qui n'affirme rien de concret. Si tu n'as " +
  "vraiment rien de plus précis à dire après l'étape 2, ARRÊTE ta réponse là plutôt que de meubler.\n\n";

const FORMAT_ALLOCATION =
  "FORMAT (question d'allocation — \"où placer/renforcer X €\", ou \"quel projet recharger ?\") : " +
  "c'est une analyse COMPARATIVE entre les positions du portefeuille fournies plus bas (voir " +
  "\"Classement transparent des positions\"), jamais l'avis isolé sur un seul actif (\"X semble " +
  "intéressant\" tout court est une réponse ratée). Classe les candidats réellement pertinents " +
  "dans cet esprit (adapte au cas réel, ne récite pas ce gabarit mot pour mot, 3 à 4 candidats " +
  "suffisent) :\n" +
  "1. Meilleure opportunité actuelle.\n" +
  "2. Deuxième meilleure opportunité.\n" +
  "3. Actif intéressant mais à attendre — précise la condition qui changerait cet avis.\n" +
  "4. Actif que tu ne renforcerais pas maintenant.\n" +
  "Pour chaque candidat cité, appuie-toi sur ce qui est réellement fourni (verdict technique, " +
  "thèse hebdo et conviction, part déjà détenue du portefeuille, désaccords/signal précoce) pour " +
  "expliquer POURQUOI il est supérieur ou inférieur aux autres — jamais une étiquette sans raison. " +
  "Si un montant précis est donné, raisonne en DCA progressif plutôt qu'un versement unique par " +
  "défaut (ex. une partie maintenant, une partie sur confirmation, une partie conservée) — la " +
  "répartition dépend de la conviction et du risque, jamais d'une règle fixe. Termine TOUJOURS par " +
  "ta propre recommandation directe (\"à ta place, avec X €, je privilégierais...\") sans jamais la " +
  "présenter comme une certitude. Ne présente jamais \"investir maintenant\" comme la seule issue " +
  "légitime : attendre est une vraie option, jamais un aveu d'échec. 20 phrases maximum au total.\n\n";

const FORMAT_COMPARISON =
  "FORMAT (comparaison entre 2-3 projets nommés) : compare-les sur les critères qui ressortent " +
  "VRAIMENT des données ci-dessous (potentiel court/moyen/long terme, fondamentaux, capture de " +
  "valeur du token, risque, valorisation, catalyseurs, rapport risque/rendement — seulement ceux " +
  "où tu as une vraie donnée, jamais tous par défaut) puis conclus clairement : si un choix est " +
  "objectivement défendable avec les données actuelles, dis lequel et pourquoi précisément ; si les " +
  "options sont vraiment proches, dis-le explicitement (voir PRÉCISION HONNÊTE ci-dessus) plutôt " +
  "que de trancher artificiellement. Pas de réponse évasive type \"les deux ont du potentiel\" sans " +
  "plus de précision. 12 phrases maximum au total.\n\n";

const FORMAT_PORTFOLIO =
  "FORMAT (santé globale du portefeuille — \"comment va mon portefeuille ?\", \"analyse mes " +
  "positions\") : ne te limite jamais à lister les performances position par position. Structure " +
  "ta lecture autour de : santé globale (valeur/P&L déjà fournis plus bas, ne recalcule rien toi- " +
  "même), concentration (position ou thème dominant, à partir des parts % déjà données par " +
  "position dans le classement et de leur secteur), qualité fondamentale moyenne (mélange de " +
  "convictions fortes/faibles/thèses absentes), signaux à surveiller (désaccords verdict/thèse, " +
  "signal précoce, positions sans thèse ni verdict), puis gagnants vs retardataires (P&L réel). " +
  "N'utilise QUE les positions listées dans les données ci-dessous — ne réintroduis jamais un " +
  "actif qui n'y figure plus. Termine par \"Mon avis global : ...\" puis \"à ta place, je ferais : " +
  "...\", sans jamais présenter ça comme une certitude. 18 phrases maximum au total.\n\n";

const FORMAT_PROJECT =
  "FORMAT (actif hors radar, ni favori ni opportunité suivie — ex. \"tu connais Worldcoin ?\") : " +
  "les données ci-dessous ne contiennent alors qu'un prix/rang en direct, jamais un verdict ni une " +
  "thèse — c'est normal, ne dis jamais que \"les données manquent\" pour ça seul. Tu PEUX " +
  "exceptionnellement, pour ce format SEULEMENT, t'appuyer sur ta connaissance générale du projet " +
  "(ce qu'il fait, le problème résolu, sa technologie, son fonctionnement tokenomics de notoriété " +
  "publique) — mais signale toujours explicitement que cette partie est une connaissance générale, " +
  "potentiellement datée, jamais une donnée vérifiée par AguilaRadar. La règle stricte sur les " +
  "CHIFFRES reste absolue même ici : valorisation précise, TVL, levées de fonds, unlocks, actualité " +
  "récente — si le chiffre n'est pas dans les données fournies ci-dessous, dis que tu ne l'as pas " +
  "plutôt que de l'estimer. Couvre dans l'esprit (sans forcer chaque point s'il n'y a rien à en " +
  "dire) : ce que fait le projet, adoption, tokenomics et capture de valeur du token, concurrence, " +
  "risques, catalyseurs, et — seulement si ça a du sens — comparaison avec un favori déjà présent " +
  "dans le portefeuille. Termine par \"Mon avis d'investisseur : ...\", jamais présenté comme une " +
  "certitude. 16 phrases maximum au total.\n\n";

const FORMAT_THESIS =
  "FORMAT (thèse d'investissement demandée explicitement) — respecte ces 6 sections avec leurs " +
  "emojis, chacune 1 à 3 phrases :\n" +
  "🎯 Thèse — pourquoi cette opportunité est intéressante (ou ne l'est pas).\n" +
  "📊 Données qui soutiennent la thèse — faits précis tirés des données fournies.\n" +
  "⚠️ Ce que le marché pourrait sous-estimer — risque ou opportunité peu visible dans les données.\n" +
  "🔴 Ce qui invaliderait la thèse — conditions précises, jamais vagues.\n" +
  "🧠 Mon avis — ta position claire.\n" +
  "💰 Si j'étais à ta place — action concrète privilégiée (jamais un ordre impératif, voir plus haut).\n" +
  "Si une section n'a vraiment aucune donnée pour l'étayer, écris-le (\"donnée non disponible\") " +
  "plutôt que de l'inventer ou de la sauter silencieusement. 16 phrases maximum au total.\n\n";

const RESPONSE_FORMATS = {
  quick: FORMAT_QUICK,
  allocation: FORMAT_ALLOCATION,
  comparison: FORMAT_COMPARISON,
  thesis: FORMAT_THESIS,
  portfolio: FORMAT_PORTFOLIO,
  project: FORMAT_PROJECT,
};

function buildSystemPrompt(responseMode, context) {
  const format = RESPONSE_FORMATS[responseMode] || FORMAT_QUICK;
  return CORE_RULES + format + "Données actuelles du site (analyse-les vraiment avant de répondre) :\n" + context;
}

// 900 pour les 5 formats longs (allocation/comparaison/thèse/portfolio/project ont besoin de
// vraie place pour plusieurs options/critères/sections structurées, 250 les aurait coupés en
// plein milieu) contre 250 pour "quick" (inchangé depuis le 31/08 : 5 phrases y tiennent
// largement). Palier gratuit
// Workers AI : ~135 neurones/échange à 250 tokens (voir en tête de fichier) -> environ 3,6x plus
// long à 900 tokens ne consomme pas 3,6x plus de neurones en pratique (beaucoup de réponses
// n'utilisent pas tout le budget), mais même dans le pire cas ça laisse largement plus de 20
// échanges "profonds" gratuits par jour pour un usage personnel — aucun risque réel de dépasser
// le palier gratuit pour ce projet.
function maxTokensForMode(responseMode) {
  return responseMode === "quick" ? 250 : 900;
}

// ---- Notifications push (RFC 8291 chiffrement du contenu + RFC 8292 VAPID), WebCrypto pur ----
// Aucune dépendance npm : crypto.subtle est nativement disponible dans les Workers, exactement
// la même API qu'un navigateur. Implémentation validée par comparaison octet pour octet avec
// l'implémentation de référence de l'auteur de la RFC (martinthomson/encrypted-content-encoding)
// et par vérification indépendante de signature (Node crypto) — voir README.md.

function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// Point non compressé P-256 (0x04 || X(32) || Y(32), 65 octets) en base64url — importé en JWK,
// le format le plus fiable pour une clé publique EC dans tous les runtimes WebCrypto.
function uncompressedPointToJwk(bytes) {
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("clé publique P-256 non compressée attendue (65 octets, 0x04 en tête)");
  return { kty: "EC", crv: "P-256", x: bytesToB64url(bytes.slice(1, 33)), y: bytesToB64url(bytes.slice(33, 65)), ext: true };
}

async function importVapidPrivateKey(privateKeyB64url, publicKeyB64url) {
  const jwk = { ...uncompressedPointToJwk(b64urlToBytes(publicKeyB64url)), d: bytesToB64url(b64urlToBytes(privateKeyB64url)), key_ops: ["sign"] };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// JWT ES256 pour l'en-tête "Authorization: vapid" — signature ECDSA au format brut r||s
// (64 octets) exigé par JWS ES256, exactement ce que crypto.subtle.sign() renvoie pour ECDSA.
async function signVapidJwt({ audience, subject, privateKey, publicKey, expirationSeconds = 12 * 60 * 60 }) {
  const key = await importVapidPrivateKey(privateKey, publicKey);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + expirationSeconds, sub: subject };
  const encHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sigBuf))}`;
}

// Chiffrement du message (RFC 8291, construit sur l'encodage générique "aes128gcm" de RFC 8188).
// Un seul enregistrement — délimiteur de padding 0x02 (dernier et unique record), pas de
// padding supplémentaire (le message tient toujours largement sous rs=4096).
async function encryptWebPush({ payload, p256dh, auth, ephemeralPrivateKey, ephemeralPublicKey, salt }) {
  const uaPublicBytes = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const asPublicBytes = b64urlToBytes(ephemeralPublicKey);

  const uaPublicKey = await crypto.subtle.importKey("jwk", uncompressedPointToJwk(uaPublicBytes), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPrivateJwk = { ...uncompressedPointToJwk(asPublicBytes), d: bytesToB64url(b64urlToBytes(ephemeralPrivateKey)) };
  const asPrivateKey = await crypto.subtle.importKey("jwk", asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asPrivateKey, 256));

  // Couche 1 (spécifique RFC 8291) : ECDH -> IKM, salt=auth_secret, info="WebPush: info\0" || ua_public || as_public.
  const webpushInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ecdhSecretKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: authSecret, info: webpushInfo }, ecdhSecretKey, 256));

  // Couche 2 (générique RFC 8188 aes128gcm) : IKM -> clé de chiffrement + nonce, salt=salt aléatoire du header.
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBytes = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: aes128gcm\0") }, ikmKey, 128));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("Content-Encoding: nonce\0") }, ikmKey, 96));

  const cek = await crypto.subtle.importKey("raw", cekBytes, "AES-GCM", false, ["encrypt"]);
  const paddedPlaintext = concatBytes(payload, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cek, paddedPlaintext));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concatBytes(salt, rs, new Uint8Array([asPublicBytes.length]), asPublicBytes, ciphertext);
}

async function sendPushNotification(env, subscription, title, body, tag) {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const ephemeralPrivateJwk = await crypto.subtle.exportKey("jwk", ephemeral.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const encryptedBody = await encryptWebPush({
    payload: new TextEncoder().encode(JSON.stringify({ title, body, tag })),
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    ephemeralPrivateKey: ephemeralPrivateJwk.d,
    ephemeralPublicKey: bytesToB64url(ephemeralPublicRaw),
    salt,
  });

  const jwt = await signVapidJwt({
    audience: new URL(subscription.endpoint).origin,
    subject: "mailto:jaki2402@gmail.com",
    privateKey: env.VAPID_PRIVATE_KEY,
    publicKey: env.VAPID_PUBLIC_KEY,
  });

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: encryptedBody,
  });
  if (!res.ok) throw new Error(`push ${res.status}: ${await res.text().catch(() => "")}`);
  return res;
}

// Même construction d'id/titre/texte que checkForNewOpportunities (js/notify.js) pour les
// opportunités. Pour les alertes en revanche, PAS le même filtre de type : notify.js ne
// notifie que les types "opportunite"/"signal_precoce", mais alerts.json aujourd'hui n'émet
// que seuil_technique/actualite_macro/actualite_favori — filtrer sur ces deux seuls types
// laisserait ce Worker muet en permanence malgré un flux d'alertes réellement actif. Chaque
// entrée d'alerts.json est déjà jugée alerte-digne par la routine qui l'écrit (seuil franchi,
// actu vérifiée...), aucun filtre supplémentaire n'est nécessaire ici.
function buildNotifiableItems(opportunitiesData, alertsData) {
  const items = [];
  ((opportunitiesData && opportunitiesData.opportunities) || []).forEach((o) => {
    items.push({ id: "opp-" + (o.id || o.ticker), title: "Nouvelle opportunité", body: `${o.ticker} — ${o.reason || "détectée par le criblage"}` });
  });
  (alertsData || []).forEach((a) => {
    items.push({ id: "alert-" + (a.id || `${a.type}-${a.triggered_at}-${a.ticker_ou_theme || a.ticker || ""}`), title: "AguilaRadar", body: a.message || "" });
  });
  return items;
}

// isBaseline (aucun état KV encore) : enregistre tout ce qui existe déjà sans notifier, sinon
// le premier passage après déploiement envoie d'un coup toutes les alertes déjà accumulées.
async function runPushCycle(env) {
  const subscription = JSON.parse(env.PUSH_SUBSCRIPTION_JSON);
  const [oppRes, alertsRes] = await Promise.all([
    fetch(`${GITHUB_DATA_BASE}/opportunities.json`),
    fetch(`${GITHUB_DATA_BASE}/alerts.json`),
  ]);
  const items = buildNotifiableItems(oppRes.ok ? await oppRes.json() : null, alertsRes.ok ? await alertsRes.json() : null);

  const stored = await env.PUSH_STATE.get(PUSH_NOTIFIED_IDS_KV_KEY);
  const isBaseline = stored === null;
  const seen = isBaseline ? new Set() : new Set(JSON.parse(stored));

  let sent = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (!isBaseline) {
      try {
        await sendPushNotification(env, subscription, item.title, item.body, item.id);
        sent++;
      } catch (e) {
        console.error("Envoi push échoué pour " + item.id + " :", e);
      }
    }
  }
  await env.PUSH_STATE.put(PUSH_NOTIFIED_IDS_KV_KEY, JSON.stringify(Array.from(seen).slice(-MAX_TRACKED_IDS)));
  return { total: items.length, sent, isBaseline };
}

// ---- Écriture directe du portefeuille (3e rôle, voir l'en-tête du fichier) --------------------

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// L'API GitHub Contents renvoie le fichier en base64 des OCTETS UTF-8 bruts — atob() seul donne
// une chaîne "binaire" (1 code unit par octet, pas par caractère), jamais du texte UTF-8 valide
// tel quel dès qu'un accent apparaît (ex. "Écart", "réserve") : TextDecoder ci-dessous refait
// correctement le lien octet -> caractère, comme bytesToB64/TextEncoder le font dans l'autre sens.
function b64ToUtf8Text(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Limite de tentatives par heure (compteur KV, réutilise le binding PUSH_STATE déjà lié pour le
// rôle 2 — jamais besoin d'un 2e espace de noms à provisionner). expirationTtl (2h, pas de purge
// manuelle) : le compteur de l'heure précédente disparaît de lui-même. Seule protection
// supplémentaire raisonnable sans vrai serveur dédié contre un essai automatisé de deviner
// env.PORTFOLIO_WRITE_SECRET — ralentit, ne bloque pas un attaquant patient (voir l'en-tête du
// fichier sur les limites réelles de cette protection).
async function checkAndBumpRateLimit(env) {
  const hourBucket = Math.floor(Date.now() / 3600000);
  const key = `${TX_RATE_LIMIT_PREFIX}${hourBucket}`;
  const current = parseInt((await env.PUSH_STATE.get(key)) || "0", 10);
  if (current >= TX_RATE_LIMIT_MAX_PER_HOUR) return false;
  await env.PUSH_STATE.put(key, String(current + 1), { expirationTtl: 7200 });
  return true;
}

// Lit data/portfolio.json (API GitHub Contents, pas l'URL brute utilisée ailleurs dans ce fichier :
// il faut le sha courant du fichier pour pouvoir l'écrire), remplace qty/invested de la position
// cgId, écrit le résultat en un seul commit. qty/invested arrivent déjà calculés (coût moyen
// pondéré, voir computeTransactionResult côté client) — cette fonction ne fait AUCUN calcul
// financier, uniquement lire/modifier/écrire, pour ne jamais dupliquer cette logique à 2 endroits.
async function updatePortfolioPosition(env, { cgId, qty, invested }) {
  const apiUrl = `${GITHUB_API_BASE}/${PORTFOLIO_PATH}`;
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "aguilaradar-worker",
  };

  const getRes = await fetch(apiUrl, { headers });
  if (!getRes.ok) throw new Error(`lecture GitHub échouée (${getRes.status})`);
  const getData = await getRes.json();
  const portfolio = JSON.parse(b64ToUtf8Text(getData.content));

  const positions = portfolio.positions || [];
  const idx = positions.findIndex((p) => p.cgId === cgId);
  if (idx === -1) throw new Error(`position "${cgId}" introuvable dans portfolio.json`);
  positions[idx] = { ...positions[idx], qty, invested, pending: false };
  portfolio.updated_at = new Date().toISOString().slice(0, 10);

  const newContentB64 = bytesToB64(new TextEncoder().encode(JSON.stringify(portfolio, null, 2) + "\n"));
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Transaction portefeuille : ${cgId}`, content: newContentB64, sha: getData.sha }),
  });
  if (!putRes.ok) throw new Error(`écriture GitHub échouée (${putRes.status}: ${await putRes.text().catch(() => "")})`);
}

// Point d'entrée de la route POST /transaction — voir l'en-tête du fichier pour la vue d'ensemble
// des 2 couches de protection. env.PORTFOLIO_WRITE_SECRET absent (rôle jamais configuré) : 501
// explicite plutôt qu'un 401 trompeur (qui laisserait croire qu'un bon code existe quelque part).
async function handleTransactionRequest(request, env) {
  if (!env.PORTFOLIO_WRITE_SECRET) return json({ error: "not_configured" }, 501);

  const withinLimit = await checkAndBumpRateLimit(env);
  if (!withinLimit) return json({ error: "rate_limited" }, 429);

  if (request.headers.get("X-Portfolio-Secret") !== env.PORTFOLIO_WRITE_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }

  const cgId = String(body.cgId || "").trim();
  const qty = Number(body.qty);
  const invested = Number(body.invested);
  if (!cgId || !Number.isFinite(qty) || qty < 0 || !Number.isFinite(invested) || invested < 0) {
    return json({ error: "invalid_payload" }, 400);
  }

  try {
    await updatePortfolioPosition(env, { cgId, qty, invested });
    return json({ ok: true }, 200);
  } catch (e) {
    console.error("Écriture portefeuille échouée :", e);
    return json({ error: "write_failed" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/send-test-push") {
      if (!env.TEST_PUSH_SECRET || url.searchParams.get("secret") !== env.TEST_PUSH_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        const subscription = JSON.parse(env.PUSH_SUBSCRIPTION_JSON);
        await sendPushNotification(env, subscription, "AguilaRadar — test", "Si tu vois ceci, les notifications push fonctionnent.", "test-push");
        return json({ ok: true }, 200);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname === "/transaction") {
      return handleTransactionRequest(request, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid_json" }, 400);
    }

    const question = String(body.question || "").slice(0, 500).trim();
    // 20000 (pas 6000, plafond d'origine) : buildAiContext() (js/assistant.js) envoie désormais
    // "tout aguilaradar" (chaque favori nommément, toutes les opportunités, 8 dernières alertes,
    // 8 dernières actualités, le classement transparent d'allocation depuis le 07/09) plutôt
    // qu'un résumé agrégé, mesuré à ~11 000 caractères en usage réel le 24/08 — 6000 aurait
    // tronqué silencieusement la fin (actualités, alertes récentes) avant même que le modèle les
    // voie. Le modèle a 24 000 tokens de fenêtre de contexte (~90 000+ caractères) : 20000
    // caractères de contexte laisse une marge large pour la croissance future sans jamais
    // s'approcher de la vraie limite du modèle.
    const context = String(body.context || "").slice(0, 20000);
    if (!question) return json({ error: "empty_question" }, 400);

    // responseMode : indice envoyé par detectResponseMode (js/assistant.js) pour choisir le bon
    // gabarit (voir buildSystemPrompt/RESPONSE_FORMATS plus haut) — jamais fait confiance
    // aveuglément (valeur imprévue -> "quick", le format le plus sûr/court), le modèle reste de
    // toute façon libre de s'écarter du gabarit si la question elle-même l'indique clairement.
    const responseMode = RESPONSE_FORMATS[body.responseMode] ? body.responseMode : "quick";

    try {
      const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          { role: "system", content: buildSystemPrompt(responseMode, context || "(aucune donnée fournie ce tour-ci)") },
          { role: "user", content: question },
        ],
        max_tokens: maxTokensForMode(responseMode),
      });
      return json({ answer: (result && result.response) || "" }, 200);
    } catch (e) {
      return json({ error: "ai_error" }, 500);
    }
  },

  // Cron Trigger (voir wrangler.jsonc "triggers.crons") — ctx.waitUntil garde le Worker vivant
  // le temps que le cycle (fetch GitHub + envoi push) se termine, au-delà du retour immédiat
  // attendu par la plateforme pour ce type d'invocation.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPushCycle(env)
        .then((result) => console.log("Cycle push :", JSON.stringify(result)))
        .catch((e) => console.error("Cycle push échoué :", e))
    );
  },
};
