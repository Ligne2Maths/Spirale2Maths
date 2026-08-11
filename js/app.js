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
  niveauxData: new Map(),   // acronyme -> { config, sfList, planning, chapitresList }
  selectedAcronymes: new Set(),
  mode: "date",
  videoMode: "nopub",       // "ytb" (lecteur YouTube classique) | "nopub" (iframe Digiview, sans pub)
  validations: {},          // { acronyme: { code: { n: { dateISO: true|false } } } } — une entrée par date où le niveau a été fait
  selectedDate: startOfToday(),
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

  return { config: niveauConfig, sfList, planning, chapitresList };
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

function renderNiveauToggles() {
  const container = document.getElementById("niveau-toggles");
  container.innerHTML = "";

  getSortedNiveaux().forEach((n) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toggle-btn";
    if (state.selectedAcronymes.has(n.acronyme)) btn.classList.add("active");
    btn.textContent = n.acronyme;
    btn.addEventListener("click", () => onToggleNiveau(n.acronyme, btn));
    container.appendChild(btn);
  });
}

async function onToggleNiveau(acronyme, btn) {
  const isActive = state.selectedAcronymes.has(acronyme);

  if (isActive) {
    if (state.selectedAcronymes.size === 1) return; // il doit toujours en rester un coché
    state.selectedAcronymes.delete(acronyme);
    btn.classList.remove("active");
    saveSelectedNiveaux();
    render();
    return;
  }

  state.selectedAcronymes.add(acronyme);
  btn.classList.add("active");
  saveSelectedNiveaux();

  if (!state.niveauxData.has(acronyme)) {
    const appEl = document.getElementById("app");
    appEl.innerHTML = `<p class="empty-message">Chargement de ${acronyme}…</p>`;
    try {
      await ensureNiveauLoaded(acronyme);
    } catch (err) {
      state.selectedAcronymes.delete(acronyme);
      btn.classList.remove("active");
      saveSelectedNiveaux();
      appEl.innerHTML = `<p class="empty-message">Impossible de charger "${acronyme}" (${err.message}).</p>`;
      return;
    }
  }

  render();
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

  moveIndicator(container.querySelector(".segment-btn.active"), false);

  window.addEventListener("resize", () => {
    moveIndicator(container.querySelector(".segment-btn.active"), false);
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
      render(); // reconstruit les vidéos déjà ouvertes avec le nouveau lecteur
    };
  });

  moveIndicator(container.querySelector(".segment-btn.active"), false);

  window.addEventListener("resize", () => {
    moveIndicator(container.querySelector(".segment-btn.active"), false);
  });
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

