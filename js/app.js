"use strict";

/* ---------- Constantes ---------- */

const NOMS_MOIS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

// Règle d'affichage : 4 lettres ou moins -> nom entier ; 5 lettres ou plus -> coupé à 3 + un point.
function abregeMois(nom) {
  return (nom.length <= 4 ? nom : `${nom.slice(0, 3)}.`).toUpperCase();
}

const MOIS_FR = NOMS_MOIS_FR.map(abregeMois);

/* ---------- État global (en mémoire) ---------- */

const state = {
  optionData: null,
  optionEmpreinte: null,    // empreinte du option.json lu — voir rafraichirContenu()
  niveauxData: new Map(),   // acronyme -> { config, sfList, planning, chapitresList }
  selectedAcronymes: new Set(),
  mode: "date",
  videoMode: "nopub",       // "ytb" (lecteur YouTube classique) | "nopub" (iframe Digiview, sans pub)
  validations: {},          // { acronyme: { code: { n: { dateISO: true|false } } } } — une entrée par date où le niveau a été fait
  // Posé au premier rendu du mode Date seulement : les jours proposés sortent
  // du planning, qui n'est pas encore chargé ici — voir renderDateMode().
  selectedDate: null,
  openLevels: new Map(),    // `${acronyme}::${code}::${n}` -> "open" | "split" (transitoire)
};

/* ---------- Utilitaires date ---------- */

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateShort(date) {
  return `${date.getDate()} ${MOIS_FR[date.getMonth()]}`;
}

function addDays(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

/* ---------- Persistance localStorage (globale, pas de notion de "niveau courant") ---------- */

function loadPersistedGlobalState(availableAcronymes) {
  let savedSel = null;
  try {
    savedSel = JSON.parse(localStorage.getItem("carnet2maths_selectedNiveaux") || "null");
  } catch (e) { /* valeur corrompue, on ignore */ }

  const valid = Array.isArray(savedSel) ? savedSel.filter((a) => availableAcronymes.includes(a)) : [];
  state.selectedAcronymes = new Set(valid.length ? valid : availableAcronymes);

  const savedMode = localStorage.getItem("carnet2maths_mode");
  state.mode = savedMode === "chapitre" || savedMode === "date" ? savedMode : "date";

  const savedVideoMode = localStorage.getItem("carnet2maths_videoMode");
  state.videoMode = savedVideoMode === "ytb" ? "ytb" : "nopub"; // "nopub" par défaut

  try {
    state.validations = JSON.parse(localStorage.getItem("carnet2maths_validations") || "{}");
  } catch (e) {
    state.validations = {};
  }
}

function saveSelectedNiveaux() {
  localStorage.setItem("carnet2maths_selectedNiveaux", JSON.stringify([...state.selectedAcronymes]));
}

function saveMode() {
  localStorage.setItem("carnet2maths_mode", state.mode);
}

function saveVideoMode() {
  localStorage.setItem("carnet2maths_videoMode", state.videoMode);
}

function saveValidations() {
  localStorage.setItem("carnet2maths_validations", JSON.stringify(state.validations));
}

function getValidationEntry(acronyme, code, n) {
  const forCode = state.validations[acronyme] && state.validations[acronyme][code];
  return forCode ? forCode[n] : undefined;
}

function getValidationForDate(acronyme, code, n, iso) {
  const entry = getValidationEntry(acronyme, code, n);
  return entry ? entry[iso] : undefined;
}

function setValidationForDate(acronyme, code, n, iso, value) {
  if (!state.validations[acronyme]) state.validations[acronyme] = {};
  if (!state.validations[acronyme][code]) state.validations[acronyme][code] = {};
  if (!state.validations[acronyme][code][n]) state.validations[acronyme][code][n] = {};
  state.validations[acronyme][code][n][iso] = value;
  saveValidations();
}

function clearValidationForDate(acronyme, code, n, iso) {
  const entry = getValidationEntry(acronyme, code, n);
  if (entry && iso in entry) {
    delete entry[iso];
    saveValidations();
  }
}

function clearDayStats(iso) {
  Object.values(state.validations).forEach((forAcronyme) => {
    Object.values(forAcronyme).forEach((forCode) => {
      Object.values(forCode).forEach((forNiveau) => {
        delete forNiveau[iso];
      });
    });
  });
  saveValidations();
}

function countValidations(acronyme, code, n) {
  const entry = getValidationEntry(acronyme, code, n);
  let vert = 0;
  let rouge = 0;
  if (entry) {
    Object.values(entry).forEach((v) => {
      if (v === true) vert++;
      else if (v === false) rouge++;
    });
  }
  return { vert, rouge };
}

/* ---------- Lecture du tableur (SheetJS) ---------- */

function parseListe(rows) {
  const sfs = [];
  if (!rows.length) return sfs;

  // Les colonnes de niveau ("Niveau N YT", "Niveau N Fin") et "Commentaire"
  // sont repérées par leur intitulé dans la 1ère ligne plutôt qu'à une
  // position fixe : le nombre de niveaux (et donc la position de
  // Commentaire) peut changer d'un tableur à l'autre (ex. ajout d'un
  // Niveau 4, 5…) sans casser la lecture.
  const header = rows[0].map((h) => String(h ?? "").trim());
  const commentaireCol = header.findIndex((h) => /^commentaire$/i.test(h));
  const niveauCols = [];
  const niveauFinCols = [];
  header.forEach((h, col) => {
    const mYT = h.match(/^niveau\s*(\d+)\s*yt$/i);
    if (mYT) niveauCols.push({ n: Number(mYT[1]), col });
    const mFin = h.match(/^niveau\s*(\d+)\s*fin$/i);
    if (mFin) niveauFinCols.push({ n: Number(mFin[1]), col });
  });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const titre = String(row[4] ?? "").trim();
    if (!titre) continue; // ligne gabarit vide

    const code = String(row[3] ?? "").trim();
    const chapitre = Number(row[1]);
    const numSF = Number(row[2]);
    const commentaire = commentaireCol >= 0 ? String(row[commentaireCol] ?? "").trim() : "";

    const niveaux = {};
    niveauCols.forEach(({ n, col }) => {
      const id = String(row[col] ?? "").trim();
      if (id) niveaux[n] = id;
    });

    // Colonne "Niveau N Fin" : un nombre, non utilisé pour l'instant
    // (réservé pour une future fonctionnalité) mais déjà lu et stocké.
    const niveauxFin = {};
    niveauFinCols.forEach(({ n, col }) => {
      const val = row[col];
      if (val !== "" && val !== undefined && val !== null && !Number.isNaN(Number(val))) {
        niveauxFin[n] = Number(val);
      }
    });

    sfs.push({ code, chapitre, numSF, titre, commentaire, niveaux, niveauxFin });
  }
  return sfs;
}

function parsePlanning(rows) {
  const map = new Map();
  if (!rows.length) return map;

  const header = rows[0];
  const dateCols = [];
  for (let c = 2; c < header.length; c++) {
    const val = header[c];
    if (val instanceof Date) {
      dateCols.push({ col: c, iso: toISODate(val) });
    }
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const code = String(row[0] ?? "").trim();
    if (!code) continue;
    dateCols.forEach(({ col, iso }) => {
      const cell = String(row[col] ?? "").trim().toLowerCase();
      if (cell === "x") {
        if (!map.has(iso)) map.set(iso, new Set());
        map.get(iso).add(code);
      }
    });
  }
  return map;
}

/** Empreinte du contenu reçu (FNV-1a 32 bits) : c'est elle, et non les en-têtes
 *  HTTP, qui dit si un fichier a bougé depuis la dernière lecture. Le serveur de
 *  développement n'envoie pas les mêmes en-têtes que GitHub Pages, et une
 *  réponse resservie par le service worker porte celles du jour où elle a été
 *  mise en cache. Voir rafraichirContenu(). */
function empreinte(donnees) {
  const octets =
    typeof donnees === "string" ? new TextEncoder().encode(donnees) : new Uint8Array(donnees);
  let h = 0x811c9dc5;
  for (let i = 0; i < octets.length; i++) h = Math.imul(h ^ octets[i], 0x01000193);
  return h >>> 0;
}

// Lu en texte plutôt qu'en JSON : l'empreinte se calcule sur ce qui a été reçu.
async function chargerOption() {
  const res = await fetch("option.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const texte = await res.text();
  return { data: JSON.parse(texte), empreinte: empreinte(texte) };
}

async function loadNiveauData(niveauConfig) {
  // cache: "no-store" : le tableur est modifié régulièrement (ajout de niveaux,
  // de SF...) et on veut toujours la dernière version au rechargement, pas une
  // copie mise en cache par le navigateur.
  const res = await fetch(niveauConfig.fichier, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const listeRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  const planRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], { header: 1, defval: "" });

  const sfList = parseListe(listeRows);
  const planning = parsePlanning(planRows);

  const chNums = [...new Set(sfList.map((sf) => sf.chapitre))]
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const chapitresList = chNums.map((num) => ({
    num,
    nom: (niveauConfig.chapitres && niveauConfig.chapitres[String(num)]) || `Chapitre ${num}`,
  }));

  return { config: niveauConfig, sfList, planning, chapitresList, empreinte: empreinte(buf) };
}

async function ensureNiveauLoaded(acronyme) {
  if (state.niveauxData.has(acronyme)) return state.niveauxData.get(acronyme);
  const config = state.optionData.niveaux.find((n) => n.acronyme === acronyme);
  const data = await loadNiveauData(config);
  state.niveauxData.set(acronyme, data);
  return data;
}

function getSortedNiveaux() {
  return [...state.optionData.niveaux].sort((a, b) => {
    const oa = Number.isFinite(a.ordre) ? a.ordre : Infinity;
    const ob = Number.isFinite(b.ordre) ? b.ordre : Infinity;
    return oa - ob;
  });
}

function orderedSelectedAcronymes() {
  return getSortedNiveaux().map((n) => n.acronyme).filter((a) => state.selectedAcronymes.has(a));
}

/* ---------- Rendu : en-tête ---------- */

// La pastille blanche qui glisse sous le libellé actif d'une bascule est posée
// en pixels par le JS : elle doit être replacée dès que la géométrie change.
// Chaque bascule dépose ici de quoi se recalculer — la fenêtre qu'on
// redimensionne s'en sert, et l'en-tête compact aussi, lui qui resserre les
// libellés en passant à une seule ligne.
const repositionneursIndicateurs = [];

function repositionnerIndicateurs() {
  repositionneursIndicateurs.forEach((replacer) => replacer());
}

window.addEventListener("resize", repositionnerIndicateurs);

/** Retire le libellé « Affichage » quand la rangée ne tient plus sur une ligne.
 *
 *  Sur un téléphone, la bascule Par Chapitre / Par Date et les deux pastilles
 *  rondes réclament à elles seules presque toute la largeur : le libellé les
 *  poussait à la ligne, et l'en-tête gagnait une rangée pour un mot que le
 *  contenu des boutons dit déjà. Il s'efface donc, mais seulement quand il
 *  gêne — sur un écran large il reste.
 *
 *  On repose la question au libellé visible à chaque fois : une fois retiré,
 *  il ne saurait jamais que la place est revenue. Le va-et-vient tient dans
 *  la même tâche, aucune image n'est peinte entre les deux, donc rien ne
 *  clignote. */
