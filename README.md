# Teken & Raad 🖍️

Multiplayer tekenen-en-raden in het Nederlands, met je eigen woorden.
Speel het op **https://kevinboogaard.github.io/tekenen/**

## Spel
- Kies een avatar (emoji + kleur), maak een spel en deel de code of link.
- In de lobby voegt iedereen tot 500 eigen woorden toe aan de woordenpot.
  Alleen die woorden worden getekend. Is de pot leeg, dan gebruikt het spel
  ~250 ingebouwde Nederlandse woorden.
- Om de beurt kies je een woord en teken je het. Je krijgt bij voorkeur
  woorden die iemand anders heeft bedacht.
- De rest raadt via de chat: hoe sneller, hoe meer punten (100–300).
  De tekenaar krijgt 50 punten per goede rader. "Bijna goed!" bij één letter verschil.
- Letters worden als hint onthuld naarmate de tijd verstrijkt.
- Wie het geraden heeft, chat alleen nog met de tekenaar en andere goede raders.
- Geef een tekening 👍 of 👎 en laat live emoji's over de tekening zweven.
- Aan het eind: podium, grappige prijzen (zoals Snelste rader en Onbegrepen kunstenaar)
  en een galerij waarin je elke tekening streek voor streek terugkijkt of downloadt.

## Instellingen (host)
Rondes (1–10) · tekentijd (30–180 s) · woordopties per beurt (1–10) · aantal hints (0–5) ·
woordmodus normaal/verborgen · max. spelers (2–16).

## Tekengereedschap
20 kleuren + eigen kleur · 4 diktes · pen · gum · emmer · lijn · rechthoek · ellips ·
pipet · ongedaan maken · opnieuw · alles wissen.
Sneltoetsen: B pen, E gum, F emmer, L lijn, R rechthoek, O ellips, I pipet,
1–4 dikte, Ctrl+Z / Ctrl+Y.

## Spelers beheren
- Stem om een speler te verwijderen (meerderheid nodig); de host kan direct verwijderen.
- De host kan een beurt overslaan.
- Verbinding kwijt? Het spel verbindt vanzelf opnieuw en je punten blijven bewaard.
- Ververst de host de pagina, dan blijft de kamer bestaan en gaat iedereen terug naar de lobby.
- Meedoen kan altijd, ook op het eindscherm: je speelt dan mee vanaf het volgende spel.

## Techniek
Pure HTML/CSS/JS op GitHub Pages. Multiplayer gaat peer-to-peer via
[PeerJS](https://peerjs.com) (WebRTC): de browser van de host draait het spel,
dus de host moet het tabblad open houden.

```bash
npx http-server . -p 5174
```
