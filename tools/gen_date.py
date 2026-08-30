"""
gen_date.py

Demande une date de début puis une date de fin (format JJ/MM/AAAA) et génère
toutes les dates de l'intervalle qui tombent un jour ouvré (lundi à vendredi).
La liste est placée dans le presse-papier séparée par des tabulations : un
simple Ctrl+V dans Excel étale les dates sur une seule ligne, une par colonne
(comme les en-têtes de dates de la feuille 2 des tableurs de contenu/).

Dépendance (facultative sous Windows, où l'utilitaire "clip" prend le relais) :
    pip install pyperclip

Utilisation :
    python tools/gen_date.py
"""

import subprocess
import sys
from datetime import datetime, timedelta

try:
    import pyperclip
except ImportError:
    pyperclip = None

FORMAT_DATE = "%d/%m/%Y"
JOURS_OUVRES = (0, 1, 2, 3, 4)  # date.weekday() : lundi = 0 ... vendredi = 4


def copier(texte):
    """Place `texte` dans le presse-papier (pyperclip, ou "clip" sous Windows)."""
    if pyperclip is not None:
        pyperclip.copy(texte)
        return
    if sys.platform == "win32":
        # Le texte généré est purement ASCII : aucun souci d'encodage avec clip.
        subprocess.run(["clip"], input=texte.encode("utf-8"), check=True)
        return
    raise RuntimeError("le module 'pyperclip' est requis (pip install pyperclip)")


def demander_date(invite):
    """Lit une date au format JJ/MM/AAAA, en redemandant tant qu'elle est invalide."""
    while True:
        saisie = input(invite).strip()
        try:
            return datetime.strptime(saisie, FORMAT_DATE).date()
        except ValueError:
            print("  Format attendu : JJ/MM/AAAA (ex : 01/09/2026).")


def generer_dates(debut, fin):
    """Renvoie les jours du lundi au vendredi compris entre `debut` et `fin` inclus."""
    dates = []
    jour = debut
    while jour <= fin:
        if jour.weekday() in JOURS_OUVRES:
            dates.append(jour)
        jour += timedelta(days=1)
    return dates


def pause():
    """Évite que la fenêtre se referme aussitôt lors d'un lancement par double-clic."""
    try:
        input("\nAppuyez sur Entrée pour fermer...")
    except EOFError:
        pass


def main():
    print("=== Carnet2Maths - génération des dates ouvrées (lundi à vendredi) ===")
    print()

    debut = demander_date("Date de début (JJ/MM/AAAA) : ")
    while True:
        fin = demander_date("Date de fin   (JJ/MM/AAAA) : ")
        if fin >= debut:
            break
        print("  La date de fin doit être postérieure ou égale à la date de début.")

    dates = generer_dates(debut, fin)
    if not dates:
        print("\nAucun jour ouvré dans cet intervalle : presse-papier inchangé.")
        return

    # Séparateur tabulation : Excel place alors chaque date dans sa propre colonne,
    # toutes sur la même ligne.
    texte = "\t".join(jour.strftime(FORMAT_DATE) for jour in dates)

    try:
        copier(texte)
    except Exception as erreur:
        print(f"\nCopie impossible ({erreur}). Dates générées :")
        print(texte)
        return

    print(
        f"\n{len(dates)} date(s) copiée(s) dans le presse-papier "
        f"({dates[0].strftime(FORMAT_DATE)} -> {dates[-1].strftime(FORMAT_DATE)})."
    )
    print("Ctrl+V dans Excel pour les coller sur une seule ligne, une date par colonne.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nArrêt.")
    finally:
        pause()
