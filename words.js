// Ingebouwde Nederlandse woorden (goed te tekenen).
window.BUILTIN_WORDS = `
appel, banaan, aardbei, peer, druif, ananas, wortel, tomaat, kaas, brood, pannenkoek, poffertjes, stroopwafel,
ijsje, taart, pizza, friet, hamburger, kroket, ei, soep, koffie, thee, melk, limonade, snoep, drop, hagelslag,
hond, kat, koe, paard, varken, schaap, kip, eend, zwaan, uil, giraffe, olifant, leeuw, tijger, zebra, aap,
slang, krokodil, schildpad, kikker, vis, haai, walvis, dolfijn, octopus, krab, slak, vlinder, bij, spin, mier,
konijn, muis, egel, vos, beer, pinguin, flamingo, papegaai, kameel, eenhoorn, draak, dinosaurus,
fiets, auto, bus, trein, tram, vliegtuig, helikopter, boot, zeilboot, raket, tractor, brandweerauto, scooter,
molen, huis, kasteel, kerk, brug, vuurtoren, tent, iglo, piramide, tunnel, flat, schuur,
zon, maan, ster, wolk, regen, bliksem, regenboog, sneeuwpop, berg, vulkaan, eiland, strand, bos, boom, bloem,
tulp, cactus, paddenstoel, blad, gras, rivier, waterval, golf,
klomp, kaasschaaf, fluit, gitaar, piano, trommel, televisie, telefoon, computer, laptop, koptelefoon, camera,
lamp, kaars, klok, wekker, sleutel, slot, schaar, potlood, boek, krant, brief, envelop, cadeau, ballon,
paraplu, bril, hoed, pet, sjaal, handschoen, sok, schoen, laars, broek, jurk, das, kroon, ring, horloge,
stoel, tafel, bank, bed, kussen, deken, bad, douche, wc, tandenborstel, kam, spiegel, deur, raam, trap,
ladder, hamer, zaag, schroevendraaier, emmer, bezem, stofzuiger, wasmachine, koelkast, oven, pan, vork, mes,
lepel, bord, kopje, fles, glas, rugzak, koffer, kaart, kompas, anker, schatkist, piraat, robot, spook, heks,
tovenaar, ridder, prinses, koning, clown, astronaut, politie, dokter, kok, boer, voetbal, tennis, schaatsen,
zwemmen, skien, voetbaldoel, trofee, medaille, dobbelsteen, puzzel, vlieger, schommel, glijbaan, trampoline,
verjaardag, kerstboom, sinterklaas, paashaas, vuurwerk, sneeuwvlok, hart, oog, neus, mond, hand, voet,
tand, oor, haar, baard, snor, skelet, spierballen, slapen, lachen, huilen, niezen, dansen, zingen, rennen
`.split(',').map((w) => w.trim()).filter(Boolean);
