# Vestel EVC04 & Webasto Unite voor Homey

Homey-app (SDK 3) die een **Vestel EVC04** of **Webasto Unite** lokaal via **Modbus TCP** uitleest en aanstuurt.
De Webasto Unite is gebouwd op de Vestel EVC04 en gebruikt dezelfde Modbus-registers (getest met de nieuwste
Vestel-firmware). Bij het toevoegen kies je het type; beide werken identiek, alleen naam en icoon verschillen.

Dit is een community-app en wordt niet gemaakt door Vestel of Webasto.

## Wat de app doet

**Uitlezen** (elke 5 s, instelbaar): laadstatus, auto aangesloten, vermogen, totale kWh-meter
(telt mee in Homey Energie), energie en duur van de sessie, stroom en spanning per fase.

**Aansturen**: laden aan/uit, maximale laadstroom (6–32 A, begrensd door het maximum van je installatie).

**Laadmodi**
| Modus | Gedrag |
|---|---|
| Snel | Laden met jouw maximale laadstroom |
| Minimaal + zon | Altijd minimaal 6 A, harder bij zonne-overschot |
| Alleen zon | Laden alleen op overschot, met start- en stopvertraging tegen wolken |
| Uit | Gepauzeerd (laadstroom 0 A) |

**Capaciteitsbeveiliging**: verlaagt de laadstroom zodra een fase je hoofdzekering dreigt te overschrijden,
en pauzeert als er minder dan 6 A over is.

Het veld **Begrensd door** op het apparaat laat zien waarom de laadpaal laadt zoals hij laadt.

## Vooraf

1. **Modbus TCP aanzetten** op de laadpaal (in de webinterface van de EVC04, onder load management).
   Geef de laadpaal een vast IP-adres in je router.
2. **Maar één Modbus-verbinding tegelijk.** De EVC04 accepteert één master. Schakel daarom het bestaande
   Modbus-apparaat of de Modbus-app die nu met de laadpaal praat uit, anders werkt geen van beide betrouwbaar.
3. Firmware ouder dan 2.99.3: een actieve OCPP-verbinding kan botsen met Modbus TCP.

## Installeren

```bash
npm install
npm install -g homey
homey login
homey app install
```

`homey app run` start de app in ontwikkelmodus met live logging.

Voeg daarna in Homey een apparaat toe: *Vestel EVC04*, vul het IP-adres in (poort 502, unit-ID 255).

## Netmeting koppelen (nodig voor zon en capaciteitsbeveiliging)

De app krijgt de gegevens van je P1-meter via een flow:

- **Als** P1-meter → *Het vermogen is veranderd*
- **Dan** Laadpaal → *Netmeting doorgeven*: vermogen = `Vermogen` van de P1-meter,
  L1/L2/L3 = `Stroom L1/L2/L3` van de P1-meter

Negatief vermogen of negatieve stroom betekent teruglevering. Komt er langer dan de time-out (standaard 60 s)
geen meting binnen, dan pauzeert *Alleen zon* en valt de capaciteitsbeveiliging terug op 6 A.

Heb je alleen zonneladen nodig, dan volstaat *Netvermogen doorgeven*.

## Flowkaarten

- Triggers: auto aangesloten, auto losgekoppeld (met sessie-energie en -duur), laadmodus veranderd,
  plus de standaardkaarten van Homey voor laadstatus.
- Voorwaarden: auto is aangesloten, laadmodus is …
- Acties: laadmodus instellen, max. laadstroom instellen, netvermogen/netmeting doorgeven.

## Ontwikkelen

```bash
npm test          # unit tests + test tegen een gesimuleerde laadpaal
npm run validate
```

- `lib/VestelClient.js`: Modbus-registers, verbinding en heartbeat
- `lib/ChargeController.js`: laadlogica (geen I/O, volledig getest)
- `lib/ChargerDriver.js`, `lib/ChargerDevice.js`: koppelen en apparaatlogica, gedeeld door beide types
- `drivers/evc04/`, `drivers/unite/`: per type alleen naam, icoon, instellingen en koppelscherm
  (instellingen en koppelscherm moeten gelijk blijven; een test bewaakt dat)
- `.homeycompose/drivers/templates/charger.json`: gedeelde capabilities en energie-instellingen
- `.homeycompose/flow/`: flowkaarten, voor beide types

De laadpaal valt terug op zijn failsafe-stroom als hij niets meer van Homey hoort; de app stuurt daarom
regelmatig een heartbeat (register 6000).
