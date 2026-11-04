# Teken & Raad 🖍️

Multiplayer tekenen-en-raden in het Nederlands, met je eigen woorden.

- Maak een spel en deel de code of link.
- In de lobby voegt iedereen eigen woorden toe aan de woordenpot
  (optioneel aangevuld met ~250 ingebouwde Nederlandse woorden).
- Om de beurt kies je 1 van 3 woorden en teken je het. Je krijgt bij voorkeur
  woorden die iemand anders heeft bedacht.
- De rest raadt via de chat: hoe sneller, hoe meer punten (100–300).
  De tekenaar krijgt 50 punten per goede rader.
- Na verloop van tijd worden letters als hint onthuld.
- Wie het geraden heeft, kan alleen nog chatten met de tekenaar en andere goede raders.
- Tekengereedschap: 20 kleuren, 4 diktes, gum, emmer, ongedaan maken (Ctrl+Z), wissen.

## Techniek

Pure HTML/CSS/JS op GitHub Pages. Multiplayer gaat peer-to-peer via
[PeerJS](https://peerjs.com) (WebRTC): de browser van de host draait het spel,
dus de host moet het tabblad open houden.

```bash
npx http-server . -p 5174
```