function ajusterLibelleAffichage() {
  const header = document.querySelector(".site-header");
  const row = document.getElementById("mode-row");
  // Rangée masquée (choix initial) ou en-tête replié : le libellé et les
  // pastilles ne sont pas à l'écran, il n'y a rien à arbitrer.
  if (row.hidden || header.classList.contains("is-compact")) return;

  const libelle = row.querySelector(".header-row-label");
  const enfants = [
    libelle,
    document.getElementById("mode-toggle"),
    row.querySelector(".header-tools"),
  ];

  libelle.hidden = false;

  // Une rangée plus haute que son plus grand élément est une rangée qui a
  // débordé — mesure plus sûre que de comparer des positions, les trois
  // éléments n'ayant ni la même hauteur ni le même alignement vertical.
  const hauteurLigne = Math.max(...enfants.map((el) => el.getBoundingClientRect().height));
  libelle.hidden = row.getBoundingClientRect().height > hauteurLigne + 1;
}

window.addEventListener("resize", ajusterLibelleAffichage);

// Les niveaux de classe tenaient autrefois une rangée entière de l'en-tête,
// une bulle par niveau. Avec des libellés comme « Révision Première », cette
// rangée coûtait plus de place qu'elle ne rendait de service pour un réglage
// que l'on touche deux fois par an : elle a laissé la place à une pastille
// aux trois barres croissantes, qui rouvre la fenêtre de la première visite.
//
// La pastille ne sert que s'il y a plusieurs niveaux configurés : avec un
// seul, le choix serait unique et obligatoire, donc vide de sens.
function initNiveauBtn() {
  if (state.optionData.niveaux.length <= 1) return;

  const btn = document.getElementById("niveau-btn");
  btn.hidden = false;
  btn.addEventListener("click", () => {
    ouvrirFenetreNiveaux({
      onValider: appliquerNiveaux,
      renvoyerFocusVers: btn,
    });
  });
  majLibelleNiveauBtn();
}

// Les bulles disaient d'un coup d'œil quels niveaux étaient affichés ; un
// dessin, lui, ne dit rien. La liste passe donc dans le libellé du bouton,
// que lisent l'infobulle et le lecteur d'écran.
function majLibelleNiveauBtn() {
  const btn = document.getElementById("niveau-btn");
  if (btn.hidden) return;
  const choisis = orderedSelectedAcronymes().join(", ");
  const texte = `Niveaux de classe : ${choisis || "aucun"}`;
  btn.setAttribute("aria-label", texte);
  btn.title = texte;
}

// Applique le choix sorti de la fenêtre : on enregistre, on charge ce qui
// manque, on redessine. Un fichier qui refuse de se charger retire son niveau
// du choix — mais jamais au point de ne plus rien avoir à afficher, auquel cas
// on remet le choix précédent, lui déjà chargé.
async function appliquerNiveaux(choisis) {
  const avant = [...state.selectedAcronymes];
  const inchange =
    choisis.length === avant.length && choisis.every((a) => state.selectedAcronymes.has(a));
  if (inchange) return;

  state.selectedAcronymes = new Set(choisis);
  saveSelectedNiveaux();
  majLibelleNiveauBtn();

  const appEl = document.getElementById("app");
  const manquants = choisis.filter((a) => !state.niveauxData.has(a));
  const echecs = [];

  if (manquants.length) {
    appEl.innerHTML = '<p class="empty-message">Chargement…</p>';
    await Promise.all(
      manquants.map((a) => ensureNiveauLoaded(a).catch(() => echecs.push(a)))
    );

    if (echecs.length) {
      echecs.forEach((a) => state.selectedAcronymes.delete(a));
      if (!state.selectedAcronymes.size) state.selectedAcronymes = new Set(avant);
      saveSelectedNiveaux();
      majLibelleNiveauBtn();
    }
  }

  render();

  // L'échec se dit au-dessus de ce qui a pu être chargé, plutôt qu'à la place.
  if (echecs.length) {
    const avis = document.createElement("p");
    avis.className = "empty-message";
    avis.textContent = `Impossible de charger : ${echecs.join(", ")}.`;
    appEl.prepend(avis);
  }
}

function renderModeToggle() {
  const container = document.getElementById("mode-toggle");
  const indicator = document.getElementById("mode-indicator");
  const buttons = container.querySelectorAll(".segment-btn");

  function moveIndicator(btn, animate) {
    if (!animate) indicator.style.transition = "none";
    indicator.style.width = `${btn.offsetWidth}px`;
    indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (!animate) {
      void indicator.offsetHeight; // force le rendu immédiat avant de réactiver la transition
      indicator.style.transition = "";
    }
  }

  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.mode);
    btn.onclick = () => {
      if (state.mode === btn.dataset.mode) return; // déjà actif
      state.mode = btn.dataset.mode;
      saveMode();
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      moveIndicator(btn, true);
      render();
    };
  });

  const replacer = () => {
    const actif = container.querySelector(".segment-btn.active");
    if (actif) moveIndicator(actif, false);
  };

  replacer();
  repositionneursIndicateurs.push(replacer);
}

// Changement de lecteur (YTB <-> NO PUB) : tout reconstruire refermerait les
// chapitres, remonterait la page en haut et recalerait la bande de dates. On ne
// remplace donc que les lecteurs des vidéos actuellement dépliées, à leur place
// exacte — le reste de la page n'est pas touché, donc rien ne bouge. Les
// vidéos en cours de repli (classe `is-open` déjà retirée) sont ignorées :
// elles vont disparaître, inutile d'y charger un lecteur.
function rechargerLecteursOuverts() {
  document
    .querySelectorAll(".video-collapse.is-open > .video-collapse-inner")
    .forEach((inner) => {
      if (inner.rebatirLecteur) inner.rebatirLecteur();
    });
}

function renderVideoModeToggle() {
  const container = document.getElementById("video-mode-toggle");
  const indicator = document.getElementById("video-mode-indicator");
  const buttons = container.querySelectorAll(".segment-btn");

  function moveIndicator(btn, animate) {
    if (!animate) indicator.style.transition = "none";
    indicator.style.width = `${btn.offsetWidth}px`;
    indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (!animate) {
      void indicator.offsetHeight; // force le rendu immédiat avant de réactiver la transition
      indicator.style.transition = "";
    }
  }

  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.videoMode === state.videoMode);
    btn.onclick = () => {
      if (state.videoMode === btn.dataset.videoMode) return; // déjà actif
      state.videoMode = btn.dataset.videoMode;
      saveVideoMode();
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      moveIndicator(btn, true);
      rechargerLecteursOuverts(); // échange les lecteurs sur place, sans rendu complet
    };
  });

  const replacer = () => {
    const actif = container.querySelector(".segment-btn.active");
    if (actif) moveIndicator(actif, false);
  };

  replacer();
  repositionneursIndicateurs.push(replacer);
}

/* ---------- Thème clair / sombre ---------- */

// Le thème est déjà posé sur <html> par le script en tête d'index.html : il
// doit l'être avant le premier rendu, sinon la page s'afficherait en clair le
// temps du chargement. Il ne reste ici que la bascule et sa mémorisation.

const CLE_THEME = "carnet2maths_theme";

// Couleur de la barre système (Android, Safari sur macOS) : elle reprend le
// haut du dégradé de l'en-tête, sinon elle resterait claire au-dessus d'une
// page sombre.
const COULEUR_BARRE = { clair: "#2A2478", sombre: "#221C62" };

function themeCourant() {
  return document.documentElement.dataset.theme === "sombre" ? "sombre" : "clair";
}

function lireThemeMemorise() {
  try {
    return localStorage.getItem(CLE_THEME);
  } catch (e) {
    return null; // stockage refusé (navigation privée)
  }
}

// Coupe les transitions de la page le temps du repeint — voir la règle
// `[data-bascule-theme]` dans la feuille de style.
function couperTransitions() {
  const html = document.documentElement;
  html.dataset.basculeTheme = "";
  // Deux images de suite : la première peint le nouveau thème sans transition,
  // la seconde rend au reste de la page les siennes.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => delete html.dataset.basculeTheme);
  });
}

function appliquerTheme(theme) {
  couperTransitions();
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = COULEUR_BARRE[theme];

  // Le bouton n'affiche pas l'état courant mais ce qu'il fera : c'est ce que
  // dit déjà le dessin (un soleil en mode sombre invite à revenir au jour).
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const libelle = theme === "sombre" ? "Passer en mode clair" : "Passer en mode sombre";
    btn.setAttribute("aria-label", libelle);
    btn.title = libelle;
  }
}

function initThemeToggle() {
  appliquerTheme(themeCourant());

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const theme = themeCourant() === "sombre" ? "clair" : "sombre";
    appliquerTheme(theme);
    try {
      localStorage.setItem(CLE_THEME, theme);
    } catch (e) { /* le choix ne vaudra que pour cette visite */ }
  });

  // Tant que l'utilisateur n'a pas tranché lui-même, le site suit le réglage
  // du système — y compris s'il change pendant que la page est ouverte, ce que
  // font iOS et Android au coucher du soleil.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!lireThemeMemorise()) appliquerTheme(e.matches ? "sombre" : "clair");
    });
}

/* ---------- En-tête compact au défilement ---------- */

// Amplitude minimale d'un geste avant de changer d'état. Sans elle, un doigt
// posé sur l'écran ferait osciller l'en-tête à chaque pixel.
const AMPLITUDE_COMPACT_PX = 8;

// Durée du glissement d'un état à l'autre.
const DUREE_BASCULE_MS = 260;

// Temps pendant lequel on cesse de lire la position de défilement après un
// changement d'état. Il doit couvrir le glissement de bout en bout : tant que
// la hauteur de l'en-tête bouge, le navigateur rattrape la position de
// défilement, et cette position ne dit plus rien du geste de l'utilisateur.
const DUREE_REPLI_MS = DUREE_BASCULE_MS + 100;

// Animation en cours, s'il y en a une : de quoi la solder avant d'en lancer
// une autre, sinon des styles en ligne resteraient posés.
let animationEnTete = null;

/** Fait passer l'en-tête d'un état à l'autre en animant le déplacement.
 *
 *  Aucune transition CSS ne sait interpoler entre les deux mises en page —
 *  une colonne de trois rangées d'un côté, une grille d'une seule ligne de
 *  l'autre. On relève donc la géométrie avant la bascule, on applique la
 *  classe, on relève la géométrie d'arrivée, puis on ramène chaque élément à
 *  sa position de départ par une transformation qu'on laisse ensuite se
 *  résorber : le navigateur, lui, sait animer une transformation.
 *
 *  Les bascules segmentées glissent et changent d'échelle ; le logo, le
 *  libellé « Affichage » et les deux pastilles rondes, que le repli retire du
 *  flux, s'effacent en fondu — épinglés le temps de l'animation là où ils
 *  étaient, faute de quoi ils disparaîtraient d'un coup. */
