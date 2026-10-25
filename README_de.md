![Logo](admin/sungrow-local.png)

# ioBroker.sungrow-local – Kurzbeschreibung auf Deutsch

Die vollständige Dokumentation steht in der englischen [README](README.md).

Der Adapter bindet einen **Sungrow-Hybridwechselrichter** (entwickelt mit einem SH20T) und den **Akku**
(SBH-Serie, z. B. SBH400) über das Kommunikationsmodul **WiNet-S2** per **Modbus TCP** ein – lokal, ohne
iSolarCloud. Er ersetzt eine generische `ioBroker.modbus`-Instanz und behält deren Datenpunkt-IDs bei.

- **Genau eine TCP-Verbindung** zum WiNet, alle Anfragen streng nacheinander, mit Mindestpause.
- **Abfragegruppen** mit eigenem Takt, Timeout und optionaler Pause nach jeder Anfrage (Vorgabe, an einer
  Referenzanlage gemessen: `live` 5 s, `energie` 60 s, `steuerung` 60 s, `akku` 120 s mit Timeout 15000 ms und
  5000 ms Pause). Kürzere Werte markiert die Admin-Seite rot (nur Warnung).
- **Ein Timeout betrifft nur seinen Block**; neu verbunden wird erst nach N Fehlern in Folge (Vorgabe 3) oder
  wenn das Gateway die Verbindung schließt.
- **Schreiben mit Vorrang** vor der nächsten Leseanfrage, danach sofortige Rücklesung; `ack=true` erst mit dem
  bestätigten Wert. Optionaler Nur-Lese-Modus.
- **Diagnose je Gruppe** unter `info.groups.<gruppe>.*` mit Herzschlag `lastRound` – alte Zeitstempel an
  Registern sind normal (geschrieben wird nur bei Änderung), ein hängender Bus zeigt sich an `lastRound`.
- **Neue Einstellungsseite (0.4.0, Admin ≥ 8.2):** Reiter *Übersicht* (Ampeln, Live-Kacheln, Einrichtungs-
  Assistent mit Verbindungstest und Modellerkennung), *Register* (Katalog nach Themen mit Suche, aktivieren per
  Klick oder Drag & Drop in eine Abfragegruppe, Busauslastung je Gruppe und gesamt mit Begründung jeder
  zusätzlichen Anfrage, eigene Register in jeder Adressschreibweise mit Testlesen), *Steuerung* (Schreiben je
  Register freigeben, Wertebereich, Protokoll der letzten Schreibbefehle), *Verbindung* (mit aufklappbarem
  „Erweitert“), *Werkzeuge* (Umrechnungshilfe, Diagnose) und *Experte* (die bisherigen Tabellen).
- **Busauslastung:** etwa 1,25 Anfragen/s schafft der WiNet-S2 dauerhaft (gemessen: live 5 s + energie 60 s +
  steuerung 60 s + akku 120 s stabil, live 3 s ließ Runden aus, akku 60 s erzeugte Timeouts); Pausen langsamer
  Geräte (SBH: 5 s) kommen hinzu. Grün < 80 %, gelb bis 100 %, rot darüber.
- **Umstieg von ioBroker.modbus:** gleiche IDs, Namen, Einheiten, Faktoren, Typen und Rollen – Textersatz
  `modbus.N.` → `sungrow-local.0.`. Die alte Modbus-Instanz vorher abschalten: das WiNet soll nur einen Client sehen.
  Ausnahme seit 0.4.3: Zeichen außerhalb `[A-Za-z0-9_,-]` in der Namensspalte werden zu `_` (Umlaute
  umschrieben), wie ioBroker es für Objekt-IDs empfiehlt – z. B. `53051_Charge/discharge_command` →
  `53051_Charge_discharge_command`. Diese IDs beim Textersatz mit ändern.
- **Falle Weißliste:** Das WiNet-S2 hat eine IP-Weißliste für Modbus TCP. Nicht eingetragene Absender bekommen
  sofort `ECONNRESET` – die IP des ioBroker-Rechners (nach NAT) im WiNet eintragen.
- Die Vorgabetabellen sind englisch beschriftet; Namen, Klartexte, Einheiten und Grenzen lassen sich in den
  Registertabellen ändern, ohne dass sich die IDs ändern.
- **Register-Vorlage:** Neben den vorab gelesenen Registern stehen 187 weitere bekannte Sungrow-Register im
  Katalog (109 Input, 78 Holding, nicht aktiv; Namen in 11 Sprachen): Gerätetyp, Seriennummer, Firmware, MPPT 4, Akkuleistung und
  -strom mit Vorzeichen, Zähler des Energiezählers, Monatserträge, Fehlercodes, Akkustrom/-temperatur des SBH,
  Uhr, Einspeisebegrenzung, Lade-/Entladegrenzen, Zwangsladung u. a. Häkchen setzen und speichern – das Register
  wird im Leseblock seiner Gruppe mitgelesen. Quellen: Home-Assistant-Integration von mkaiser (MIT) und die
  Registerliste der Referenzanlage. Abhaken eines bisher gelesenen Registers löscht dessen Datenpunkt.
- **Umrechnungshilfe** (eigener Reiter): Adresse in allen Schreibweisen (Sungrow-Doku ab 1 wie SunGather/openHAB;
  Protokolladresse ab 0 wie Excel-/Registerlisten, Home Assistant, evcc, ioBroker.modbus ohne Aliase; Spalte
  „Adresse“ = Protokoll + 30001/40001; Modicon 6-stellig), automatische Erkennung wo eindeutig, bekanntes Register
  an der Adresse und die Nachbarn bei Verzähler um eins (43022 = Battery power, 43023 = Battery level), Datentyp, Vorzeichen, Wortreihenfolge (Sungrow:
  niederwertiges Wort zuerst = `…sw`) und Faktor erklärt; Rohwerte werden auf alle üblichen Arten gelesen, mit
  Warnungen und auf Wunsch einmaliger Test-Lesung vom Gerät (nur lesen).

## Visualisierung (vis-Vorlagen)

Im Ordner [`vis-templates/`](vis-templates/) liegen fertige **vis-1**-Ansichten (animierter Energiefluss, Akku,
Wechselrichter & Netz, Adapter-Diagnose) und ein Akku-Symbol als Widget in zwei Farben. Sie nutzen nur
Datenpunkte von `sungrow-local.0` – keine Skripte, keine anderen Adapter. Import siehe
[vis-templates/README.md](vis-templates/README.md).

