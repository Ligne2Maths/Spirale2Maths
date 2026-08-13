"""
clipboard_youtube_watcher.py

Surveille le presse-papier en continu. Dès qu'un lien YouTube (contenant
"youtube.com") y est copié, en extrait l'identifiant de la vidéo — ce qui
suit "/embed/" ou "watch?v=", jusqu'à la fin du texte copié ou jusqu'au
premier "?" / "&" rencontré — puis remplace le contenu du presse-papier
par cet identifiant seul (pratique pour le coller directement dans les
colonnes "Niveau N YT" des tableurs de contenu/).

Certains ID YouTube commencent par "-" (ex : "-v6seS__Hm0") ; Excel
interpréterait un tel collage comme une formule (et ajouterait un "="
devant). Pour l'éviter, sous Windows l'ID est placé dans le presse-papier
sous deux formats simultanés :
  - texte brut (CF_UNICODETEXT) : l'ID nu, pour toutes les applications ;
  - "HTML Format" avec mso-number-format:'\\@' : Excel l'utilise en priorité
    au collage et force la cellule en format Texte.

Dépendance :
    pip install pyperclip

Utilisation :
    python tools/clipboard_youtube_watcher.py
    (Ctrl+C pour arrêter)
"""

import html
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


# --------------------------------------------------------------------------
# Presse-papier Windows : texte brut + "HTML Format" (cellule en format Texte)
# --------------------------------------------------------------------------

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _user32.OpenClipboard.argtypes = [wintypes.HWND]
    _user32.OpenClipboard.restype = wintypes.BOOL
    _user32.EmptyClipboard.restype = wintypes.BOOL
    _user32.CloseClipboard.restype = wintypes.BOOL
    _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    _user32.SetClipboardData.restype = wintypes.HANDLE
    _user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    _user32.RegisterClipboardFormatW.restype = wintypes.UINT

    _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalLock.restype = wintypes.LPVOID
    _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalUnlock.restype = wintypes.BOOL
    _kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalFree.restype = wintypes.HGLOBAL

    _GMEM_MOVEABLE = 0x0002
    _CF_UNICODETEXT = 13

    _EN_TETE_CF_HTML = (
        "Version:0.9\r\n"
        "StartHTML:{:010d}\r\n"
        "EndHTML:{:010d}\r\n"
        "StartFragment:{:010d}\r\n"
        "EndFragment:{:010d}\r\n"
    )
    _PREFIXE_CF_HTML = "<html><body>\r\n<!--StartFragment-->"
    _SUFFIXE_CF_HTML = "<!--EndFragment-->\r\n</body></html>"

    def _construire_cf_html(fragment):
        """Enrobe `fragment` dans l'en-tête CF_HTML (décalages en octets UTF-8)."""
        taille_en_tete = len(_EN_TETE_CF_HTML.format(0, 0, 0, 0).encode("utf-8"))
        debut_html = taille_en_tete
        debut_fragment = debut_html + len(_PREFIXE_CF_HTML.encode("utf-8"))
        fin_fragment = debut_fragment + len(fragment.encode("utf-8"))
        fin_html = fin_fragment + len(_SUFFIXE_CF_HTML.encode("utf-8"))
        return (
            _EN_TETE_CF_HTML.format(debut_html, fin_html, debut_fragment, fin_fragment)
            + _PREFIXE_CF_HTML
            + fragment
            + _SUFFIXE_CF_HTML
        )

    def _deposer_format(format_id, donnees):
        """Alloue un bloc global et le confie au presse-papier (déjà ouvert)."""
        handle = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(donnees))
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        pointeur = _kernel32.GlobalLock(handle)
        if not pointeur:
            _kernel32.GlobalFree(handle)
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            ctypes.memmove(pointeur, donnees, len(donnees))
        finally:
            _kernel32.GlobalUnlock(handle)
        if not _user32.SetClipboardData(format_id, handle):
            _kernel32.GlobalFree(handle)
            raise ctypes.WinError(ctypes.get_last_error())
        # En cas de succès, le presse-papier devient propriétaire du bloc.

    def copier_pour_tableur(texte):
        """Copie `texte` en texte brut + en cellule HTML forcée au format Texte."""
        fragment = (
            "<table><tr><td style=\"mso-number-format:'\\@'\">"
            + html.escape(texte)
            + "</td></tr></table>"
        )
        donnees_html = _construire_cf_html(fragment).encode("utf-8") + b"\0"
        donnees_texte = (texte + "\0").encode("utf-16-le")

        for tentative in range(10):  # le presse-papier peut être occupé
            if _user32.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            raise ctypes.WinError(ctypes.get_last_error())

        try:
            _user32.EmptyClipboard()
            _deposer_format(_CF_UNICODETEXT, donnees_texte)
            _deposer_format(_user32.RegisterClipboardFormatW("HTML Format"), donnees_html)
        finally:
            _user32.CloseClipboard()

else:

    def copier_pour_tableur(texte):
        pyperclip.copy(texte)


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
            try:
                copier_pour_tableur(video_id)
            except Exception as erreur:
                print(f"Copie enrichie impossible ({erreur}) : repli sur le texte brut.")
                pyperclip.copy(video_id)
            dernier_contenu = video_id  # évite de retraiter notre propre copie
            print(f"Lien YouTube détecté -> ID copié dans le presse-papier : {video_id}")


if __name__ == "__main__":
    try:
        surveiller()
    except KeyboardInterrupt:
        print("\nArrêt.")