function basculerEnTete(header, versCompact) {
  if (animationEnTete) animationEnTete.annuler();

  const mouvants = [...header.querySelectorAll(".segmented")];
  const fondus = [
    header.querySelector(".site-brand"),
    header.querySelector(".header-tools"),
    header.querySelector("#mode-row .header-row-label"),
  ].filter((el) => el && !el.hidden);

  const mesurer = (els) => new Map(els.map((el) => [el, el.getBoundingClientRect()]));

  // Avant : géométrie de départ.
  const hauteurAvant = header.getBoundingClientRect().height;
  const avant = mesurer(mouvants);

  // Au repli, les éléments qui s'effacent quittent le flux : leur place, il
  // faut la relever pendant qu'ils l'occupent encore. Au dépliage ils la
  // reprennent d'eux-mêmes, il n'y a qu'à les révéler.
  const reperes = versCompact ? mesurer(fondus) : null;
  const affichages = versCompact
    ? new Map(fondus.map((el) => [el, getComputedStyle(el).display]))
    : null;

  // Après : la classe est posée, la mise en page d'arrivée est connue.
  header.classList.toggle("is-compact", versCompact);
  // Le dépliage rend la rangée « Affichage » à sa largeur d'origine : c'est le
  // moment de savoir si son libellé y a de nouveau sa place.
  ajusterLibelleAffichage();
  // Les libellés des bascules viennent de changer de taille : leur pastille
  // resterait sur l'ancienne largeur.
  repositionnerIndicateurs();

  const apres = mesurer(mouvants);
  const hauteurApres = header.getBoundingClientRect().height;

  const aBouge =
    Math.abs(hauteurAvant - hauteurApres) > 0.5 ||
    mouvants.some((el) => {
      const a = avant.get(el);
      const b = apres.get(el);
      return Math.abs(a.left - b.left) > 0.5 || Math.abs(a.top - b.top) > 0.5;
    });

  // Sur écran large, la classe ne change rien à voir : inutile d'animer le
  // vide. De même si l'on demande moins d'animations.
  if (!aBouge || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // Retour au point de départ, sans transition : à l'écran, rien n'a bougé.
  const rectHeader = header.getBoundingClientRect();

  header.style.overflow = "hidden";
  header.style.height = `${hauteurAvant}px`;

  mouvants.forEach((el) => {
    const a = avant.get(el);
    const b = apres.get(el);
    el.style.transformOrigin = "left top";
    el.style.transform =
      `translate(${a.left - b.left}px, ${a.top - b.top}px) ` +
      `scale(${a.width / b.width}, ${a.height / b.height})`;
  });

  fondus.forEach((el) => {
    if (!versCompact) {
      el.style.opacity = "0"; // en place, il ne reste qu'à le révéler
      return;
    }
    const r = reperes.get(el);
    el.style.display = affichages.get(el);
    el.style.position = "absolute";
    el.style.visibility = "visible";
    el.style.left = `${r.left - rectHeader.left}px`;
    el.style.top = `${r.top - rectHeader.top}px`;
    el.style.width = `${r.width}px`;
    el.style.opacity = "1";
    el.style.pointerEvents = "none";
  });

  // Force la prise en compte de l'état de départ avant d'armer les transitions,
  // sans quoi le navigateur peindrait directement l'état d'arrivée.
  void header.offsetHeight;

  header.style.transition = `height ${DUREE_BASCULE_MS}ms ease`;
  header.style.height = `${hauteurApres}px`;

  mouvants.forEach((el) => {
    el.style.transition = `transform ${DUREE_BASCULE_MS}ms ease`;
    el.style.transform = "";
  });

  // Le fondu est plus court que le glissement : ce qui s'en va doit avoir
  // disparu avant que les bascules ne se posent.
  const dureeFondu = Math.round(DUREE_BASCULE_MS * 0.6);
  fondus.forEach((el) => {
    el.style.transition = `opacity ${dureeFondu}ms ease`;
    el.style.opacity = versCompact ? "0" : "1";
  });

  const nettoyer = () => {
    header.style.transition = "";
    header.style.height = "";
    header.style.overflow = "";
    mouvants.forEach((el) => {
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
    });
    fondus.forEach((el) => {
      ["display", "position", "visibility", "left", "top", "width", "opacity",
       "pointerEvents", "transition"].forEach((prop) => {
        el.style[prop] = "";
      });
    });
    animationEnTete = null;
  };

  // Minuterie plutôt que `transitionend` : cet événement ne se déclenche pas
  // si l'onglet passe à l'arrière-plan en cours de route, et les styles en
  // ligne resteraient posés.
  const minuterie = setTimeout(nettoyer, DUREE_BASCULE_MS + 50);
  animationEnTete = {
    annuler: () => {
      clearTimeout(minuterie);
      nettoyer();
    },
  };
}

// Descendre replie l'en-tête, remonter le redéploie — et le haut de page le
// redéploie toujours. Le repli lui-même est affaire de CSS, et n'a lieu que
// sur écran étroit : ici on ne fait que décider du basculement.
function surveillerDefilementPage() {
  const header = document.querySelector(".site-header");
  // Hauteur de l'en-tête déployé, relevée en continu : elle dépend du nombre
  // de niveaux cochés et de la largeur de l'écran, on ne peut pas la figer.
  let hauteurDeployee = header.getBoundingClientRect().height;
  let dernierY = Math.max(0, window.scrollY);
  let finDuRepli = 0;
  let enAttente = false;

  function evaluer() {
    enAttente = false;

    const compact = header.classList.contains("is-compact");
    const hauteur = header.getBoundingClientRect().height;
    const enTrainDeBouger = performance.now() < finDuRepli;

    // Étalon relevé seulement à l'arrêt et en position déployée : mesuré en
    // pleine animation, il ne voudrait rien dire.
    if (!compact && !enTrainDeBouger) hauteurDeployee = hauteur;

    // Position de défilement exprimée comme si l'en-tête était toujours
    // déployé. L'en-tête occupe sa place dans le flux : en se repliant, il
    // fait remonter tout ce qui le suit, et le navigateur rattrape alors la
    // position pour garder l'image stable (ancrage du défilement, et recadrage
    // en bas de page). `window.scrollY` bouge donc sans que le doigt ait bougé.
    // Lui rajouter ce que l'en-tête a rendu donne une mesure que ses propres
    // changements de taille ne font plus varier : ni le sens du geste, ni le
    // seuil du haut de page ne s'y laissent prendre.
    const y = Math.max(0, window.scrollY) + (hauteurDeployee - hauteur);

    // Le rattrapage du navigateur et l'animation ne sont pas en phase : le
    // temps que l'en-tête change de taille, la mesure ci-dessus reste décalée
    // d'un cran d'animation. On suit donc sans rien décider, pour repartir
    // d'un repère juste une fois l'en-tête stabilisé.
    if (enTrainDeBouger) {
      dernierY = y;
      return;
    }

    // Tant qu'on n'a pas défilé au-delà de la hauteur de l'en-tête, il reste
    // déployé. Le replier plus tôt rendrait plus de place que le défilement
    // n'en a consommé : la page buterait sur son haut, et l'on se retrouverait
    // en tête de page avec un en-tête réduit.
    const delta = y - dernierY;
    let voulu = compact;

    if (y <= hauteurDeployee) voulu = false;
    else if (delta > AMPLITUDE_COMPACT_PX) voulu = true;
    else if (delta < -AMPLITUDE_COMPACT_PX) voulu = false;
    // Geste trop court pour trancher : on garde l'état ET le point de repère,
    // sinon une suite de micro-déplacements ne déclencherait jamais rien.
    else return;

    dernierY = y;

    if (voulu === compact) return;
    basculerEnTete(header, voulu);
    finDuRepli = performance.now() + DUREE_REPLI_MS;
  }

  window.addEventListener(
    "scroll",
    () => {
      if (enAttente) return;
      enAttente = true;
      requestAnimationFrame(evaluer);
    },
    { passive: true }
  );
}

/* ---------- Rendu : contenu principal ---------- */

function render() {
  const appEl = document.getElementById("app");
  appEl.innerHTML = "";
  if (state.mode === "date") {
    renderDateMode(appEl);
  } else {
    renderChapitreMode(appEl);
  }
}

function renderChapitreMode(container) {
  const acronymes = orderedSelectedAcronymes();
  if (!acronymes.length) {
    container.innerHTML = '<p class="empty-message">Sélectionnez au moins un niveau de classe.</p>';
    return;
  }

  acronymes.forEach((acronyme) => {
    const niveauData = state.niveauxData.get(acronyme);
    if (!niveauData) return;

    const section = document.createElement("section");
    section.className = "niveau-section";

    if (acronymes.length > 1) {
      const heading = document.createElement("h2");
      heading.className = "niveau-heading";
      heading.textContent = acronyme;
      section.appendChild(heading);
    }

    if (!niveauData.chapitresList.length) {
      const p = document.createElement("p");
      p.className = "empty-message";
      p.textContent = "Aucun chapitre disponible.";
      section.appendChild(p);
    } else {
      niveauData.chapitresList.forEach((ch) => {
        const details = document.createElement("details");
        details.className = "chapitre";
        // Repère stable pour reposer les chapitres dépliés après un
        // rafraîchissement du contenu — voir redessinerEnPreservantLaVue().
        details.dataset.cle = `${acronyme}::${ch.num}`;

        const summary = document.createElement("summary");
        summary.textContent = `Chapitre ${ch.num} — ${ch.nom}`;
        details.appendChild(summary);

        const body = document.createElement("div");
        body.className = "chapitre-body";

        const sfs = niveauData.sfList
          .filter((sf) => sf.chapitre === ch.num)
          .sort((a, b) => a.numSF - b.numSF);

        if (!sfs.length) {
          body.innerHTML = '<p class="empty-message">Aucun savoir-faire.</p>';
        } else {
          sfs.forEach((sf) => body.appendChild(renderSFCard(acronyme, sf)));
        }

        details.appendChild(body);
        section.appendChild(details);
      });
    }

    container.appendChild(section);
  });
}

/* ---------- Retour haptique ---------- */

// Deux ticks trop rapprochés se confondent en un bourdonnement : passé un
// lancer très vif, on en saute.
const INTERVALLE_TICK_MIN_MS = 28;

let dernierTick = 0;
let interrupteurHaptique = null;

// Safari n'implémente pas navigator.vibrate. Depuis iOS 17.4, basculer un
// <input type="checkbox" switch> déclenche le retour haptique du système :
// c'est le seul levier qu'une page web ait sur l'iPhone. Le contrôle reste
// hors flux et hors tabulation, il n'existe que pour être cliqué par le code.
function interrupteurIOS() {
  if (interrupteurHaptique) return interrupteurHaptique;
  if (!("switch" in document.createElement("input"))) return null;

  const boite = document.createElement("span");
  boite.className = "haptique-ios";
  boite.setAttribute("aria-hidden", "true");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;

  boite.appendChild(input);
  document.body.appendChild(boite);
  interrupteurHaptique = input;
  return input;
}

function tickHaptique() {
  const maintenant = Date.now();
  if (maintenant - dernierTick < INTERVALLE_TICK_MIN_MS) return;
  dernierTick = maintenant;

  // 8 ms : la secousse la plus courte qu'un moteur Android rende encore, donc
  // un « clic » plutôt qu'une vibration. Renvoie false si le navigateur refuse
  // (pas d'interaction utilisateur encore, vibration désactivée…).
  if (typeof navigator.vibrate === "function" && navigator.vibrate(8)) return;

  const interrupteur = interrupteurIOS();
  if (interrupteur) interrupteur.click();
}

/* ---------- Bande de dates défilante ---------- */

// Délai sans le moindre événement de défilement au-delà duquel on considère
// que la bande s'est arrêtée. `scrollend` ferait l'affaire mais manque encore
// à l'appel sur les Safari un peu anciens.
const DELAI_ARRET_MS = 140;

// Déplacement du pointeur en deçà duquel un appui reste un clic : sans cette
// zone morte, la moindre tremblante de la main sur un jour l'empêcherait
// d'être choisi.
const SEUIL_GLISSE_PX = 4;

// Durée, en millisecondes, sur laquelle on prolonge la vitesse du pointeur au
// lâcher pour deviner le jour visé. Réglée à l'oreille : assez pour qu'un
// geste vif franchisse la semaine, assez peu pour qu'un petit coup ne parte
// pas à l'autre bout du planning.
const ELAN_MS = 180;

// Au-delà de ce temps mort avant le lâcher, le pointeur est considéré comme
// arrêté : une vitesse mesurée il y a longtemps ne dit plus rien de
// l'intention, et prolonger l'élan enverrait la bande à l'aventure.
const ELAN_PERIME_MS = 100;

function libelleDateComplet(date) {
  return date.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function dateDepuisISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Jours, triés, où au moins un des niveaux cochés a des savoir-faire prévus.
 *
 *  Le tableur fait seul la liste : un jour sans rien n'aurait rien à montrer,
 *  et c'est ce qui donne à la bande un début et une fin plutôt qu'un rouleau
 *  sans fin de cases vides. */
function joursPlanifies() {
  const isos = new Set();
  for (const acronyme of state.selectedAcronymes) {
    const data = state.niveauxData.get(acronyme);
    if (!data) continue;
    for (const [iso, codes] of data.planning) {
      if (codes && codes.size) isos.add(iso);
    }
  }
  // Les dates ISO se rangent dans l'ordre chronologique par simple tri de
  // chaînes : « 2026-09-02 » vient bien après « 2026-08-31 ».
  return [...isos].sort().map(dateDepuisISO);
}

/** Index, dans `jours`, du jour servant de repère.
 *
 *  Le site sert à préparer le cours suivant : le repère est donc le prochain
 *  jour prévu — demain au plus tôt — et non la date du jour. Faute de jour à
 *  venir (fin d'année, planning épuisé), on se rabat sur le dernier connu. */
function indexJourRepere(jours) {
  const demain = toISODate(addDays(startOfToday(), 1));
  const i = jours.findIndex((j) => toISODate(j) >= demain);
  return i === -1 ? jours.length - 1 : i;
}

/** Monte la bande de jours défilante dans `container`.
 *
 *  Elle s'insère elle-même plutôt que d'être renvoyée : mesurer les positions
 *  des jours suppose d'être déjà dans la page, et le faire dans la foulée de
 *  l'insertion — plutôt qu'à la prochaine image — évite que la bande soit un
 *  instant visible calée sur son premier jour.
 *
 *  @param {HTMLElement} container conteneur, déjà présent dans le document.
 *  @param {Date[]} jours les jours à proposer, dans l'ordre chronologique.
 *  @param {number} indexRepere index, dans `jours`, du jour souligné.
 *  @param {(date: Date) => void} onJourChoisi appelé quand le défilement
 *         s'immobilise sur un jour différent de celui affiché. */
function monterBandeDates(container, jours, indexRepere, onJourChoisi) {
  const nav = document.createElement("div");
  nav.className = "date-nav";

  const bande = document.createElement("div");
  bande.className = "date-strip";
  bande.setAttribute("role", "listbox");
  bande.setAttribute("aria-label", "Choix du jour");
  bande.tabIndex = 0;

  const piste = document.createElement("div");
  piste.className = "date-strip-track";
  bande.appendChild(piste);

  const isos = jours.map(toISODate);

  let jourAffiche = state.selectedDate; // jour actuellement sous le repère central
  let elCourant = null;
  let milieux = []; // abscisse du centre de chaque jour, remesurée à chaque changement de géométrie

  const indexDeDate = (date) => isos.indexOf(toISODate(date));

  function creerItem(date, i) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "date-item";
    el.dataset.iso = isos[i];
    el.textContent = formatDateShort(date);
    el.setAttribute("role", "option");
    el.setAttribute("aria-label", libelleDateComplet(date));
    // Une année de boutons dans l'ordre de tabulation serait un piège au
    // clavier : c'est la bande qui reçoit le focus, et les flèches naviguent.
    el.tabIndex = -1;
    if (i === indexRepere) el.classList.add("is-repere");
    el.addEventListener("click", () => centrerSur(i, true));
    return el;
  }

  piste.replaceChildren(...jours.map(creerItem));

  // Le premier et le dernier jour doivent pouvoir venir au milieu de la bande :
  // sans ces marges, le défilement s'arrêterait avant de les y amener, et les
  // deux bouts du planning resteraient à jamais hors du repère central.
  function ajusterMarges() {
    const premier = piste.firstElementChild;
    if (!premier || !bande.clientWidth) return;
    const demiVide = Math.max(0, (bande.clientWidth - premier.offsetWidth) / 2);
    piste.style.paddingInline = `${demiVide}px`;
  }

  // Abscisse du centre de chaque jour dans le contenu défilable. `offsetLeft`
  // se compte depuis le premier ancêtre positionné, qui n'est pas la bande
  // mais, ici, le corps de la page : sans retrancher l'origine de la piste,
  // toutes les positions seraient décalées de la marge gauche du contenu.
  function mesurer() {
    const origine = piste.offsetLeft;
    milieux = [...piste.children].map((el) => el.offsetLeft - origine + el.offsetWidth / 2);
  }

  function marquerCourant() {
    const el = piste.children[indexDeDate(jourAffiche)];
    if (el === elCourant) return;
    if (elCourant) {
      elCourant.classList.remove("current");
      elCourant.removeAttribute("aria-selected");
    }
    elCourant = el || null;
    if (elCourant) {
      elCourant.classList.add("current");
      elCourant.setAttribute("aria-selected", "true");
    }
  }

  // Jour dont le centre est le plus proche d'une abscisse donnée du contenu
  // défilable. Recherche dichotomique : `milieux` est croissant, et la
  // fonction est appelée à chaque image de défilement.
  function indexLePlusProche(cible) {
    if (!milieux.length) mesurer();

    let bas = 0;
    let haut = milieux.length - 1;
    while (bas < haut) {
      const milieu = (bas + haut) >> 1;
      if (milieux[milieu] < cible) bas = milieu + 1;
      else haut = milieu;
    }
    // `bas` est le premier jour au-delà de la cible : son voisin de gauche peut
    // être plus proche.
    if (bas > 0 && cible - milieux[bas - 1] < milieux[bas] - cible) bas -= 1;
    return bas;
  }

  const indexCentral = () => indexLePlusProche(bande.scrollLeft + bande.clientWidth / 2);

  function centrerSur(index, doux) {
    if (!milieux.length) mesurer();
    const i = Math.min(Math.max(index, 0), milieux.length - 1);
    bande.scrollTo({
      left: milieux[i] - bande.clientWidth / 2,
      behavior: doux ? "smooth" : "auto",
    });
  }

  // La bande a désormais un début et une fin : les flèches doivent le dire,
  // sans quoi on cliquerait dans le vide une fois en butée.
  function majFleches(index) {
    btnPrev.disabled = index <= 0;
    btnNext.disabled = index >= jours.length - 1;
  }

  function surDefilement() {
    const index = indexCentral();
    majFleches(index);
    const date = jours[index];
    if (!date || toISODate(date) === toISODate(jourAffiche)) return;
    jourAffiche = date;
    marquerCourant();
    tickHaptique();
  }

  function surArret() {
    // La dernière position n'a pas forcément été échantillonnée : les images
    // d'animation ne sont pas rendues quand l'onglet passe à l'arrière-plan,
    // alors que cette minuterie, elle, se déclenche quand même.
    surDefilement();
    // L'aimant, suspendu le temps d'un glisser à la souris, reprend son office
    // une fois la bande immobile : le rétablir plus tôt couperait net le
    // défilement doux qui suit le lâcher.
    bande.classList.remove("sans-aimant");
    if (toISODate(jourAffiche) !== toISODate(state.selectedDate)) onJourChoisi(jourAffiche);
  }

  let rafDefilement = null;
  let minuterieArret = null;

  function armerArret() {
    clearTimeout(minuterieArret);
    minuterieArret = setTimeout(surArret, DELAI_ARRET_MS);
  }

  bande.addEventListener(
    "scroll",
    () => {
      if (rafDefilement === null) {
        rafDefilement = requestAnimationFrame(() => {
          rafDefilement = null;
          surDefilement();
        });
      }
      armerArret();
    },
    { passive: true }
  );

  bande.addEventListener("keydown", (e) => {
    const pas = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!pas) return;
    e.preventDefault();
    centrerSur(indexCentral() + pas, true);
  });

  /* --- Glisser à la souris ---
     Le doigt fait déjà défiler la bande ; sur un ordinateur il ne restait que
     les flèches. On rejoue donc le geste tactile : on suit le pointeur, puis
     on prolonge son élan jusqu'au jour visé. L'aimant (scroll-snap) est
     suspendu pendant le geste, sinon chaque position posée à la main serait
     aussitôt ramenée au jour le plus proche et le glisser saccaderait. */
  let glisse = null;
  let glisseAboutie = false; // un vrai déplacement a eu lieu : le clic qui suit n'en est pas un

  bande.addEventListener("pointerdown", (e) => {
    glisseAboutie = false;
    // Doigt et stylet font déjà défiler la bande d'eux-mêmes : les suivre en
    // plus doublerait chaque geste. Seule la souris, elle, n'a rien.
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    glisse = {
      id: e.pointerId,
      xDepart: e.clientX,
      scrollDepart: bande.scrollLeft,
      dernierX: e.clientX,
      dernierT: e.timeStamp,
      vitesse: 0, // px de défilement par ms, positive vers la droite
      active: false,
    };
  });

  bande.addEventListener("pointermove", (e) => {
    if (!glisse || e.pointerId !== glisse.id) return;

    // Bouton relâché hors de la page, avant que la capture n'ait pris : le
    // pointerup ne nous est jamais parvenu. Sans ce garde-fou, la bande
    // suivrait ensuite la souris à vide, sans qu'on appuie sur rien.
    if (!(e.buttons & 1)) {
      finDeGlisse(e);
      return;
    }

    const dx = e.clientX - glisse.xDepart;

    if (!glisse.active) {
      if (Math.abs(dx) < SEUIL_GLISSE_PX) return;
      glisse.active = true;
      // La capture garde le geste vivant même si le pointeur sort de la bande.
      bande.setPointerCapture(e.pointerId);
      bande.classList.add("est-glissee", "sans-aimant");
    }

    e.preventDefault(); // sinon le navigateur amorce une sélection de texte
    bande.scrollLeft = glisse.scrollDepart - dx;

    // Vitesse lissée : une seule paire d'événements suffirait à la fausser
    // (un temps mort de la souris, une image sautée).
    const dt = e.timeStamp - glisse.dernierT;
    if (dt > 0) {
      glisse.vitesse = glisse.vitesse * 0.7 + ((glisse.dernierX - e.clientX) / dt) * 0.3;
      glisse.dernierX = e.clientX;
      glisse.dernierT = e.timeStamp;
    }
  });

  function finDeGlisse(e) {
    if (!glisse || e.pointerId !== glisse.id) return;
    const geste = glisse;
    glisse = null;
    if (!geste.active) return; // simple clic : le jour cliqué s'en charge

    glisseAboutie = true;
    bande.classList.remove("est-glissee");

    // Le pointeur a pu s'immobiliser avant le lâcher : on ne prolonge que les
    // gestes encore en mouvement.
    const arrete = e.timeStamp - geste.dernierT > ELAN_PERIME_MS;
    const elan = arrete ? 0 : geste.vitesse * ELAN_MS;
    centrerSur(indexLePlusProche(bande.scrollLeft + elan + bande.clientWidth / 2), true);

    // Garantit le passage par surArret() — donc le retour de l'aimant — même
    // si la bande était déjà pile en place et que rien ne défile.
    armerArret();
  }

  bande.addEventListener("pointerup", finDeGlisse);
  bande.addEventListener("pointercancel", finDeGlisse);

  // Un glisser se termine sur un jour quelconque : sans ce filtre, le lâcher
  // vaudrait clic et ramènerait la bande sur ce jour-là.
  bande.addEventListener(
    "click",
    (e) => {
      if (!glisseAboutie) return;
      glisseAboutie = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  const btnPrev = document.createElement("button");
  btnPrev.type = "button";
  btnPrev.className = "date-nav-arrow";
  btnPrev.textContent = "◀";
  btnPrev.setAttribute("aria-label", "Jour précédent");
  btnPrev.addEventListener("click", () => centrerSur(indexCentral() - 1, true));

  const btnNext = document.createElement("button");
  btnNext.type = "button";
  btnNext.className = "date-nav-arrow";
  btnNext.textContent = "▶";
  btnNext.setAttribute("aria-label", "Jour suivant");
  btnNext.addEventListener("click", () => centrerSur(indexCentral() + 1, true));

  marquerCourant();
  nav.append(btnPrev, bande, btnNext);
  container.appendChild(nav);

  // Dans la page : mesurable, donc centrable tout de suite.
  ajusterMarges();
  mesurer();
  const indexDepart = Math.max(indexDeDate(state.selectedDate), 0);
  centrerSur(indexDepart, false);
  majFleches(indexDepart);

  // Le centre de la bande se déplace avec sa largeur (rotation de l'écran,
  // fenêtre redimensionnée) : il faut alors replacer le jour affiché. Un
  // observateur plutôt qu'un écouteur sur `window`, pour qu'il disparaisse
  // avec la bande au lieu de s'accumuler à chaque rendu.
  new ResizeObserver(() => {
    if (!bande.clientWidth) return;
    ajusterMarges();
    mesurer();
    centrerSur(indexDeDate(jourAffiche), false);
  }).observe(bande);
}

function renderDateMode(container) {
  const jours = joursPlanifies();

  // Plus de jours vides dans la bande : quand le planning n'en donne aucun,
  // il n'y a pas non plus de bande à monter.
  if (!jours.length) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = state.selectedAcronymes.size
      ? "Aucune date au planning."
      : "Sélectionnez au moins un niveau de classe.";
    container.appendChild(p);
    return;
  }

  const indexRepere = indexJourRepere(jours);

  // Le jour affiché doit exister dans la bande : au tout premier rendu comme
  // après un changement de niveaux, on retombe sur le repère dès que la date
  // en cours n'est plus au programme.
  const isos = jours.map(toISODate);
  if (!state.selectedDate || !isos.includes(toISODate(state.selectedDate))) {
    state.selectedDate = jours[indexRepere];
  }

  const contenu = document.createElement("div");
  contenu.className = "date-contenu";

  // La bande n'est construite qu'une fois : faire défiler les jours ne doit
  // reconstruire que le contenu en dessous, sinon la position de la bande —
  // et l'élan du doigt — seraient perdus à chaque date franchie.
  monterBandeDates(container, jours, indexRepere, (date) => {
    state.selectedDate = date;
    state.openLevels.clear(); // change de jour = on repart avec toutes les vidéos fermées
    renderContenuDate(contenu);
  });
  container.appendChild(contenu);

  renderContenuDate(contenu);
}

function renderContenuDate(container) {
  container.innerHTML = "";

  const acronymes = orderedSelectedAcronymes();
  if (!acronymes.length) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "Sélectionnez au moins un niveau de classe.";
    container.appendChild(p);
    return;
  }

  const iso = toISODate(state.selectedDate);

  // On ne montre "aucun savoir-faire" qu'une seule fois, globalement, si
  // AUCUN des niveaux cochés n'a rien ce jour-là — pas un message vide répété
  // par niveau dès qu'un seul d'entre eux n'a rien à afficher.
  const acronymesAvecSF = acronymes.filter((acronyme) => {
    const niveauData = state.niveauxData.get(acronyme);
    const codes = niveauData && niveauData.planning.get(iso);
    return codes && codes.size > 0;
  });

  if (!acronymesAvecSF.length) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "Aucun savoir-faire prévu ce jour.";
    container.appendChild(p);
  }

  acronymesAvecSF.forEach((acronyme) => {
    const niveauData = state.niveauxData.get(acronyme);

    const section = document.createElement("section");
    section.className = "niveau-section";

    if (acronymes.length > 1) {
      const heading = document.createElement("h2");
      heading.className = "niveau-heading";
      heading.textContent = acronyme;
      section.appendChild(heading);
    }

    const codes = niveauData.planning.get(iso);
    const sfsDuJour = niveauData.sfList.filter((sf) => codes.has(sf.code));
    const chNumsDuJour = [...new Set(sfsDuJour.map((sf) => sf.chapitre))].sort((a, b) => a - b);

    chNumsDuJour.forEach((chNum) => {
      const chInfo = niveauData.chapitresList.find((c) => c.num === chNum);
      const chHeading = document.createElement("h3");
      chHeading.className = "chapitre-groupe-heading";
      chHeading.textContent = chInfo ? `Chapitre ${chInfo.num} — ${chInfo.nom}` : `Chapitre ${chNum}`;
      section.appendChild(chHeading);

      sfsDuJour
        .filter((sf) => sf.chapitre === chNum)
        .sort((a, b) => a.numSF - b.numSF)
        .forEach((sf) => section.appendChild(renderSFCard(acronyme, sf)));
    });

    container.appendChild(section);
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn-clear-day";
  clearBtn.textContent = "🗑️ Effacer la journée";
  clearBtn.addEventListener("click", () => {
    const label = formatDateShort(state.selectedDate);
    if (!window.confirm(`Effacer tous les statuts (✔/✖) enregistrés pour le ${label} ?`)) return;
    clearDayStats(iso);
    render();
  });
  container.appendChild(clearBtn);
}

/* ---------- Format d'image des vidéos (16/9, 4/3, carré, vertical) ---------- */

// Digiview masque l'habillage YouTube en agrandissant son iframe interne d'un
// montant FIXE (top: -230px; height: calc(100% + 460px)) dans un gabarit figé
// en 16/9. YouTube centrant la vidéo dans le lecteur, ce débord tombe pile sur
// les zones vides d'une vidéo 16/9 et ne rogne rien ; mais une vidéo tournée en
// 4/3 est plus haute à largeur égale, et perd alors 12,5 % en haut et 12,5 % en
// bas. Leur video.php prévoit d'autres gabarits, choisis d'après le rapport des
// paramètres largeur/hauteur de l'URL : en 4/3 (mode « tv ») il rétrécit son
// iframe à 75 % de la largeur, et l'image passe entière, entre deux bandes
// noires. D'où cette disjonction de cas, à partir du format réel de la vidéo.
const GABARITS_DIGIVIEW = [
  { seuil: 1.5, params: "largeur=1920&hauteur=1080" },  // 16/9 -> « large »
  { seuil: 1.15, params: "largeur=1440&hauteur=1080" }, // 4/3  -> « tv »
  { seuil: 0.95, params: "largeur=1080&hauteur=1080" }, // 1/1  -> « carre »
  { seuil: 0, params: "largeur=1080&hauteur=1920" },    // 9/16 -> « vertical »
];

function gabaritDigiview(ratio) {
  return GABARITS_DIGIVIEW.find((g) => ratio >= g.seuil).params;
}

// Formats réellement rencontrés sur YouTube : la détection choisit parmi eux.
const RATIOS_VIDEO = [16 / 9, 4 / 3, 1, 9 / 16];

const ratiosVideo = new Map(); // videoId -> ratio (miroir mémoire du localStorage)

function ratioMemorise(videoId) {
  if (ratiosVideo.has(videoId)) return ratiosVideo.get(videoId);
  const stocke = Number(localStorage.getItem(`carnet2maths_ratio_${videoId}`));
  if (stocke > 0) {
    ratiosVideo.set(videoId, stocke);
    return stocke;
  }
  return null;
}

function aimanterRatio(ratio) {
  // Les valeurs mesurées ne tombent pas juste (l'oEmbed renvoie 200x113 pour du
  // 16/9) : on retient le format théorique le plus proche.
  return RATIOS_VIDEO.find((r) => Math.abs(ratio - r) / r < 0.05) || ratio;
}

// Source principale : l'oEmbed de YouTube donne les dimensions du lecteur
// recommandé, qui suivent le format de la vidéo (200x150 en 4/3, 200x113 en
// 16/9). Il sert des en-têtes CORS, donc lisible depuis le site.
async function ratioParOembed(videoId) {
  const reponse = await fetch(
    "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)
  );
  if (!reponse.ok) throw new Error(`oEmbed HTTP ${reponse.status}`);
  const data = await reponse.json();
  if (!data.width || !data.height) throw new Error("oEmbed sans dimensions");
  return data.width / data.height;
}

// Secours si l'oEmbed est indisponible : la vignette hqdefault fait toujours
// 480x360 (4/3) et YouTube y inscrit l'image d'origine en complétant avec des
// bandes noires ; i.ytimg.com renvoie « Access-Control-Allow-Origin: * », on
// peut donc les mesurer dans un canvas.
// Piège : une bande mesurée n'est pas forcément une bande ajoutée — une image
// simplement sombre sur un bord en produit une aussi (26 px mesurés sur une
// vidéo 4/3 qui n'en a pourtant aucune). On ne déduit donc pas le format de la
// mesure : on teste les formats plausibles, on écarte ceux dont les bandes
// attendues sont plus grandes que les bandes mesurées (une vraie bande noire ne
// peut pas être plus petite que prévu, seulement plus grande si l'image est
// sombre), et on garde le plus proche.
function ratioParVignette(videoId) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => reject(new Error("vignette illisible"));
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Seuil à 24/255 : le JPEG délave le noir des bandes.
        const estVide = (x, y) => {
          const i = (y * width + x) * 4;
          return data[i] < 24 && data[i + 1] < 24 && data[i + 2] < 24;
        };
        const ligneVide = (y) => {
          for (let x = 0; x < width; x += 4) if (!estVide(x, y)) return false;
          return true;
        };
        const colonneVide = (x) => {
          for (let y = 0; y < height; y += 4) if (!estVide(x, y)) return false;
          return true;
        };

        let haut = 0;
        while (haut < height && ligneVide(haut)) haut++;
        let bas = height - 1;
        while (bas > haut && ligneVide(bas)) bas--;
        let gauche = 0;
        while (gauche < width && colonneVide(gauche)) gauche++;
        let droite = width - 1;
        while (droite > gauche && colonneVide(droite)) droite--;
        if (droite - gauche < 40 || bas - haut < 40) throw new Error("vignette quasi noire");

        const bandeHaute = Math.min(haut, height - 1 - bas);
        const bandeLaterale = Math.min(gauche, width - 1 - droite);
        const ratioVignette = width / height; // 4/3 pour hqdefault
        const marge = 4;                      // tolérance de mesure

        let choix = null;
        let meilleurEcart = Infinity;
        for (const candidat of RATIOS_VIDEO) {
          const attendueHaute = candidat > ratioVignette ? (height - width / candidat) / 2 : 0;
          const attendueLaterale = candidat < ratioVignette ? (width - height * candidat) / 2 : 0;
          if (bandeHaute < attendueHaute - marge || bandeLaterale < attendueLaterale - marge) continue;
          const ecart = bandeHaute - attendueHaute + (bandeLaterale - attendueLaterale);
          if (ecart < meilleurEcart) {
            meilleurEcart = ecart;
            choix = candidat;
          }
        }
        if (!choix) throw new Error("format non reconnu");
        resolve(choix);
      } catch (err) {
        reject(err);
      }
    };
    img.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  });
}

