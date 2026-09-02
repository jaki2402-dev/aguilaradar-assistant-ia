# Relais IA gratuit — déploiement

Ce Worker donne à l'Assistant du site un vrai modèle d'IA en dernier recours, sans payer et sans
exposer de clé API publiquement (voir `CLAUDE.md` pour pourquoi une clé dans le code du site
serait dangereuse).

## En un clic

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jaki2402-dev/aguilaradar-/tree/main/cloudflare-worker)

1. Clique le bouton ci-dessus (ou [ce lien](https://deploy.workers.cloudflare.com/?url=https://github.com/jaki2402-dev/aguilaradar-/tree/main/cloudflare-worker)).
2. Connecte-toi (ou crée un compte Cloudflare gratuit si tu n'en as pas).
3. Cloudflare copie ces fichiers dans un nouveau dépôt sur ton propre compte GitHub, provisionne
   automatiquement la liaison Workers AI (déclarée dans `wrangler.jsonc`), et déploie — aucune
   étape manuelle supplémentaire.
4. Une fois déployé, copie l'URL du Worker affichée (ressemble à
   `https://aguilaradar-assistant-ia.<ton-compte>.workers.dev`) et donne-la à Claude, ou colle-la
   toi-même dans `js/config.js` à la place de `AI_RELAY_URL`.

C'est tout — pas de code à copier-coller à la main, pas de binding à ajouter manuellement.

## Si le bouton ne marche pas (déploiement manuel)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Créer** →
   **Créer un Worker**.
2. Donne-lui un nom → **Déployer** (le contenu par défaut n'importe pas, remplacé ensuite).
3. **Modifier le code** → sélectionne tout → colle le contenu de `worker.js` (ce dossier) →
   **Déployer**.
4. **Paramètres** → **Liaisons** → **Ajouter** → **Workers AI** → nom de variable `AI`
   (exactement ce nom, en majuscules) → **Déployer**.
5. Copie l'URL en haut de la page du Worker.

## Vérifier que ça marche

Dans l'Assistant du site, pose une question qui ne correspond à rien de suivi (ex. "raconte-moi
une blague sur le bitcoin"). Avant : message générique "je réponds à partir de ce que le radar a
déjà analysé...". Après : une vraie réponse générée, avec la mention "(Réponse générée par IA...)"
à la fin pour la distinguer d'un verdict vérifié du moteur.

## Si quelque chose ne va pas

Le chat ne casse jamais à cause de ça : si le Worker n'est pas encore configuré, mal configuré,
ou en panne, l'Assistant retombe silencieusement sur son comportement actuel (aucune régression
possible, voir `fetchLiveAiFallback` dans `js/assistant.js`). Pas de panique si quelque chose
coince pendant la mise en place.

## Notifications push (deuxième rôle de ce même Worker)

Le même Worker déployé ci-dessus lit `data/opportunities.json` et `data/alerts.json` toutes les
15 minutes (Cron Trigger) et envoie une vraie notification Web Push — reçue même app/onglet
fermé — pour chaque nouvelle entrée jamais notifiée. Chiffrement (RFC 8291) et signature VAPID
(RFC 8292) en WebCrypto pur, aucune dépendance à installer.

**Pourquoi des étapes manuelles ici, contrairement au relais IA ci-dessus** : ce Worker a
besoin de secrets véritables (clé privée VAPID, abonnement push) — des valeurs qui ne peuvent
jamais vivre dans ce dépôt public, donc jamais dans le flux "Deploy to Cloudflare" automatique.
3 minutes de configuration dans le tableau de bord, une seule fois.

1. **Redéployer le code** : Worker → **Modifier le code** → sélectionne tout → colle le contenu
   à jour de `worker.js` → **Déployer**.
2. **Lier le KV déjà créé** : **Paramètres** → **Liaisons** → **Ajouter** → **Espace de noms
   KV** → nom de variable `PUSH_STATE` (exactement ce nom) → sélectionne l'espace de noms
   `aguilaradar-push-state` → **Déployer**.
3. **Ajouter le Cron Trigger** : **Paramètres** → **Déclencheurs** → **Cron Triggers** →
   **Ajouter** → `*/15 * * * *` → **Ajouter**.
4. **Ajouter les 4 secrets** : **Paramètres** → **Variables et secrets** → **Ajouter**, type
   **Secret**, une fois pour chacun de `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`,
   `PUSH_SUBSCRIPTION_JSON`, `TEST_PUSH_SECRET` — valeurs transmises séparément (jamais dans ce
   dépôt).
5. **Tester tout de suite**, sans attendre le prochain passage du cron : ouvre
   `https://aguilaradar-assistant-ia.<ton-compte>.workers.dev/send-test-push?secret=<TEST_PUSH_SECRET>`
   dans un navigateur. Une notification doit arriver sur l'appareil abonné dans la minute — si
   rien n'arrive, regarde les **Logs** temps réel du Worker (onglet **Logs** du tableau de bord)
   pendant que tu réessaies, le message d'erreur y apparaît en clair.

**Si `PUSH_SUBSCRIPTION_JSON` devient invalide** (abonnement expiré ou révoqué côté navigateur) :
rouvre le site → onglet Alertes → si un abonnement existe déjà, clique **Régénérer le code** →
colle le nouveau JSON obtenu dans le secret `PUSH_SUBSCRIPTION_JSON` (remplace l'ancienne
valeur, mêmes étapes qu'à la création).

**Validation de l'implémentation cryptographique** (avant tout déploiement) : le chiffrement a
été comparé octet pour octet à l'implémentation de référence de l'auteur de la RFC
(`martinthomson/encrypted-content-encoding`) sur des clés fixes, et la signature VAPID vérifiée
indépendamment par Node `crypto` (bibliothèque distincte de celle utilisée pour signer) — les
deux avec succès. Un seul point n'a pu être testé que via l'endpoint `/send-test-push` ci-dessus
plutôt qu'à l'avance : la livraison réelle jusqu'à un appareil, qui dépend du service push du
navigateur (Apple/Google/Mozilla) et non de ce code.

## Écriture directe des transactions du portefeuille (troisième rôle de ce même Worker)

Le même Worker déployé ci-dessus peut aussi recevoir une transaction (achat/vente) depuis le
formulaire de l'onglet Portefeuille du site et l'écrire directement dans `data/portfolio.json`
(un vrai commit git), au lieu du copier-coller manuel qui reste le comportement par défaut tant
que ce rôle n'est pas configuré.

**Important, à lire avant de configurer ce rôle** : ce n'est pas une vraie sécurité, exactement
comme le portail d'accès du site (voir `CLAUDE.md`, section "Portail d'accès"). Le code source de
ce Worker et du site est public — un secret côté client ne peut jamais être un vrai secret. La
protection ici (en-tête secret + limite de 20 tentatives/heure, voir `handleTransactionRequest`
dans `worker.js`) filtre un visiteur qui tombe dessus par hasard, pas quelqu'un de déterminé qui
lit le code. Risque jugé acceptable pour ce projet : `data/portfolio.json` est une simulation
déclarée à la main, jamais connectée à un vrai compte ou wallet, et tout commit reste réversible
dans l'historique git. Choisis un code d'écriture long et aléatoire (pas un code à 4 chiffres) —
il n'y a pas de vraie limitation de débit au-delà des 20/heure ci-dessus.

**Pourquoi des étapes manuelles ici, comme pour les notifications push** : ce rôle a besoin d'un
vrai token GitHub avec droit d'écriture — une valeur qui ne peut jamais vivre dans ce dépôt
public, donc jamais dans le flux "Deploy to Cloudflare" automatique.

1. **Redéployer le code** : Worker → **Modifier le code** → sélectionne tout → colle le contenu
   à jour de `worker.js` → **Déployer**.
2. **Créer un token GitHub dédié** : [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
   → **Generate new token** → **Fine-grained**, accès limité au seul dépôt `aguilaradar-`,
   permission **Contents : Read and write** (rien d'autre) → génère et copie le token (visible une
   seule fois).
3. **Ajouter les 2 secrets** : **Paramètres** → **Variables et secrets** → **Ajouter**, type
   **Secret**, une fois pour chacun de `GITHUB_WRITE_TOKEN` (le token créé à l'étape 2) et
   `PORTFOLIO_WRITE_SECRET` (le code d'écriture choisi ci-dessus, long et aléatoire) — valeurs
   transmises séparément (jamais dans ce dépôt).
4. **Reporter l'URL dans le site** : colle `https://aguilaradar-assistant-ia.<ton-compte>.workers.dev/transaction`
   dans `PORTFOLIO_WRITE_URL` (`js/config.js`), à la place du placeholder `REMPLACE-MOI-...`.
5. **Tester tout de suite** : ouvre le site, onglet Portefeuille → "Ajouter un achat ou une
   vente" → le bouton doit maintenant afficher "Enregistrer" et un champ "Code d'écriture" doit
   être visible. Saisis le code choisi à l'étape 3, remplis une transaction, envoie. En cas
   d'échec, regarde les **Logs** temps réel du Worker (onglet **Logs** du tableau de bord) pendant
   que tu réessaies.

**Le KV `PUSH_STATE` déjà lié (voir la section notifications push ci-dessus) est réutilisé tel
quel** pour compter les tentatives par heure — aucun espace de noms supplémentaire à créer ni à
lier pour ce rôle.
