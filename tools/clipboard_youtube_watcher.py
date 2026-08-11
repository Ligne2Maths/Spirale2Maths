"""
clipboard_youtube_watcher.py

Surveille le presse-papier en continu. Dès qu'un lien YouTube (contenant
"youtube.com") y est copié, en extrait l'identifiant de la vidéo — ce qui
suit "/embed/" ou "watch?v=", jusqu'à la fin du texte copié ou jusqu'au
premier "?" / "&" rencontré — puis remplace le contenu du presse-papier
par cet identifiant seul (pratique pour le coller directement dans les
colonnes "Niveau N YT" des tableurs de contenu/).

Dépendance :
    pip install pyperclip

Utilisation :
    python tools/clipboard_youtube_watcher.py
    (Ctrl+C pour arrêter)
"""

import re
import sys
import time

try:
    import pyperclip
except ImportError:
    print("Le module 'pyperclip' est requis. Installez-le avec :")
    print("    pip install pyperclip")
    sys.exit(1)

# Capture ce qui suit "/embed/" ou "watch?v=", jusqu'au premier "?" ou "&"
# (ou jusqu'à la fin de la chaîne s'il n'y en a pas).
ID_PATTERN = re.compile(r"(?:/embed/|watch\?v=)([^?&]+)")

INTERVALLE_SEC = 0.5


def extraire_id_youtube(texte):
    """Renvoie l'ID vidéo si `texte` est un lien YouTube exploitable, sinon None."""
    if not texte or "youtube.com" not in texte:
        return None
    match = ID_PATTERN.search(texte)
    return match.group(1) if match else None


def surveiller():
    print("Surveillance du presse-papier (Ctrl+C pour arrêter)...")

    try:
        dernier_contenu = pyperclip.paste()
    except Exception:
        dernier_contenu = None

    while True:
        time.sleep(INTERVALLE_SEC)

        try:
            contenu = pyperclip.paste()
        except Exception:
            continue

        if contenu == dernier_contenu:
            continue
        dernier_contenu = contenu

        video_id = extraire_id_youtube(contenu)
        if video_id:
            pyperclip.copy(video_id)
            dernier_contenu = video_id  # évite de retraiter notre propre copie
            print(f"Lien YouTube détecté -> ID copié dans le presse-papier : {video_id}")


if __name__ == "__main__":
    try:
        surveiller()
    except KeyboardInterrupt:
        print("\nArrêt.")