// Une seule détection par vidéo et par navigateur : le résultat est mémorisé.
async function detecterRatio(videoId) {
  const connu = ratioMemorise(videoId);
  if (connu) return connu;

  let ratio;
  try {
    ratio = aimanterRatio(await ratioParOembed(videoId));
  } catch (_) {
    try {
      ratio = await ratioParVignette(videoId);
    } catch (_) {
      return 16 / 9; // format le plus courant, non mémorisé : on retentera
    }
  }
  ratiosVideo.set(videoId, ratio);
  try {
    localStorage.setItem(`carnet2maths_ratio_${videoId}`, String(ratio));
  } catch (_) { /* quota plein : on garde au moins le cache mémoire */ }
  return ratio;
}

/* ---------- Rendu : carte Savoir-Faire ---------- */

function compteurStat(classe, texte) {
  const el = document.createElement("span");
  el.className = classe;
  el.textContent = texte;
  return el;
}

function renderSFCard(acronyme, sf) {
  const card = document.createElement("div");
  card.className = "sf-card";
  card.dataset.code = sf.code;

  const displayedLevels = Object.keys(sf.niveaux)
    .map(Number)
    .sort((a, b) => a - b);

  const isDateMode = state.mode === "date";
  const currentIso = isDateMode ? toISODate(state.selectedDate) : null;

  const title = document.createElement("p");
  title.className = "sf-title";
  const checkSpan = document.createElement("span");
  checkSpan.className = "sf-check";
  checkSpan.textContent = "✔";
  checkSpan.hidden = true;
  title.appendChild(checkSpan);
  title.appendChild(document.createTextNode(`${sf.code} : ${sf.titre}`));
  card.appendChild(title);

  // En mode Date, la carte a 3 états visuels possibles selon les niveaux 1-2
  // (validation du jour) et les niveaux 3+ (bonus) :
  //   - niveaux ≤2 tous validés (✔)           -> fond vert clair, coche verte
  //   - niveaux ≤2 tous notés mais ≥1 raté (✖) -> fond gris clair, 🤨 à la place de la coche
  //   - niveaux ≥3 tous validés                -> contour vert foncé, coche remplacée par une étoile
  // En mode Chapitre on garde l'ancien indicateur simple (basé sur l'historique).
  function updateCardState() {
    if (!isDateMode) {
      const allValidated =
        displayedLevels.length > 0 &&
        displayedLevels.every((n) => countValidations(acronyme, sf.code, n).vert > 0);
      checkSpan.hidden = !allValidated;
      checkSpan.textContent = "✔";
      card.classList.remove("stage-green", "stage-gray", "stage-border-high");
      return;
    }

    const lowLevels = displayedLevels.filter((n) => n <= 2);
    const highLevels = displayedLevels.filter((n) => n >= 3);
    const lowStatuses = lowLevels.map((n) => getValidationForDate(acronyme, sf.code, n, currentIso));

    const lowAllGreen = lowLevels.length > 0 && lowStatuses.every((v) => v === true);
    const lowAllNoted = lowLevels.length > 0 && lowStatuses.every((v) => v === true || v === false);
    const lowHasRed = lowStatuses.some((v) => v === false);
    const stageGreen = lowAllGreen;
    const stageGray = lowAllNoted && lowHasRed && !lowAllGreen;

    const stageHigh =
      highLevels.length > 0 &&
      highLevels.every((n) => getValidationForDate(acronyme, sf.code, n, currentIso) === true);

    card.classList.toggle("stage-green", stageGreen);
    card.classList.toggle("stage-gray", stageGray);
    card.classList.toggle("stage-border-high", stageHigh);

    // L'étoile ne remplace la coche que si, en plus du bonus (niveaux ≥3),
    // les niveaux 1-2 n'ont aucune erreur — sinon on garde l'indicateur 🤨.
    if (stageHigh && !lowHasRed) {
      checkSpan.hidden = false;
      checkSpan.textContent = "⭐";
    } else if (stageGreen) {
      checkSpan.hidden = false;
      checkSpan.textContent = "✔";
    } else if (stageGray) {
      checkSpan.hidden = false;
      checkSpan.textContent = "🤨";
    } else {
      checkSpan.hidden = true;
    }
  }
  updateCardState();

  if (sf.commentaire) {
    const comment = document.createElement("p");
    comment.className = "sf-comment";
    comment.textContent = sf.commentaire;
    card.appendChild(comment);
  }

  const buttonsWrap = document.createElement("div");
  buttonsWrap.className = "niveau-buttons";

  const videoGrid = document.createElement("div");
  videoGrid.className = "video-grid";

  displayedLevels.forEach((n) => {
    const key = `${acronyme}::${sf.code}::${n}`;

    const item = document.createElement("span");
    item.className = "niveau-item";
    const controlSlot = document.createElement("span");
    controlSlot.className = "niveau-control";
    item.appendChild(controlSlot);

    let statsBadge = null;
    if (!isDateMode) {
      statsBadge = document.createElement("span");
      statsBadge.className = "niveau-stats";
      statsBadge.hidden = true;
      item.appendChild(statsBadge);
    }
    buttonsWrap.appendChild(item);

    function updateStats() {
      if (!statsBadge) return;
      const { vert, rouge } = countValidations(acronyme, sf.code, n);
      statsBadge.hidden = vert === 0 && rouge === 0;
      // Deux éléments plutôt qu'une seule chaîne : le CSS colore les réussites
      // en vert et les échecs en rouge (voir .niveau-stats .stat-ok/.stat-ko).
      statsBadge.replaceChildren(
        compteurStat("stat-ok", `✔${vert}`),
        compteurStat("stat-ko", `✖${rouge}`)
      );
    }
    updateStats();

    // Élément animable (grid 0fr → 1fr) créé/retiré dynamiquement dans
    // video-grid : s'il restait en permanence (même fermé), il réservait
    // quand même une colonne dans la grille (niveau 2 se retrouvait "à
    // droite" même quand niveau 1 n'était pas ouvert), et sa fermeture
    // laissait une case vide fantôme. On ne l'ajoute donc que le temps où
    // le niveau est réellement ouvert (ou en cours de fermeture animée).
    let currentCollapse = null;

    function buildVideo() {
      const vwrap = document.createElement("div");
      vwrap.className = "video-wrap";
      const iframe = document.createElement("iframe");
      const videoId = sf.niveaux[n];

      if (state.videoMode === "nopub") {
        // Digiview (ladigitale.dev) : lecteur sans pub, sans suggestions ni marque YouTube.
        // Le redimensionnement réel est géré en CSS (.video-wrap) ; largeur/hauteur ne
        // servent qu'à choisir le gabarit du lecteur (voir gabaritDigiview).
        const vignette = encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
        let src =
          `https://ladigitale.dev/digiview/inc/video.php?videoId=${videoId}` +
          `&vignette=${vignette}&debut=0`;
        const duree = sf.niveauxFin && sf.niveauxFin[n];
        if (duree) src += `&fin=${duree}`;

        // Le format n'est connu tout de suite que s'il a déjà été détecté (il
        // est ensuite mémorisé) ; sinon il faut une requête. L'aperçu recouvrant
        // le lecteur jusqu'au clic, renseigner l'URL un instant plus tard ne se
        // voit pas — alors qu'un chargement en 16/9 suivi d'une correction, si.
        const ratioConnu = ratioMemorise(videoId);
        if (ratioConnu) {
          iframe.src = `${src}&${gabaritDigiview(ratioConnu)}`;
        } else {
          detecterRatio(videoId).then((ratio) => {
            if (iframe.isConnected) iframe.src = `${src}&${gabaritDigiview(ratio)}`;
          });
        }
        iframe.allow = "picture-in-picture; autoplay; fullscreen";
      } else {
        iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}`;
        iframe.allow =
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      }

      iframe.title = `${sf.code} - Niveau ${n}`;
      iframe.frameBorder = "0";
      iframe.allowFullscreen = true;
      vwrap.appendChild(iframe);

      if (state.videoMode === "nopub") {
        // Avant lecture, Digiview laisse voir l'affiche native de YouTube, et
        // celle-ci est zoomée : pour masquer l'interface YouTube, leur script
        // agrandit l'iframe interne d'un montant FIXE (height: calc(100% +
        // 460px); top: -230px). YouTube y dessine l'affiche en "cover", donc
        // plus le lecteur est petit, plus ces 460px pèsent et plus l'image est
        // rognée (lecteur de 468px de haut ici -> zoom x2). On superpose donc
        // notre propre aperçu, aux bonnes proportions.
        vwrap.appendChild(buildThumbOverlay(videoId, n));
      }

      return vwrap;
    }

    function buildThumbOverlay(videoId, n) {
      const overlay = document.createElement("button");
      overlay.type = "button";
      overlay.className = "video-thumb-overlay";
      overlay.setAttribute("aria-label", `Afficher la vidéo - ${sf.code} Niveau ${n}`);

      const img = document.createElement("img");
      img.alt = "";

      // Chaîne de replis, du plus détaillé au toujours disponible. Deux pièges :
      //   - quand une vignette n'existe pas, YouTube ne renvoie PAS d'erreur
      //     mais une image grise de 120x90 : `onerror` ne se déclenche jamais,
      //     c'est la taille reçue qu'il faut regarder. Sur le catalogue actuel,
      //     11 vidéos sur 41 n'ont pas de maxresdefault (et souvent pas de
      //     sddefault non plus) : sans ce test, elles affichaient ce carré gris
      //     étiré en plein cadre ;
      //   - seul hqdefault est garanti, mais c'est un cadre 4/3. Pour une vidéo
      //     4/3 il contient l'image entière : on l'inscrit en "contain", ce qui
      //     recrée les bandes latérales du lecteur en mode « tv ». Pour une
      //     vidéo 16/9 il contient l'image entre deux bandes horizontales, que
      //     le "cover" habituel retire exactement.
      const VIGNETTES = ["maxresdefault", "sddefault", "hqdefault"];
      let rang = 0;

      const essayerSuivante = () => {
        rang++;
        if (rang >= VIGNETTES.length) return;
        // hqdefault et sddefault sont des cadres 4/3 : l'ajustement dépend du
        // format de la vidéo, connu (et mémorisé) par la détection.
        detecterRatio(videoId).then((ratio) => {
          img.classList.toggle("est-ajustee", ratio < 1.5);
          img.src = `https://i.ytimg.com/vi/${videoId}/${VIGNETTES[rang]}.jpg`;
        });
      };

      img.onerror = essayerSuivante;
      img.onload = () => {
        if (img.naturalWidth <= 120) essayerSuivante(); // vignette grise "absente"
      };
      // maxresdefault est un cadre 16/9 quel que soit le format de la vidéo
      // (une 4/3 y est déjà entre deux bandes) : le "cover" par défaut
      // reproduit alors exactement ce que montrera le lecteur.
      img.src = `https://i.ytimg.com/vi/${videoId}/${VIGNETTES[0]}.jpg`;

      const play = document.createElement("span");
      play.className = "video-thumb-play";
      // Triangle dessiné en CSS pur (voir .video-thumb-play::after), pas un
      // caractère "▶" : son rendu dépend de la police/du système et n'est
      // jamais exactement centré optiquement.
      play.setAttribute("aria-hidden", "true");

      overlay.append(img, play);

      // L'aperçu reçoit lui-même le clic et se retire : il faut donc un clic
      // de plus pour lancer la vidéo (bouton de lecture de Digiview en
      // dessous). C'est volontaire — laisser le clic « traverser »
      // (pointer-events: none) pour économiser ce clic a été essayé et casse
      // dans deux cas :
      //   - plusieurs vidéos ouvertes : le retrait de l'aperçu se détectait
      //     via l'événement `blur` de la page, qui ne se déclenche plus une
      //     fois le focus déjà passé dans une première iframe ;
      //   - sur mobile : le clic arrive souvent avant que Digiview ait fini
      //     d'initialiser son lecteur YouTube, et il est purement perdu.
      // Ces deux états sont indétectables depuis l'extérieur (iframe d'un
      // autre domaine), d'où ce retour à un clic explicite, toujours fiable.
      overlay.addEventListener("click", () => overlay.remove());

      return overlay;
    }

    function createCollapseElement() {
      const collapse = document.createElement("div");
      collapse.className = "video-collapse";
      // Toujours affichée dans l'ordre des niveaux, peu importe l'ordre des
      // clics (ex. Niveau 2 ouvert avant Niveau 1 doit quand même apparaître après).
      collapse.style.order = n;
      const inner = document.createElement("div");
      inner.className = "video-collapse-inner";
      inner.appendChild(buildVideo());
      // Point d'entrée du changement de lecteur sans rendu complet
      // (voir rechargerLecteursOuverts) : `buildVideo` lit `state.videoMode`
      // au moment de l'appel, il suffit donc de rebâtir au même endroit.
      inner.rebatirLecteur = () => inner.replaceChildren(buildVideo());
      collapse.appendChild(inner);
      return collapse;
    }

    function openVideoAnimated() {
      const collapse = createCollapseElement();
      videoGrid.appendChild(collapse);
      void collapse.getBoundingClientRect(); // fige l'état 0fr avant de passer à 1fr
      collapse.classList.add("is-open");
      currentCollapse = collapse;
    }

    function closeVideoAnimated() {
      const collapse = currentCollapse;
      if (!collapse) return;
      currentCollapse = null;
      collapse.classList.remove("is-open");
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        collapse.remove(); // retire la case de la grille, plus d'artefact résiduel
      };
      collapse.addEventListener("transitionend", cleanup, { once: true });
      // Filet de sécurité si la transition ne se déclenche pas (clics très
      // rapprochés, animations réduites, etc.) pour ne jamais laisser une
      // iframe vidéo orpheline en arrière-plan.
      setTimeout(cleanup, 350);
    }

    function renderControl() {
      const rawState = state.openLevels.get(key) || "closed";
      // Le mode Chapitre ne connaît que ouvert/fermé : jamais de scission en boutons de validation.
      const levelState = isDateMode ? rawState : rawState === "closed" ? "closed" : "open";
      controlSlot.innerHTML = "";

      if (levelState === "split") {
        const wrap = document.createElement("span");
        wrap.className = "btn-split";

        const btnValider = document.createElement("button");
        btnValider.type = "button";
        btnValider.className = "btn-valider";
        btnValider.textContent = "✔";
        btnValider.title = `Valider Niveau ${n}`;
        btnValider.addEventListener("click", () => {
          setValidationForDate(acronyme, sf.code, n, currentIso, true);
          state.openLevels.delete(key);
          renderControl();
          closeVideoAnimated();
          updateCardState();
          updateStats();
        });

        const btnFermer = document.createElement("button");
        btnFermer.type = "button";
        btnFermer.className = "btn-fermer";
        btnFermer.textContent = "✕";
        btnFermer.title = "Réinitialiser le statut";
        btnFermer.addEventListener("click", () => {
          clearValidationForDate(acronyme, sf.code, n, currentIso);
          state.openLevels.delete(key);
          renderControl();
          closeVideoAnimated();
          updateCardState();
          updateStats();
        });

        const btnInvalider = document.createElement("button");
        btnInvalider.type = "button";
        btnInvalider.className = "btn-invalider";
        btnInvalider.textContent = "✖";
        btnInvalider.title = `Rater Niveau ${n}`;
        btnInvalider.addEventListener("click", () => {
          setValidationForDate(acronyme, sf.code, n, currentIso, false);
          state.openLevels.delete(key);
          renderControl();
          closeVideoAnimated();
          updateCardState();
          updateStats();
        });

        wrap.append(btnValider, btnFermer, btnInvalider);
        controlSlot.appendChild(wrap);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-niveau";
        if (levelState === "open") {
          btn.classList.add("is-open");
        } else if (isDateMode) {
          const v = getValidationForDate(acronyme, sf.code, n, currentIso);
          if (v === true) btn.classList.add("is-validated");
          else if (v === false) btn.classList.add("is-invalidated");
        }
        btn.textContent = `Niveau ${n}`;
        btn.addEventListener("click", () => {
          if (levelState === "closed") {
            state.openLevels.set(key, "open");
            renderControl();
            openVideoAnimated();
          } else if (isDateMode) {
            state.openLevels.set(key, "split");
            renderControl(); // la vidéo reste affichée, pas d'animation nécessaire
          } else {
            state.openLevels.delete(key); // mode Chapitre : 2e clic referme, sans statut
            renderControl();
            closeVideoAnimated();
          }
        });
        controlSlot.appendChild(btn);
      }
    }

    renderControl();

    // État déjà ouvert lors d'un rendu complet (changement de date/chapitre) :
    // on affiche la vidéo directement, sans animation (rien n'était visible avant).
    const initialRaw = state.openLevels.get(key) || "closed";
    const initialState = isDateMode ? initialRaw : initialRaw === "closed" ? "closed" : "open";
    if (initialState === "open" || initialState === "split") {
      currentCollapse = createCollapseElement();
      currentCollapse.classList.add("is-open");
      videoGrid.appendChild(currentCollapse);
    }
  });

  card.appendChild(buttonsWrap);
  card.appendChild(videoGrid);

  return card;
}

