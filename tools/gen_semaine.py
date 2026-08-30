"""
gen_semaine.py

Demande une date de début puis une date de fin (format JJ/MM/AAAA) et génère
deux colonnes, une ligne par semaine de l'intervalle : le numéro de semaine
(norme ISO 8601, celle utilisée pour les semaines scolaires) et la date du
lundi correspondant. Si l'intervalle commence ou se termine en milieu de
semaine, la date affichée est le premier jour ouvré de cette semaine réellement
compris dans l'intervalle ; les semaines sans aucun jour ouvré sont ignorées.
Le tout est placé dans le presse-papier : un Ctrl+V dans Excel remplit les deux
colonnes côte à côte.

Réutilise tools/gen_date.py (saisie des dates, jours ouvrés, copie, pause).

Dépendance (facultative sous Windows, où l'utilitaire "clip" prend le relais) :
    pip install pyperclip

Utilisation :
    python tools/gen_semaine.py
"""

from gen_date import FORMAT_DATE, copier, demander_date, generer_dates, pause


def grouper_par_semaine(dates):
    """Renvoie [(n° de semaine ISO, 1re date de la semaine)] pour `dates` triées."""
    semaines = []
    cle_precedente = None
    for jour in dates:
        annee_iso, numero, _ = jour.isocalendar()
        if (annee_iso, numero) != cle_precedente:
            semaines.append((numero, jour))
            cle_precedente = (annee_iso, numero)
    return semaines


def main():
    print("=== Carnet2Maths - génération des numéros de semaine ===")
    print()

    debut = demander_date("Date de début (JJ/MM/AAAA) : ")
    while True:
        fin = demander_date("Date de fin   (JJ/MM/AAAA) : ")
        if fin >= debut:
            break
        print("  La date de fin doit être postérieure ou égale à la date de début.")

    semaines = grouper_par_semaine(generer_dates(debut, fin))
    if not semaines:
        print("\nAucun jour ouvré dans cet intervalle : presse-papier inchangé.")
        return

    # Tabulation entre les 2 colonnes, saut de ligne entre les semaines : Excel
    # colle le n° de semaine et sa date côte à côte, une semaine par ligne.
    texte = "\r\n".join(
        "{}\t{}".format(numero, jour.strftime(FORMAT_DATE)) for numero, jour in semaines
    )

    try:
        copier(texte)
    except Exception as erreur:
        print("\nCopie impossible ({}). Semaines générées :".format(erreur))
        print(texte)
        return

    print(
        "\n{} semaine(s) copiée(s) dans le presse-papier (S{} -> S{}).".format(
            len(semaines), semaines[0][0], semaines[-1][0]
        )
    )
    print("Ctrl+V dans Excel pour les coller sur 2 colonnes : n° de semaine, date.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nArrêt.")
    finally:
        pause()
