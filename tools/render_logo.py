#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rasterise le logo vectoriel vers les PNG de la charte graphique.

`icons/icon-master.svg` est la source de verite : les icones PWA, le favicon,
les ecrans de demarrage et la carte de partage en descendent tous. Retoucher
le SVG puis relancer `python tools/build_icons.py` suffit a remettre toute la
charte d'aplomb.

Le rendu couvre le sous-ensemble de SVG qu'utilise le logo : groupes,
transformations (translate / rotate / scale / matrix), `rect` (avec rx),
`circle`, `path` (M L H V A Z), remplissage uni ou degrade lineaire, contour,
opacite de groupe et clip-path.

Le trace se fait a SUREPAISSEUR fois la taille demandee puis se reduit en
LANCZOS : PIL ne lisse pas ses polygones, c'est le surechantillonnage qui
fournit l'anticrenelage.

Usage :  python tools/render_logo.py         (regenere le kit dans icons/)
"""

import math
import os
import re
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops, ImageDraw

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = "{http://www.w3.org/2000/svg}"

# 6 echantillons par pixel sur l'icone de reference (512 px) : au-dela la
# difference ne se voit plus, alors que la memoire, elle, se voit tout de suite.
SUREPAISSEUR = 6

# Segments par quart de cercle. Le plus grand arc du logo mesure 18 px sur 512,
# soit une corde de 2 px a 3072 px de large : invisible apres reduction.
SEGMENTS = 16

NOMBRE = re.compile(r"[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?")
COMMANDE = re.compile(r"([MmLlHhVvAaZz])([^MmLlHhVvAaZz]*)")
FONCTION = re.compile(r"([a-zA-Z]+)\s*\(([^)]*)\)")

# Attributs de presentation qui se transmettent aux enfants.
HERITES = ("fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin")
DEFAUTS = {"fill": "#000000", "stroke": "none", "stroke-width": "1",
           "stroke-linecap": "butt", "stroke-linejoin": "miter"}

IDENTITE = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


# ---------- Petite algebre ----------

def nombres(txt):
    return [float(n) for n in NOMBRE.findall(txt or "")]


def couleur(txt):
    txt = (txt or "").strip()
    if not txt.startswith("#"):
        return (0, 0, 0)
    hexa = txt[1:]
    if len(hexa) == 3:
        hexa = "".join(c * 2 for c in hexa)
    return tuple(int(hexa[i:i + 2], 16) for i in (0, 2, 4))


def multiplier(m, n):
    """Compose deux matrices : le point traverse n, puis m."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + c * B, b * A + d * B,
            a * C + c * D, b * C + d * D,
            a * E + c * F + e, b * E + d * F + f)