/* ---------- Fenêtre du choix des niveaux de classe ---------- */

// Une seule fenêtre pour deux moments : l'accueil de la première visite
// (`premiereVisite`), où rien n'est coché, où « Commencer » reste éteint tant
// qu'aucun niveau ne l'est, et d'où l'on ne sort qu'en choisissant ; et le
// réglage rouvert depuis l'en-tête, qui part du choix en cours et se referme
// sans rien changer si on l'annule.
let fenetreNiveauxOuverte = null;

function ouvrirFenetreNiveaux({ premiereVisite = false, onValider, renvoyerFocusVers = null } = {}) {
  if (fenetreNiveauxOuverte) return;

  const fond = document.createElement("div");
  fond.className = "modal-fond";

  const card = document.createElement("div");
  card.className = "onboarding";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "fenetre-niveaux-titre");

  const titre = document.createElement("h2");
  titre.className = "onboarding-title";
  titre.id = "fenetre-niveaux-titre";
  titre.textContent = premiereVisite
    ? "Sélectionne les niveaux qui t'intéressent"
    : "Niveaux de classe affichés";

  const liste = document.createElement("div");
  liste.className = "onboarding-list";

  const actions = document.createElement("div");
  actions.className = "onboarding-actions";

  const valider = document.createElement("button");
  valider.type = "button";
  valider.className = "onboarding-start";
  valider.textContent = premiereVisite ? "Commencer" : "Valider";
  valider.disabled = premiereVisite;

  // Première visite : tout est décoché, le choix reste à faire. Les fois
  // suivantes, la fenêtre s'ouvre sur l'état courant.
  const choisis = new Set(premiereVisite ? [] : state.selectedAcronymes);

  getSortedNiveaux().forEach((n) => {
    const item = document.createElement("label");
    item.className = "onboarding-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = n.acronyme;
    cb.checked = choisis.has(n.acronyme);
    item.classList.toggle("is-checked", cb.checked);
    cb.addEventListener("change", () => {
      if (cb.checked) choisis.add(n.acronyme);
      else choisis.delete(n.acronyme);
      item.classList.toggle("is-checked", cb.checked);
      valider.disabled = choisis.size === 0; // il doit toujours en rester un coché
    });

    const texte = document.createElement("span");
    texte.textContent = n.acronyme;

    item.append(cb, texte);
    liste.appendChild(item);
  });

  card.append(titre, liste);

  // La croix, la touche Échap, le clic à côté et le bouton « Annuler »
  // n'existent que pour la fenêtre rouverte : à la première visite, il n'y a
  // pas encore de « à côté » où revenir.
  const focusAvant = renvoyerFocusVers || document.activeElement;

  function fermer() {
    if (fenetreNiveauxOuverte !== fond) return;
    fenetreNiveauxOuverte = null;
    document.removeEventListener("keydown", surTouche, true);
    document.body.classList.remove("modal-ouvert");
    fond.classList.remove("is-visible");
    const retirer = () => fond.remove();
    fond.addEventListener("transitionend", retirer, { once: true });
    setTimeout(retirer, 400); // filet si la transition n'a pas lieu
    if (focusAvant && focusAvant.focus) focusAvant.focus();
  }

  // Le clavier ne doit pas sortir de la fenêtre tant qu'elle est ouverte : la
  // page derrière est inerte, tabuler jusqu'à elle ne mènerait nulle part.
  function surTouche(e) {
    if (e.key === "Escape" && !premiereVisite) {
      e.preventDefault();
      fermer();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = [...card.querySelectorAll("input, button")].filter((el) => !el.disabled);
    if (!focusables.length) return;
    const premier = focusables[0];
    const dernier = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === premier) {
      e.preventDefault();
      dernier.focus();
    } else if (!e.shiftKey && document.activeElement === dernier) {
      e.preventDefault();
      premier.focus();
    }
  }

  if (!premiereVisite) {
    const croix = document.createElement("button");
    croix.type = "button";
    croix.className = "onboarding-close";
    croix.setAttribute("aria-label", "Fermer");
    croix.textContent = "✕";
    croix.addEventListener("click", fermer);
    card.prepend(croix);

    const annuler = document.createElement("button");
    annuler.type = "button";
    annuler.className = "onboarding-cancel";
    annuler.textContent = "Annuler";
    annuler.addEventListener("click", fermer);
    actions.appendChild(annuler);

    fond.addEventListener("click", (e) => {
      if (e.target === fond) fermer();
    });
  }

  valider.addEventListener("click", () => {
    if (!choisis.size) return;
    // On rend la liste dans l'ordre d'affichage des niveaux, pas dans celui
    // des clics : c'est cet ordre-là qui gouverne le reste de la page.
    const retenus = getSortedNiveaux()
      .map((n) => n.acronyme)
      .filter((a) => choisis.has(a));
    fermer();
    onValider(retenus);
  });
  actions.appendChild(valider);

  card.appendChild(actions);
  fond.appendChild(card);
  document.body.appendChild(fond);
  document.body.classList.add("modal-ouvert");
  fenetreNiveauxOuverte = fond;
  document.addEventListener("keydown", surTouche, true);

  // Forcer un calcul de mise en page fige l'état fermé avant qu'on ne pose la
  // classe : sans cela le navigateur peint directement l'état final, sans
  // transition. On ne passe pas par requestAnimationFrame, qui ne se déclenche
  // pas tant que l'onglet est en arrière-plan — la fenêtre resterait invisible
  // au premier plan retrouvé.
  void fond.offsetHeight;
  fond.classList.add("is-visible");

  const premierChamp = card.querySelector("input");
  if (premierChamp) premierChamp.focus({ preventScroll: true });
}

