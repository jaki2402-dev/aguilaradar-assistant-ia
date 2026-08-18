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
