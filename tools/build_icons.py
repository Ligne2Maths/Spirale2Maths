#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regenere toute la charte graphique dans `icons/`, servi a la racine web :
kit d'icones, favicon, ecrans de demarrage iOS et carte de partage.

`icons/icon-master.svg` est la source de verite du logo : le kit en est
rasterise par `render_logo.py`. Si le dossier `icone/` est present (le kit tel
qu'il a ete livre), ses PNG sont copies tels quels et priment sur le rendu.
`icons/` contient en plus les ecrans de demarrage iOS, que le kit ne fournit
pas (iOS exige un PNG par definition d'ecran, avec une media query exacte).

Usage :  python tools/build_icons.py
"""

import os
import shutil

from PIL import Image, ImageDraw, ImageFilter, ImageFont

import render_logo

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(RACINE, "icone")
CIBLE = os.path.join(RACINE, "icons")
SPLASH = os.path.join(CIBLE, "splash")

# Fond des ecrans de demarrage : le `background_color` du manifest.
FOND = (0x2A, 0x24, 0x78)

# Ce qui part sur le web. Le README, le head-snippet et le manifest du kit
# restent dans `icone/` : ce sont des notes d'integration, pas des assets.
A_COPIER = [
    "favicon.ico",
    "favicon.svg",
    "icon-48.png",
    "icon-96.png",
    "icon-144.png",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
    "icon-master.svg",
    "logo-header.svg",
    "splash-1024.png",
]

# Definitions logiques des appareils iOS, en portrait : (largeur, hauteur, dpr).
# La taille du PNG vaut largeur x dpr par hauteur x dpr, et la media query
# associee reprend telles quelles ces trois valeurs.
APPAREILS_IOS = [
    (320, 568, 2),    # iPhone SE (1re gen)
    (375, 667, 2),    # iPhone 8, SE 2/3
    (414, 736, 3),    # iPhone 8 Plus
    (375, 812, 3),    # iPhone X, XS, 11 Pro
    (414, 896, 2),    # iPhone XR, 11
    (414, 896, 3),    # iPhone XS Max, 11 Pro Max
    (390, 844, 3),    # iPhone 12, 13, 14
    (393, 852, 3),    # iPhone 14 Pro, 15, 16
    (402, 874, 3),    # iPhone 16 Pro
    (428, 926, 3),    # iPhone 12/13/14 Plus et Pro Max
    (430, 932, 3),    # iPhone 14 Pro Max, 15 Pro Max, 16 Plus
    (440, 956, 3),    # iPhone 16 Pro Max
    (744, 1133, 2),   # iPad mini 6
    (768, 1024, 2),   # iPad 9.7
    (810, 1080, 2),   # iPad 10.2
    (820, 1180, 2),   # iPad Air 10.9
    (834, 1112, 2),   # iPad Pro 10.5
    (834, 1194, 2),   # iPad Pro 11
    (1024, 1366, 2),  # iPad Pro 12.9
]


def arrondir(icone, rayon_ratio=115.0 / 512.0):
    """Applique au PNG carre le meme arrondi que `logo-header.svg`.

    Les PNG du kit sont volontairement des carres pleins (Android pose son
    propre masque). Un ecran de demarrage iOS, lui, n'est qu'une image : si on
    n'arrondit pas, l'icone s'affiche en carre net au milieu du fond."""
    icone = icone.convert("RGBA")
    cote = icone.size[0]
    masque = Image.new("L", (cote * 4, cote * 4), 0)
    ImageDraw.Draw(masque).rounded_rectangle(
        (0, 0, cote * 4 - 1, cote * 4 - 1),
        radius=int(round(cote * 4 * rayon_ratio)),
        fill=255,
    )
    icone.putalpha(masque.resize((cote, cote), Image.LANCZOS))
    return icone


def generer_splashs(icone):
    if os.path.isdir(SPLASH):
        shutil.rmtree(SPLASH)
    os.makedirs(SPLASH)

    for largeur, hauteur, dpr in APPAREILS_IOS:
        px_l, px_h = largeur * dpr, hauteur * dpr
        toile = Image.new("RGB", (px_l, px_h), FOND)

        # 30 % du plus petit cote : l'icone reste a l'aise sur un iPhone SE
        # comme sur un iPad 12,9 pouces.
        cote = int(min(px_l, px_h) * 0.30)
        vignette = icone.resize((cote, cote), Image.LANCZOS)
        toile.paste(vignette, ((px_l - cote) // 2, (px_h - cote) // 2), vignette)

        # Palette de 256 couleurs : le fond est uni et l'icone ne couvre qu'un
        # tiers de la hauteur, donc la perte est invisible et le PNG pese
        # environ 40 % de moins — ces images ne servent qu'une seconde.
        toile = toile.quantize(colors=256, method=Image.MEDIANCUT)

        nom = "splash-{}x{}.png".format(px_l, px_h)
        toile.save(os.path.join(SPLASH, nom), optimize=True)
        print("  splash/{}".format(nom))



# ---------- Carte de partage (og:image) ----------

APERCU = os.path.join(RACINE, "img", "preview.png")
APERCU_TAILLE = (1200, 630)  # doit rester en phase avec les meta og:image:*

# Polices Windows, de la plus a la moins souhaitable. Si aucune n'est
# disponible, PIL retombe sur sa police bitmap et la carte reste lisible.
POLICES_GRASSES = ["seguibl.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
POLICES_NORMALES = ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]


def police(candidats, taille):
    for nom in candidats:
        for dossier in (r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu", ""):
            try:
                return ImageFont.truetype(os.path.join(dossier, nom), taille)
            except (IOError, OSError):
                continue
    return ImageFont.load_default()


def degrade_diagonal(taille, depart, arrivee):
    """Le meme degrade que la tuile de l'icone, etire sur la carte.

    Calcule sur une vignette puis agrandi : un calcul pixel par pixel sur
    1200 x 630 prendrait plusieurs secondes en Python pur, alors que le
    degrade, lui, n'a aucun detail fin a preserver."""
    l, h = 80, 42
    petit = Image.new("RGB", (l, h))
    pixels = petit.load()
    for y in range(h):
        for x in range(l):
            t = (x / float(l - 1) + y / float(h - 1)) / 2.0
            pixels[x, y] = tuple(
                int(round(depart[i] + (arrivee[i] - depart[i]) * t)) for i in range(3)
            )
    return petit.resize(taille, Image.BICUBIC)


def generer_apercu(icone):
    largeur, hauteur = APERCU_TAILLE
    carte = degrade_diagonal(APERCU_TAILLE, (0x41, 0x3A, 0xC0), (0x23, 0x1E, 0x66))

    # Halo clair en bas a droite, repris de l'ancienne carte : il empeche le
    # fond de paraitre plat sur les grandes vignettes de partage.
    halo = Image.new("L", APERCU_TAILLE, 0)
    ImageDraw.Draw(halo).ellipse(
        (largeur - 240, hauteur - 210, largeur + 320, hauteur + 350), fill=48
    )
    carte.paste(
        Image.new("RGB", APERCU_TAILLE, (0x6B, 0x63, 0xE0)),
        (0, 0),
        halo.filter(ImageFilter.GaussianBlur(60)),
    )

    vignette = icone.resize((132, 132), Image.LANCZOS)
    carte.paste(vignette, (96, 88), vignette)

    dessin = ImageDraw.Draw(carte)
    dessin.text((96, 276), u"Carnet2Maths", font=police(POLICES_GRASSES, 108), fill=(255, 255, 255))

    sous_titre = police(POLICES_NORMALES, 44)
    dessin.text((100, 410), u"Révisions vidéo de maths", font=sous_titre, fill=(0xC4, 0xC0, 0xE8))
    dessin.text((100, 468), u"par Chapitre ou par Date", font=sous_titre, fill=(0xC4, 0xC0, 0xE8))

    dessin.rounded_rectangle((100, 552, 140, 560), radius=4, fill=(255, 255, 255))
    dessin.text(
        (158, 534), u"carnet2maths.fr", font=police(POLICES_GRASSES, 34), fill=(255, 255, 255)
    )

    carte.save(APERCU, optimize=True)
    print("  {}".format(os.path.relpath(APERCU, RACINE)))


def balises_startup():
    """Rend les <link rel=apple-touch-startup-image> a coller dans le <head>."""
    lignes = []
    for largeur, hauteur, dpr in APPAREILS_IOS:
        lignes.append(
            '<link rel="apple-touch-startup-image" '
            'href="/icons/splash/splash-{}x{}.png" '
            'media="(device-width: {}px) and (device-height: {}px) '
            'and (-webkit-device-pixel-ratio: {}) '
            'and (orientation: portrait)" />'.format(
                largeur * dpr, hauteur * dpr, largeur, hauteur, dpr
            )
        )
    return "\n".join(lignes)


def main():
    if not os.path.isdir(CIBLE):
        os.makedirs(CIBLE)

    if os.path.isdir(SOURCE):
        print("Copie {} -> {}".format(SOURCE, CIBLE))
        for nom in A_COPIER:
            shutil.copy2(os.path.join(SOURCE, nom), os.path.join(CIBLE, nom))
            print("  {}".format(nom))
    else:
        print("Rendu du kit depuis icons/icon-master.svg")
        render_logo.generer_kit()

    # Le plus grand ecran de demarrage reclame une icone de 614 px : on part de
    # la tuile 1024 du kit, l'icone 512 devrait etre agrandie.
    icone = arrondir(Image.open(os.path.join(CIBLE, "splash-1024.png")))

    print("Ecrans de demarrage iOS")
    generer_splashs(icone)

    print("Carte de partage")
    generer_apercu(icone)

    chemin = os.path.join(RACINE, "tools", "head-startup-images.html")
    with open(chemin, "w", encoding="utf-8") as f:
        f.write(balises_startup() + "\n")
    print("Balises <head> regenerees : {}".format(os.path.relpath(chemin, RACINE)))


if __name__ == "__main__":
    main()