def appliquer(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def transformation(txt):
    m = IDENTITE
    for nom, args in FONCTION.findall(txt or ""):
        v = nombres(args)
        if nom == "translate":
            t = (1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0)
        elif nom == "rotate":
            a = math.radians(v[0])
            t = (math.cos(a), math.sin(a), -math.sin(a), math.cos(a), 0.0, 0.0)
            if len(v) == 3:  # rotation autour d'un point
                t = multiplier(multiplier((1.0, 0.0, 0.0, 1.0, v[1], v[2]), t),
                               (1.0, 0.0, 0.0, 1.0, -v[1], -v[2]))
        elif nom == "scale":
            t = (v[0], 0.0, 0.0, v[1] if len(v) > 1 else v[0], 0.0, 0.0)
        elif nom == "matrix":
            t = tuple(v[:6])
        else:
            continue
        m = multiplier(m, t)
    return m


# ---------- Contours ----------

def points_arc(depart, rx, ry, phi_deg, grand, sens, arrivee):
    """Arc elliptique SVG (A) echantillonne : parametrage endpoint -> centre."""
    x0, y0 = depart
    x1, y1 = arrivee
    if rx == 0 or ry == 0 or (x0 == x1 and y0 == y1):
        return [arrivee]
    phi = math.radians(phi_deg)
    cs, sn = math.cos(phi), math.sin(phi)
    dx, dy = (x0 - x1) / 2.0, (y0 - y1) / 2.0
    xp, yp = cs * dx + sn * dy, -sn * dx + cs * dy
    rx, ry = abs(rx), abs(ry)
    exces = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
    if exces > 1:  # rayons trop courts : le SVG demande de les etirer
        rx *= math.sqrt(exces)
        ry *= math.sqrt(exces)
    num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
    den = rx * rx * yp * yp + ry * ry * xp * xp
    coef = math.sqrt(max(0.0, num / den))
    if bool(grand) == bool(sens):
        coef = -coef
    cxp, cyp = coef * rx * yp / ry, -coef * ry * xp / rx
    cx = cs * cxp - sn * cyp + (x0 + x1) / 2.0
    cy = sn * cxp + cs * cyp + (y0 + y1) / 2.0

    def angle(ux, uy, vx, vy):
        n = math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
        a = math.acos(max(-1.0, min(1.0, (ux * vx + uy * vy) / n)))
        return -a if ux * vy - uy * vx < 0 else a

    ux, uy = (xp - cxp) / rx, (yp - cyp) / ry
    vx, vy = (-xp - cxp) / rx, (-yp - cyp) / ry
    theta = angle(1.0, 0.0, ux, uy)
    delta = angle(ux, uy, vx, vy)
    if not sens and delta > 0:
        delta -= 2 * math.pi
    elif sens and delta < 0:
        delta += 2 * math.pi

    pas = max(2, int(math.ceil(SEGMENTS * abs(delta) / (math.pi / 2))))
    pts = []
    for i in range(1, pas + 1):
        t = theta + delta * i / float(pas)
        ct, st = math.cos(t), math.sin(t)
        pts.append((cs * rx * ct - sn * ry * st + cx,
                    sn * rx * ct + cs * ry * st + cy))
    return pts


def polylignes_chemin(d):
    """Aplatit un attribut `d` en sous-chemins [(points, ferme), ...]."""
    chemins, courant = [], []
    x = y = 0.0
    depart = (0.0, 0.0)
    for cmd, args in COMMANDE.findall(d or ""):
        absolu = cmd.isupper()
        c = cmd.upper()
        v = nombres(args)
        if c == "M":
            for i in range(0, len(v) - 1, 2):
                x, y = (v[i], v[i + 1]) if absolu else (x + v[i], y + v[i + 1])
                if i == 0:
                    if courant:
                        chemins.append((courant, False))
                    courant, depart = [(x, y)], (x, y)
                else:  # un M suivi de plusieurs points vaut autant de L
                    courant.append((x, y))
        elif c == "L":
            for i in range(0, len(v) - 1, 2):
                x, y = (v[i], v[i + 1]) if absolu else (x + v[i], y + v[i + 1])
                courant.append((x, y))
        elif c == "H":
            for n in v:
                x = n if absolu else x + n
                courant.append((x, y))
        elif c == "V":
            for n in v:
                y = n if absolu else y + n
                courant.append((x, y))
        elif c == "A":
            for i in range(0, len(v) - 6, 7):
                rx, ry, phi, grand, sens, ax, ay = v[i:i + 7]
                ax, ay = (ax, ay) if absolu else (x + ax, y + ay)
                courant.extend(points_arc((x, y), rx, ry, phi, grand, sens, (ax, ay)))
                x, y = ax, ay
        elif c == "Z":
            if courant:
                chemins.append((courant, True))
            courant = []
            x, y = depart
    if courant:
        chemins.append((courant, False))
    return chemins


def polyligne_rect(x, y, w, h, rx, ry):
    rx, ry = min(rx, w / 2.0), min(ry, h / 2.0)
    if rx <= 0 or ry <= 0:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    pts = []
    for cx, cy, angle in ((x + w - rx, y + ry, -90), (x + w - rx, y + h - ry, 0),
                          (x + rx, y + h - ry, 90), (x + rx, y + ry, 180)):
        for i in range(SEGMENTS + 1):
            a = math.radians(angle + 90.0 * i / SEGMENTS)
            pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    return pts


def polyligne_cercle(cx, cy, r):
    n = SEGMENTS * 4
    return [(cx + r * math.cos(2 * math.pi * i / n),
             cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


# ---------- Rendu ----------

class Rendu(object):

    def __init__(self, racine, px):
        self.racine = racine
        self.px = px
        self.refs = {}
        for el in racine.iter():
            if el.get("id"):
                self.refs[el.get("id")] = el
        boite = nombres(racine.get("viewBox") or "0 0 512 512")
        self.echelle = px / float(boite[2])

    # -- geometrie

    def contours(self, el, m):
        """Sous-chemins de la forme, deja projetes en pixels."""
        tag = el.tag.replace(NS, "")
        if tag == "rect":
            x, y = float(el.get("x", 0)), float(el.get("y", 0))
            w, h = float(el.get("width", 0)), float(el.get("height", 0))
            rx, ry = el.get("rx"), el.get("ry")
            rx = float(rx if rx is not None else (ry or 0))
            ry = float(ry if ry is not None else rx)
            sous = [(polyligne_rect(x, y, w, h, rx, ry), True)]
        elif tag == "circle":
            sous = [(polyligne_cercle(float(el.get("cx", 0)), float(el.get("cy", 0)),
                                      float(el.get("r", 0))), True)]
        elif tag == "path":
            sous = polylignes_chemin(el.get("d"))
        else:
            return []
        return [([appliquer(m, ux, uy) for ux, uy in pts], ferme) for pts, ferme in sous]

    # -- peinture

    def masque_plein(self, sous):
        masque = Image.new("L", (self.px, self.px), 0)
        dessin = ImageDraw.Draw(masque)
        for pts, _ in sous:
            if len(pts) > 2:
                dessin.polygon(pts, fill=255)
        return masque

    def masque_trait(self, sous, largeur, cap):
        masque = Image.new("L", (self.px, self.px), 0)
        dessin = ImageDraw.Draw(masque)
        rayon = largeur / 2.0

        def rond(p):
            dessin.ellipse((p[0] - rayon, p[1] - rayon, p[0] + rayon, p[1] + rayon), fill=255)

        for pts, ferme in sous:
            trace = pts + [pts[0]] if ferme else pts
            if len(trace) < 2:
                continue
            dessin.line(trace, fill=255, width=largeur, joint="curve")
            # `joint` ne traite que les sommets interieurs : on ferme soi-meme la
            # jonction depart/arrivee, et les extremites si le bout est rond.
            if ferme or cap == "round":
                rond(trace[0])
                rond(trace[-1])
        return masque

    def degrade(self, ident, boite):
        el = self.refs[ident]
        arrets = sorted((float(s.get("offset", 0)), couleur(s.get("stop-color", "#000")))
                        for s in el)
        x0, y0, x1, y1 = boite
        lx, ly = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
        # gradientUnits vaut par defaut objectBoundingBox : les coordonnees du
        # degrade sont des fractions de la boite englobante de la forme.
        ax = x0 + float(el.get("x1", 0)) * lx
        ay = y0 + float(el.get("y1", 0)) * ly
        bx = x0 + float(el.get("x2", 1)) * lx
        by = y0 + float(el.get("y2", 0)) * ly
        dx, dy = bx - ax, by - ay
        norme = dx * dx + dy * dy or 1.0

        def teinte(t):
            t = min(1.0, max(0.0, t))
            precedent = arrets[0]
            suivant = arrets[-1]
            for arret in arrets:
                if arret[0] >= t:
                    suivant = arret
                    break
                precedent = arret
            ecart = suivant[0] - precedent[0]
            u = 0.0 if ecart <= 0 else (t - precedent[0]) / ecart
            return tuple(int(round(precedent[1][i] + (suivant[1][i] - precedent[1][i]) * u))
                         for i in range(3))

        # Le degrade n'a aucun detail fin : on le calcule petit puis on l'etire,
        # au lieu d'une double boucle Python sur plusieurs millions de pixels.
        cote = min(self.px, 512)
        image = Image.new("RGB", (cote, cote))
        pixels = image.load()
        facteur = self.px / float(cote)
        for j in range(cote):
            base = ((j * facteur - ay) * dy) / norme
            for i in range(cote):
                pixels[i, j] = teinte(base + ((i * facteur - ax) * dx) / norme)
        return image if cote == self.px else image.resize((self.px, self.px), Image.BICUBIC)

    def peindre(self, toile, masque, valeur, sous):
        if valeur.startswith("url("):
            xs = [p[0] for pts, _ in sous for p in pts]
            ys = [p[1] for pts, _ in sous for p in pts]
            source = self.degrade(valeur[valeur.index("#") + 1:].rstrip(") "),
                                  (min(xs), min(ys), max(xs), max(ys)))
        else:
            source = Image.new("RGB", (self.px, self.px), couleur(valeur))
        toile.paste(source, (0, 0), masque)

    # -- parcours

    def element(self, toile, el, m, style):
        tag = el.tag.replace(NS, "")
        if tag in ("defs", "title", "desc", "style", "clipPath", "linearGradient"):
            return
        style = dict(style)
        for cle in HERITES:
            if el.get(cle) is not None:
                style[cle] = el.get(cle)
        m = multiplier(m, transformation(el.get("transform")))

        opacite = float(el.get("opacity", 1))
        clip = el.get("clip-path")
        # Opacite et decoupe portent sur le groupe entier : il lui faut une
        # couche a part, sinon les formes transparaissent l'une dans l'autre.
        couche = toile if (opacite >= 1 and not clip) else Image.new(
            "RGBA", (self.px, self.px), (0, 0, 0, 0))

        if tag in ("g", "svg"):
            for enfant in el:
                self.element(couche, enfant, m, style)
        else:
            sous = self.contours(el, m)
            if sous:
                if style["fill"] != "none":
                    self.peindre(couche, self.masque_plein(sous), style["fill"], sous)
                if style["stroke"] != "none":
                    largeur = max(1, int(round(float(style["stroke-width"]) * self.echelle)))
                    self.peindre(couche,
                                 self.masque_trait(sous, largeur, style["stroke-linecap"]),
                                 style["stroke"], sous)

        if couche is not toile:
            alpha = couche.split()[3]
            if clip:
                alpha = ImageChops.multiply(alpha, self.masque_clip(clip, m))
            if opacite < 1:
                alpha = alpha.point(lambda v: int(round(v * opacite)))
            couche.putalpha(alpha)
            toile.alpha_composite(couche)

    def masque_clip(self, valeur, m):
        el = self.refs[valeur[valeur.index("#") + 1:].rstrip(") ")]
        masque = Image.new("L", (self.px, self.px), 0)
        dessin = ImageDraw.Draw(masque)
        for enfant in el:
            forme = multiplier(m, transformation(enfant.get("transform")))
            for pts, _ in self.contours(enfant, forme):
                dessin.polygon(pts, fill=255)
        return masque

    def rendre(self):
        toile = Image.new("RGBA", (self.px, self.px), (0, 0, 0, 0))
        depart = (self.echelle, 0.0, 0.0, self.echelle, 0.0, 0.0)
        for el in self.racine:
            self.element(toile, el, depart, dict(DEFAUTS))
        return toile


def rendre(chemin_svg, cote, surepaisseur=SUREPAISSEUR):
    """Rend le SVG en RGBA de `cote` px, trace en grand puis reduit."""
    racine = ET.parse(chemin_svg).getroot()
    brut = Rendu(racine, cote * surepaisseur).rendre()
    return brut.resize((cote, cote), Image.LANCZOS)


# ---------- Le kit ----------

SVG_MAITRE = os.path.join(RACINE, "icons", "icon-master.svg")
CIBLE = os.path.join(RACINE, "icons")

# Les tailles que reclament le manifest, `apple-touch-icon` et le service
# worker. Ces PNG sont des carres pleins : Android pose son propre masque.
TAILLES_KIT = (48, 96, 144, 180, 192, 512)
TAILLES_ICO = (16, 32, 48)

# Toutes les declinaisons descendent d'un seul trace, assez large pour que
# meme la tuile 1024 garde quatre echantillons par pixel.
MAITRE = 4096


def generer_kit(svg=SVG_MAITRE, cible=CIBLE, journal=True):
    """Ecrit les PNG du kit et le favicon multi-tailles a partir du SVG."""
    brut = Rendu(ET.parse(svg).getroot(), MAITRE).rendre()

    def carre(cote):
        return brut.resize((cote, cote), Image.LANCZOS)

    def ecrire(image, nom):
        chemin = os.path.join(cible, nom)
        image.save(chemin, optimize=True)
        if journal:
            print("  {}".format(nom))

    for cote in TAILLES_KIT:
        ecrire(carre(cote).convert("RGB"), "icon-{}.png".format(cote))
    ecrire(carre(1024).convert("RGB"), "splash-1024.png")

    # Un rendu propre par definition plutot que la reduction en cascade que
    # ferait PIL a partir de la seule vignette 48.
    vignettes = [carre(cote).convert("RGBA") for cote in TAILLES_ICO]
    vignettes[-1].save(os.path.join(cible, "favicon.ico"),
                       sizes=[(c, c) for c in TAILLES_ICO],
                       append_images=vignettes[:-1])
    if journal:
        print("  favicon.ico ({})".format(", ".join(str(c) for c in TAILLES_ICO)))


if __name__ == "__main__":
    print("Rendu du kit depuis {}".format(os.path.relpath(SVG_MAITRE, RACINE)))
    generer_kit()
