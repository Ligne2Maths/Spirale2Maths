/* Service worker de Carnet2Maths.
 *
 * Deux rôles distincts :
 *   1. rendre le site installable (Android et desktop exigent un service
 *      worker qui répond aux requêtes de navigation) ;
 *   2. permettre de rouvrir l'app hors ligne, avec le dernier contenu vu.
 *
 * Il n'y a pas de serveur derrière le site : tout ce qui suit se joue entre
 * le navigateur et GitHub Pages.
 */

// Changer ce numéro invalide tous les anciens caches et déclenche la bannière
// « nouvelle version » chez les visiteurs. À incrémenter à chaque déploiement
// dont on veut être sûr qu'il parvienne immédiatement à tout le monde.
const VERSION = "v6";

const CACHE_COQUE = `carnet2maths-coque-${VERSION}`;
const CACHE_DONNEES = `carnet2maths-donnees-${VERSION}`;
const CACHE_EXTERNE = `carnet2maths-externe-${VERSION}`;

// La coque = ce qui ne change qu'au moment d'un déploiement. Préchargée à
// l'installation pour que la toute première ouverture hors ligne fonctionne,
// même si l'utilisateur n'a jamais rien consulté auparavant.
const RESSOURCES_COQUE = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/app.js",
  "/js/pwa.js",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/logo-header.svg",
  "/icons/icon-96.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Au-delà de ce délai, on sert la copie en cache plutôt que de laisser
// l'utilisateur devant un écran blanc : en 4G capricieuse, une requête peut
// mettre dix secondes sans jamais échouer franchement.
const DELAI_RESEAU_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_COQUE).then((cache) =>
      // `addAll` échoue en bloc dès qu'une seule requête échoue, ce qui
      // laisserait un service worker jamais installé. On tolère les manques :
      // ce qui n'a pas pu être préchargé le sera au premier passage réseau.
      Promise.all(
        RESSOURCES_COQUE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const gardes = [CACHE_COQUE, CACHE_DONNEES, CACHE_EXTERNE];
      const noms = await caches.keys();
      await Promise.all(
        noms.map((nom) => (gardes.includes(nom) ? null : caches.delete(nom)))
      );

      // Sans cela, un onglet déjà ouvert continuerait d'être servi par
      // l'ancien service worker jusqu'à sa fermeture complète.
      await self.clients.claim();
    })()
  );
});

// js/pwa.js envoie ce message quand l'utilisateur accepte la mise à jour : le
// nouveau service worker prend la main sans attendre la fermeture des onglets,
// puis la page se recharge.
self.addEventListener("message", (event) => {
  if (event.data === "passer-en-actif") self.skipWaiting();
});

/* ---------- Stratégies ---------- */

/** Réseau prioritaire, cache en secours (panne réseau ou réseau trop lent).
 *
 * Le site est mis à jour par simple dépôt de fichiers : une stratégie
 * « cache d'abord » servirait indéfiniment l'ancienne version tant que le
 * numéro de VERSION n'a pas bougé. On préfère donc toujours interroger le
 * réseau, mais sans jamais bloquer l'affichage plus de DELAI_RESEAU_MS. */
async function reseauDabord(request, nomCache, delaiMs) {
  const cache = await caches.open(nomCache);

  const reseau = fetch(request)
    .then((reponse) => {
      if (reponse && reponse.ok) cache.put(request, reponse.clone());
      return reponse;
    })
    .catch(() => null);

  if (delaiMs) {
    // On laisse au réseau le temps imparti. Passé ce délai, la copie locale
    // prend la main si elle existe ; la requête, elle, continue en arrière-plan
    // et rafraîchit le cache pour le prochain chargement.
    const expiration = new Promise((resolve) => setTimeout(resolve, delaiMs, null));
    const premiere = await Promise.race([reseau, expiration]);
    if (premiere) return premiere;

    const enCache = await cache.match(request);
    if (enCache) return enCache;
  }

  // Réseau muet et rien en cache : il ne reste qu'à attendre la requête
  // jusqu'au bout, puis à répondre franchement « hors ligne ».
  const reponse = await reseau;
  return exigerReponse(reponse || (await cache.match(request)));
}

function exigerReponse(reponse) {
  if (reponse) return reponse;
  return new Response("Ressource indisponible hors ligne", {
    status: 504,
    statusText: "Hors ligne",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Seules les lectures nous concernent : laisser passer le reste tel quel.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    // Lecteurs YouTube et Digiview : jamais mis en cache (contenu vidéo, et
    // réponses opaques qui rempliraient le quota pour rien). Seul SheetJS,
    // sans lequel aucun classeur n'est lisible, est conservé.
    if (url.hostname !== "cdn.sheetjs.com") return;

    event.respondWith(
      caches.open(CACHE_EXTERNE).then(async (cache) => {
        const enCache = await cache.match(request);
        if (enCache) return enCache;
        // Réponse opaque (script chargé sans CORS) : impossible d'en vérifier
        // le statut, on la garde telle quelle.
        const reponse = await fetch(request);
        cache.put(request, reponse.clone());
        return reponse;
      })
    );
    return;
  }

  // Navigation : si le réseau manque, renvoyer la page d'accueil en cache
  // pour que l'app installée s'ouvre quand même.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_COQUE);
        const page = (await cache.match("/index.html")) || (await cache.match("/"));
        return exigerReponse(page);
      })
    );
    return;
  }

  // Contenu pédagogique (option.json, classeurs .xlsx) : il change sans que le
  // site soit redéployé, le réseau fait donc toujours foi.
  if (url.pathname.startsWith("/contenu/") || url.pathname === "/option.json") {
    event.respondWith(reseauDabord(request, CACHE_DONNEES, DELAI_RESEAU_MS));
    return;
  }

  event.respondWith(reseauDabord(request, CACHE_COQUE, DELAI_RESEAU_MS));
});