// Les contrôles d'en-tête n'ont pas de sens pendant le choix initial, et
// l'indicateur glissant des bascules se calcule mal sur un élément masqué :
// on les affiche donc seulement une fois le choix fait.
function setHeaderControlsVisible(visible) {
  document.getElementById("mode-row").hidden = !visible;
  document.getElementById("video-mode-toggle").hidden = !visible;
}

/* ---------- Rafraîchissement du contenu au retour au premier plan ---------- */

// Le contenu pédagogique change sans que le site soit redéployé : remplacer un
// classeur dans /contenu suffit. Une page déjà ouverte, elle, garde en mémoire
// ce qu'elle a lu au chargement (state.niveauxData) et ne redemande plus rien.
// L'app installée sur un téléphone, qui survit des jours en arrière-plan,
// pourrait ainsi afficher indéfiniment un planning périmé.
//
// On redemande donc les fichiers quand l'app revient au premier plan, mais
// seulement après une absence assez longue pour qu'un changement soit
// plausible : basculer trois secondes vers une autre app ne doit rien
// déclencher.
const DELAI_AVANT_RAFRAICHISSEMENT_MS = 30 * 60 * 1000; // 30 minutes

let dernierChargement = Date.now();
let rafraichissementEnCours = false;

/** Rendu complet, mais sans faire perdre sa place au lecteur : render() repart
 *  de zéro, donc referme les chapitres dépliés et remonte la page en haut.
 *  Passe encore au chargement ; brutal pour quelqu'un qui vient de retrouver
 *  son écran. */