function renderDateMode(container) {
  const nav = document.createElement("div");
  nav.className = "date-nav";

  const prevDate = addDays(state.selectedDate, -1);
  const nextDate = addDays(state.selectedDate, 1);
  const todayIso = toISODate(startOfToday());

  const goTo = (date) => {
    state.selectedDate = date;
    state.openLevels.clear(); // change de jour = on repart avec toutes les vidéos fermées
    render();
  };

  const btnPrev = document.createElement("button");
  btnPrev.type = "button";
  btnPrev.className = "date-nav-arrow";
  btnPrev.textContent = "◀";
  btnPrev.setAttribute("aria-label", "Jour précédent");
  btnPrev.addEventListener("click", () => goTo(prevDate));

  const spanPrev = document.createElement("span");
  spanPrev.className = "date-item adjacent";
  if (toISODate(prevDate) === todayIso) spanPrev.classList.add("is-today");
  spanPrev.textContent = formatDateShort(prevDate);
  spanPrev.addEventListener("click", () => goTo(prevDate));

  const spanCurrent = document.createElement("span");
  spanCurrent.className = "date-item current";
  if (toISODate(state.selectedDate) === todayIso) spanCurrent.classList.add("is-today");
  spanCurrent.textContent = formatDateShort(state.selectedDate);

  const spanNext = document.createElement("span");
  spanNext.className = "date-item adjacent";
  if (toISODate(nextDate) === todayIso) spanNext.classList.add("is-today");
  spanNext.textContent = formatDateShort(nextDate);
  spanNext.addEventListener("click", () => goTo(nextDate));

  const btnNext = document.createElement("button");
  btnNext.type = "button";
  btnNext.className = "date-nav-arrow";
  btnNext.textContent = "▶";
  btnNext.setAttribute("aria-label", "Jour suivant");
  btnNext.addEventListener("click", () => goTo(nextDate));

  nav.append(btnPrev, spanPrev, spanCurrent, spanNext, btnNext);
  container.appendChild(nav);

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

/* ---------- Rendu : carte Savoir-Faire ---------- */

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
      statsBadge.textContent = `✔${vert} ✖${rouge}`;
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
        // Le redimensionnement réel est géré en CSS (.video-wrap), largeur/hauteur ici ne
        // fixent que la résolution interne du lecteur.
        const vignette = encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
        let src =
          `https://ladigitale.dev/digiview/inc/video.php?videoId=${videoId}` +
          `&vignette=${vignette}&debut=0`;
        const duree = sf.niveauxFin && sf.niveauxFin[n];
        if (duree) src += `&fin=${duree}`;
        src += `&largeur=1920&hauteur=1080`;
        iframe.src = src;
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
      img.onerror = () => {
        img.onerror = null;
        img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`; // toujours disponible, en 16:9
      };
      img.src = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`; // meilleure qualité si dispo

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

/* ---------- Première visite : choix des niveaux ---------- */

// Écran affiché tant que l'utilisateur n'a jamais choisi ses niveaux de
// classe. Rien n'est coché au départ et "Commencer" reste désactivé tant
// qu'aucun niveau n'est sélectionné.
function renderOnboarding(container, onCommencer) {
  container.innerHTML = "";

  const card = document.createElement("div");
  card.className = "onboarding";

  const titre = document.createElement("h2");
  titre.className = "onboarding-title";
  titre.textContent = "Sélectionne les niveaux qui t'intéressent";
  card.appendChild(titre);

  const liste = document.createElement("div");
  liste.className = "onboarding-list";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "onboarding-start";
  btn.textContent = "Commencer";
  btn.disabled = true;

  const choisis = new Set();

  getSortedNiveaux().forEach((n) => {
    const item = document.createElement("label");
    item.className = "onboarding-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = n.acronyme;
    cb.addEventListener("change", () => {
      if (cb.checked) choisis.add(n.acronyme);
      else choisis.delete(n.acronyme);
      item.classList.toggle("is-checked", cb.checked);
      btn.disabled = choisis.size === 0;
    });

    const texte = document.createElement("span");
    texte.textContent = n.acronyme;

    item.append(cb, texte);
    liste.appendChild(item);
  });

  card.appendChild(liste);

  btn.addEventListener("click", () => {
    if (!choisis.size) return;
    onCommencer([...choisis]);
  });
  card.appendChild(btn);

  container.appendChild(card);
}

// Les contrôles d'en-tête n'ont pas de sens pendant le choix initial, et
// l'indicateur glissant des bascules se calcule mal sur un élément masqué :
// on les affiche donc seulement une fois le choix fait.
function setHeaderControlsVisible(visible) {
  document.getElementById("mode-row").hidden = !visible;
  document.getElementById("video-mode-toggle").hidden = !visible;
}

/* ---------- Démarrage ---------- */

async function demarrer(appEl) {
  renderNiveauToggles();
  renderModeToggle();
  renderVideoModeToggle();

  const niveauRow = document.getElementById("niveau-row");
  if (state.optionData.niveaux.length > 1) niveauRow.hidden = false;

  appEl.innerHTML = '<p class="empty-message">Chargement…</p>';
  try {
    await Promise.all([...state.selectedAcronymes].map((a) => ensureNiveauLoaded(a)));
  } catch (err) {
    appEl.innerHTML = `<p class="empty-message">Erreur de chargement (${err.message}).</p>`;
    return;
  }

  render();
}

async function boot() {
  const appEl = document.getElementById("app");
  let optionData;
  try {
    const res = await fetch("option.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    optionData = await res.json();
  } catch (err) {
    appEl.innerHTML = `<p class="empty-message">Impossible de charger option.json (${err.message}).</p>`;
    return;
  }

  if (!optionData.niveaux || !optionData.niveaux.length) {
    appEl.innerHTML = '<p class="empty-message">Aucun niveau de classe configuré dans option.json.</p>';
    return;
  }

  state.optionData = optionData;
  const acronymes = optionData.niveaux.map((n) => n.acronyme);

  loadPersistedGlobalState(acronymes);

  // Première visite = aucun choix encore enregistré. On ne pose la question
  // que s'il y a réellement plusieurs niveaux : avec un seul, le choix serait
  // une case à cocher unique et obligatoire, donc inutile.
  const premiereVisite = localStorage.getItem("carnet2maths_selectedNiveaux") === null;

  if (premiereVisite && optionData.niveaux.length > 1) {
    setHeaderControlsVisible(false);
    renderOnboarding(appEl, (choisis) => {
      state.selectedAcronymes = new Set(choisis);
      saveSelectedNiveaux();
      setHeaderControlsVisible(true);
      demarrer(appEl);
    });
    return;
  }

  if (premiereVisite) saveSelectedNiveaux(); // niveau unique : on l'enregistre sans rien demander

  await demarrer(appEl);
}

boot();
