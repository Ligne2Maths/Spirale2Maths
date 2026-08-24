/* Intégration « application installable » (PWA).
 *
 * Trois choses, dans cet ordre d'apparition à l'écran :
 *   - l'enregistrement du service worker (sw.js), qui rend le site
 *     installable et consultable hors ligne ;
 *   - une bannière proposant l'installation — bouton natif sur Android et
 *     desktop, marche à suivre écrite sur iPhone/iPad, faute d'API ;
 *   - une bannière signalant qu'une nouvelle version a été téléchargée.
 *
 * Rien ici ne touche à l'application elle-même (js/app.js) : ce fichier peut
 * être retiré sans rien casser d'autre que l'installation.
 */

(() => {
  "use strict";

  const CLE_INSTALL_REFUSEE = "carnet2maths_installRefuseeLe";

  // Une proposition d'installation refusée ne revient pas avant ce délai :
  // la reproposer à chaque visite serait une nuisance.
  const DELAI_AVANT_NOUVELLE_PROPOSITION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

  // Laisse le temps à la liste des savoir-faire de s'afficher : une bannière
  // qui surgit pendant le chargement passe pour une publicité.
  const DELAI_AVANT_PROPOSITION_MS = 4000;

  /* ---------- Bannière ---------- */

  let banniereActive = null;

  /**
   * Monte une bannière en bas d'écran.
   * @param {{variante?: string, titre: string, texte: Node|string,
   *          action?: {libelle: string, onClick: Function},
   *          onFermer?: Function}} options
   */
  function afficherBanniere(options) {
    if (banniereActive) retirerBanniere();

    const banniere = document.createElement("div");
    banniere.className = "pwa-banner";
    if (options.variante) banniere.classList.add(`pwa-banner--${options.variante}`);
    banniere.setAttribute("role", "dialog");
    banniere.setAttribute("aria-label", options.titre);

    if (options.variante === "install") {
      const icone = document.createElement("img");
      icone.className = "pwa-banner-icon";
      icone.src = "/icons/icon-96.png";
      icone.alt = "";
      banniere.appendChild(icone);
    }

    const texte = document.createElement("div");
    texte.className = "pwa-banner-text";

    const titre = document.createElement("strong");
    titre.className = "pwa-banner-title";
    titre.textContent = options.titre;

    const description = document.createElement("span");
    description.className = "pwa-banner-desc";
    if (typeof options.texte === "string") description.textContent = options.texte;
    else description.appendChild(options.texte);

    texte.append(titre, description);
    banniere.appendChild(texte);

    const actions = document.createElement("div");
    actions.className = "pwa-banner-actions";

    if (options.action) {
      const bouton = document.createElement("button");
      bouton.type = "button";
      bouton.className = "pwa-banner-action";
      bouton.textContent = options.action.libelle;
      bouton.addEventListener("click", () => options.action.onClick());
      actions.appendChild(bouton);
    }

    const fermer = document.createElement("button");
    fermer.type = "button";
    fermer.className = "pwa-banner-dismiss";
    fermer.setAttribute("aria-label", "Fermer");
    fermer.textContent = "✕";
    fermer.addEventListener("click", () => {
      retirerBanniere();
      if (options.onFermer) options.onFermer();
    });
    actions.appendChild(fermer);

    banniere.appendChild(actions);
    document.body.appendChild(banniere);
    banniereActive = banniere;

    // Deux images successives pour que la transition parte bien de l'état
    // « hors écran » : sans cela le navigateur peint directement l'état final.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banniere.classList.add("is-visible"));
    });
  }

  function retirerBanniere() {
    if (!banniereActive) return;
    const banniere = banniereActive;
    banniereActive = null;
    banniere.classList.remove("is-visible");
    banniere.addEventListener("transitionend", () => banniere.remove(), { once: true });
    // Filet si la transition n'a pas lieu (onglet en arrière-plan, préférence
    // « animations réduites »).
    setTimeout(() => banniere.remove(), 600);
  }

  /* ---------- Contexte ---------- */

  function estInstallee() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.navigator.standalone === true
    );
  }

  function estIOS() {
    const ua = window.navigator.userAgent;
    // Depuis iPadOS 13, un iPad se présente comme un Mac : le seul indice
    // fiable est la présence d'un écran tactile.
    const iPadOS = /Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || iPadOS;
  }

  function estSafari() {
    const ua = window.navigator.userAgent;
    return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }

  function propositionRecemmentRefusee() {
    const refuseeLe = Number(localStorage.getItem(CLE_INSTALL_REFUSEE) || 0);
    return refuseeLe > 0 && Date.now() - refuseeLe < DELAI_AVANT_NOUVELLE_PROPOSITION_MS;
  }

  function noterRefus() {
    try {
      localStorage.setItem(CLE_INSTALL_REFUSEE, String(Date.now()));
    } catch (err) {
      /* mode privé : tant pis, la proposition reviendra */
    }
  }

  /* ---------- Installation : Android, Chrome, Edge ---------- */

  let evenementInstall = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Sans cela, Chrome affiche sa propre mini-barre d'installation ; on
    // préfère choisir le moment et la formulation.
    event.preventDefault();
    evenementInstall = event;

    if (propositionRecemmentRefusee()) return;
    setTimeout(proposerInstallation, DELAI_AVANT_PROPOSITION_MS);
  });

  function proposerInstallation() {
    if (!evenementInstall || estInstallee()) return;

    afficherBanniere({
      variante: "install",
      titre: "Installer Carnet2Maths",
      texte: "Un accès direct depuis l'écran d'accueil, et le site reste consultable hors connexion.",
      action: {
        libelle: "Installer",
        onClick: async () => {
          const invite = evenementInstall;
          // L'événement n'est utilisable qu'une fois.
          evenementInstall = null;
          retirerBanniere();
          if (!invite) return;
          invite.prompt();
          const { outcome } = await invite.userChoice;
          if (outcome === "dismissed") noterRefus();
        },
      },
      onFermer: noterRefus,
    });
  }

  window.addEventListener("appinstalled", () => {
    evenementInstall = null;
    retirerBanniere();
    etiqueterRaccourciInstallation();
    try {
      localStorage.removeItem(CLE_INSTALL_REFUSEE);
    } catch (err) {
      /* sans conséquence */
    }
  });

  /* ---------- Installation : iPhone et iPad ---------- */

  // Safari n'implémente ni `beforeinstallprompt` ni aucune API d'installation :
  // la seule voie est le menu Partager. On décrit donc le geste.
  // `forcee` : demande explicite de l'utilisateur (clic sur le logo). Elle
  // passe outre le délai de trente jours — refuser la bannière ne doit pas
  // condamner l'installation à quelqu'un qui la réclame ensuite.
  function proposerInstallationIOS(forcee) {
    if (estInstallee() || (!forcee && propositionRecemmentRefusee())) return;

    const texte = document.createElement("span");
    texte.className = "pwa-ios-steps";
    texte.append("Appuyez sur ");

    // Le glyphe « Partager » d'iOS n'existe dans aucune police standard :
    // le dessiner évite un carré vide sur les appareils qui ne l'ont pas.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pwa-ios-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    const boite = document.createElementNS("http://www.w3.org/2000/svg", "path");
    boite.setAttribute("d", "M7 11v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9");
    const fleche = document.createElementNS("http://www.w3.org/2000/svg", "path");
    fleche.setAttribute("d", "M12 15V3m0 0L8.5 6.5M12 3l3.5 3.5");
    svg.append(boite, fleche);

    texte.appendChild(svg);
    texte.append(" en bas de l'écran, puis « Sur l'écran d'accueil ».");

    afficherBanniere({
      variante: "install",
      titre: "Ajouter Carnet2Maths à l'écran d'accueil",
      texte,
      onFermer: noterRefus,
    });
  }

  if (estIOS() && estSafari() && !estInstallee()) {
    setTimeout(() => proposerInstallationIOS(false), DELAI_AVANT_PROPOSITION_MS);
  }

  /* ---------- Raccourci : le logo propose l'installation ---------- */

  // La bannière ne se montre qu'une fois par visite, et plus du tout pendant
  // trente jours si elle a été fermée : sans autre point d'entrée, qui l'a
  // écartée une fois ne peut plus installer l'application. Le logo tient ce
  // rôle, et il répond TOUJOURS — un bouton qui ne réagit pas une fois sur
  // deux, selon un état invisible du navigateur, passe pour cassé. Quand
  // l'installation directe n'est pas possible, on dit au moins par où passer.
  function proposerDepuisLogo() {
    if (estInstallee()) {
      afficherBanniere({
        variante: "install",
        titre: "Carnet2Maths est déjà installée",
        texte: "Retrouvez-la sur votre écran d'accueil, elle s'ouvre sans navigateur et fonctionne hors connexion.",
      });
      return;
    }

    // Chrome, Edge, Android : l'invite native est disponible.
    if (evenementInstall) {
      proposerInstallation();
      return;
    }

    // Safari sur iPhone et iPad : aucune API, seulement le menu Partager.
    if (estIOS() && estSafari()) {
      proposerInstallationIOS(true);
      return;
    }

    // Le reste : Firefox, Safari sur Mac, ou Chrome qui n'a pas encore émis
    // son événement. L'installation existe souvent quand même, mais elle ne
    // se déclenche que depuis le menu du navigateur.
    afficherBanniere({
      variante: "install",
      titre: "Installer Carnet2Maths",
      texte:
        "Dans le menu de votre navigateur, choisissez « Installer Carnet2Maths » " +
        "ou « Ajouter à l'écran d'accueil ».",
    });
  }

  function etiqueterRaccourciInstallation() {
    const logo = document.querySelector(".site-logo");
    if (!logo) return;
    const libelle = estInstallee() ? "Application installée" : "Installer l'application";
    logo.setAttribute("aria-label", libelle);
    logo.title = libelle;
  }

  function activerRaccourciInstallation() {
    const logo = document.querySelector(".site-logo");
    if (!logo) return;

    logo.setAttribute("role", "button");
    logo.setAttribute("tabindex", "0");
    etiqueterRaccourciInstallation();

    logo.addEventListener("click", proposerDepuisLogo);
    // Une <img> n'active rien au clavier de son propre chef : sans cela, le
    // raccourci resterait réservé à la souris et au doigt.
    logo.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      proposerDepuisLogo();
    });
  }

  activerRaccourciInstallation();

  /* ---------- Service worker ---------- */

  function proposerMiseAJour(registration) {
    afficherBanniere({
      variante: "update",
      titre: "Nouvelle version disponible",
      texte: "Rechargez pour en profiter.",
      action: {
        libelle: "Recharger",
        onClick: () => {
          // Le nouveau service worker attend que tous les onglets se ferment ;
          // ce message lui dit de prendre la main tout de suite. Le rechargement
          // suit, déclenché par `controllerchange`.
          registration.waiting?.postMessage("passer-en-actif");
          retirerBanniere();
        },
      },
    });
  }

  function surveillerMiseAJour(registration) {
    if (registration.waiting && navigator.serviceWorker.controller) {
      proposerMiseAJour(registration);
    }

    registration.addEventListener("updatefound", () => {
      const nouveau = registration.installing;
      if (!nouveau) return;

      nouveau.addEventListener("statechange", () => {
        // `controller` absent = toute première installation : il n'y a rien à
        // mettre à jour, et proposer un rechargement n'aurait aucun sens.
        if (nouveau.state === "installed" && navigator.serviceWorker.controller) {
          proposerMiseAJour(registration);
        }
      });
    });
  }

  if ("serviceWorker" in navigator) {
    let rechargementEnCours = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (rechargementEnCours) return;
      rechargementEnCours = true;
      window.location.reload();
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(surveillerMiseAJour)
        .catch((err) => {
          // Pas d'installation possible, mais le site fonctionne : on se
          // contente de la console (fichier ouvert en file://, mode privé…).
          console.warn("Service worker non enregistré :", err);
        });
    });
  }
})();