function redessinerEnPreservantLaVue() {
  const appEl = document.getElementById("app");
  const ouverts = new Set(
    [...appEl.querySelectorAll("details.chapitre[open]")].map((d) => d.dataset.cle)
  );
  const defilement = window.scrollY;

  render();

  appEl.querySelectorAll("details.chapitre").forEach((d) => {
    if (ouverts.has(d.dataset.cle)) d.open = true;
  });
  window.scrollTo(0, defilement);
}

/** Relit option.json et les classeurs déjà chargés, et ne redessine que si
 *  quelque chose a réellement bougé — le cas ordinaire étant qu'il n'y ait rien
 *  de neuf, et donc rien à déranger à l'écran.
 *
 *  Tout est relu avant qu'on ne touche à l'état : un fichier qui manque à
 *  l'appel ne doit pas laisser la page moitié à jour, moitié périmée. */
async function rafraichirContenu() {
  if (rafraichissementEnCours) return;
  rafraichissementEnCours = true;
  try {
    const option = await chargerOption();
    if (!option.data.niveaux || !option.data.niveaux.length) return;

    // Un niveau affiché que le nouveau option.json ne connaît plus : on ne
    // saurait pas quoi mettre à sa place sans refaire le choix de
    // l'utilisateur. On laisse la page en l'état, un rechargement complet s'en
    // chargera.
    const connus = new Map(option.data.niveaux.map((n) => [n.acronyme, n]));
    const charges = [...state.niveauxData.keys()];
    if (charges.some((a) => !connus.has(a))) return;

    const relus = await Promise.all(charges.map((a) => loadNiveauData(connus.get(a))));
    dernierChargement = Date.now();

    const change =
      option.empreinte !== state.optionEmpreinte ||
      relus.some((data, i) => data.empreinte !== state.niveauxData.get(charges[i]).empreinte);
    if (!change) return;

    state.optionData = option.data;
    state.optionEmpreinte = option.empreinte;
    relus.forEach((data, i) => state.niveauxData.set(charges[i], data));

    redessinerEnPreservantLaVue();
  } catch (_) {
    // Réseau absent, fichier illisible : on garde ce qui est affiché.
    // dernierChargement n'a pas bougé, donc on retentera au prochain retour.
  } finally {
    rafraichissementEnCours = false;
  }
}

