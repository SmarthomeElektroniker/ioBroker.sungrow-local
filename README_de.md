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
- **Reiter „Status“** in der Instanz-Konfiguration mit Verbindung, Herzschlag und Zählern je Gruppe.
- **Umstieg von ioBroker.modbus:** gleiche IDs, Namen, Einheiten, Faktoren, Typen und Rollen – Textersatz
  `modbus.N.` → `sungrow-local.0.`. Die alte Modbus-Instanz vorher abschalten: das WiNet soll nur einen Client sehen.
- **Falle Weißliste:** Das WiNet-S2 hat eine IP-Weißliste für Modbus TCP. Nicht eingetragene Absender bekommen
  sofort `ECONNRESET` – die IP des ioBroker-Rechners (nach NAT) im WiNet eintragen.
- Die Vorgabetabellen sind englisch beschriftet; Namen, Klartexte, Einheiten und Grenzen lassen sich in den
  Registertabellen ändern, ohne dass sich die IDs ändern.
