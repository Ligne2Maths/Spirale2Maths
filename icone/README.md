# Carnet2maths — jeu d'icônes

Piste **C′a · Spirale sans texte**. Page 264 × 250, case 42, coche 6,5, barre 18, barres validées `#514AB2`. Aucun texte ni symbole sur la page.

## Ce qu'il y a dans le dossier

| Fichier | À quoi ça sert |
|---|---|
| `icon-master.svg` | Le maître, 512 × 512, carré plein. C'est de lui que tout est dérivé — repars toujours de celui-là. |
| `icon-512.png` · `icon-192.png` | Les deux icônes du manifest, déclarées `any maskable`. |
| `icon-180.png` | `apple-touch-icon`, au cas où quelqu'un ajoute le site depuis un iPhone. |
| `icon-144.png` · `icon-96.png` · `icon-48.png` | Tailles d'appoint (vieux Android, raccourcis). |
| `logo-header.svg` | Pour l'en-tête du site. Coins arrondis gravés, puisque le web n'applique aucun masque. |
| `favicon.svg` · `favicon.ico` | L'onglet. Le `.ico` contient 16, 32 et 48. |
| `splash-1024.png` | Écran de démarrage, icône centrée sur `#2A2478`. |
| `manifest.webmanifest` | Prêt à servir. Adapte juste les chemins. |
| `head-snippet.html` | Les cinq lignes à coller dans le `<head>`. |

## Installation

1. Copie les PNG, les SVG et le `.ico` dans `/icons/`.
2. Sers `manifest.webmanifest` à la racine (type MIME `application/manifest+json`).
3. Colle le contenu de `head-snippet.html` dans ton `<head>`.
4. Vérifie dans Chrome DevTools → Application → Manifest : Chrome y affiche un aperçu de l'icône masquée.

## Deux choses à ne pas casser

**La page ne doit pas grandir.** La zone sûre d'une icône `maskable` Android est le cercle central à 80 %, soit un rayon de 204 sur le canevas 512. Le point le plus éloigné du dessin — le coin bas-gauche de la page — est à 197. Il ne reste que 7 points. Si tu réexportes en agrandissant le carnet, la spirale et les coins se feront rogner sur les masques ronds.

**Les PNG sont des carrés pleins, sans arrondi.** C'est voulu : Android applique son propre masque (cercle, squircle, goutte, carré arrondi selon le constructeur). Si tu graves l'arrondi dans le PNG, tu obtiendras un arrondi dans un arrondi. Le seul fichier qui porte ses coins, c'est `logo-header.svg`, pour le web.

## Couleurs

| Rôle | Valeur |
|---|---|
| Fond, dégradé | `#413AC0` → `#231E66` |
| Page | `#FFFFFF`, coin corné `#D6DBF7` |
| Cases validées | `#0FA97C`, coche blanche |
| Case en attente | contour `#8C88DC` |
| Barres validées | `#514AB2` |
| Barre en attente | `#C4C0E8` |
| Spirale | `#A9B0E6`, perforations `#8E96D8` |
| `theme_color` / `background_color` | `#2A2478` |