function rafraichirSiNecessaire() {
  if (document.visibilityState !== "visible") return;
  if (!state.optionData || !state.niveauxData.size) return; // rien encore affiché
  if (Date.now() - dernierChargement < DELAI_AVANT_RAFRAICHISSEMENT_MS) return;
  rafraichirContenu();
}

document.addEventListener("visibilitychange", rafraichirSiNecessaire);

// Un onglet restauré depuis le cache de navigation arrière/avant (iOS surtout)
// reprend tel qu'il a été quitté, sans forcément repasser par visibilitychange.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) rafraichirSiNecessaire();
});

/* ---------- Démarrage ---------- */

async function demarrer(appEl) {
  initNiveauBtn();
  renderModeToggle();
  renderVideoModeToggle();
  // Le bouton des niveaux vient peut-être d'apparaître : la rangée n'a plus la
  // même largeur qu'au chargement de la page.
  ajusterLibelleAffichage();

  appEl.innerHTML = '<p class="empty-message">Chargement…</p>';
  try {
    await Promise.all([...state.selectedAcronymes].map((a) => ensureNiveauLoaded(a)));
  } catch (err) {
    appEl.innerHTML = `<p class="empty-message">Erreur de chargement (${err.message}).</p>`;
    return;
  }

  dernierChargement = Date.now();
  render();
}

async function boot() {
  const appEl = document.getElementById("app");

  // Avant tout chargement : le bouton du thème ne dépend d'aucune donnée, et
  // doit répondre dès la première seconde. Il vit dans la rangée « Affichage »,
  // donc l'écran de première visite le masque avec elle — mais là, personne
  // n'a encore rien choisi, et le réglage du système fait seul la loi.
  initThemeToggle();
  surveillerDefilementPage();
  let option;
  try {
    option = await chargerOption();
  } catch (err) {
    appEl.innerHTML = `<p class="empty-message">Impossible de charger option.json (${err.message}).</p>`;
    return;
  }

  const optionData = option.data;

  if (!optionData.niveaux || !optionData.niveaux.length) {
    appEl.innerHTML = '<p class="empty-message">Aucun niveau de classe configuré dans option.json.</p>';
    return;
  }

  state.optionData = optionData;
  state.optionEmpreinte = option.empreinte;
  const acronymes = optionData.niveaux.map((n) => n.acronyme);

  loadPersistedGlobalState(acronymes);

  // Première visite = aucun choix encore enregistré. On ne pose la question
  // que s'il y a réellement plusieurs niveaux : avec un seul, le choix serait
  // une case à cocher unique et obligatoire, donc inutile.
  const premiereVisite = localStorage.getItem("carnet2maths_selectedNiveaux") === null;

  if (premiereVisite && optionData.niveaux.length > 1) {
    setHeaderControlsVisible(false);
    appEl.innerHTML = ""; // rien derrière la fenêtre : il n'y a encore rien à montrer
    ouvrirFenetreNiveaux({
      premiereVisite: true,
      onValider: (choisis) => {
        state.selectedAcronymes = new Set(choisis);
        saveSelectedNiveaux();
        setHeaderControlsVisible(true);
        demarrer(appEl);
      },
    });
    return;
  }

  if (premiereVisite) saveSelectedNiveaux(); // niveau unique : on l'enregistre sans rien demander

  await demarrer(appEl);
}

boot();
