# Phomemo TP88 protocol notes

Verified on a TP88, firmware 1.4.0. Same command set as the Phomemo M08F.

## Transports

| | USB | Bluetooth LE |
|---|---|---|
| Identity | USB CDC serial, VID `0483` PID `5740` (STM32), manufacturer "QUIN", appears as `/dev/cu.usbmodem*` on macOS | Advertised name `TP88` |
| Write | serial write (baud ignored) | characteristic `0000ff02-…` (service `0000ff00-…`), write-without-response |
| Read | serial read | notifications on `0000ff03-…` |
| Flow control | none needed | credit-based, see below |

The command bytes are identical on both.

## BLE flow control

On subscribing to `ff03` the printer sends:
- `01 nn` — grant of `nn` send credits (initially `01 07` = 7).
- `02 LL HH` — max payload per write, little-endian (`02 f4 00` = 244 bytes).

Each write of ≤ max-payload bytes consumes one credit. The printer returns credits with `01 nn` as it drains its buffer. Never write with zero credits.

Measured throughput: ~30 KB/s (a 147 KB job in 4.8 s; a full Letter sheet ≈ 465 KB ≈ 15 s).

## Status queries (reply prefix `1a`)

| Query | Reply | Meaning |
|---|---|---|
| `1f 11 08` | `1a 04 nn` | battery % |
| `1f 11 11` | `1a 06 xx` | paper: bit 0 set = loaded (`89` loaded, `88` empty) |
| `1f 11 07` | `1a 07 a b c` | firmware a.b.c |
| `1f 11 09` | `1a 08 <ascii>` | serial number |
| `1f 11 12` | `1a 05 xx` | cover: `98` = closed (open value not yet observed) |

Unsolicited messages seen:
- `1a 3b 04 18 00 00 00` ~2 s after the BLE connect (meaning unknown).
- `1a 0f 0c` at the end of a print job (probably "job finished").

## Printing

```
1b 40                              ESC @  — initialise
1d 28 4b 02 00 31 nn               darkness, nn = 1..8 (4 used so far)
1d 76 30 00 wL wH hL hH <data>     GS v 0 raster band; repeat per band
1b 64 nn                           feed nn lines
```

- Width is **208 bytes = 1664 dots** per line (203 dpi ≈ 8.2 in). A 216-byte width is silently ignored: nothing prints.
- Bit 1 = black, most significant bit = leftmost dot.
- Bands are at most 255 lines tall.
- Blank leading rows advance the paper, so they can be used to place an image lower on the sheet.

## Paper position between jobs

The printer does **not** rewind between jobs. If the sheet is left in, the next job starts where the previous one stopped, plus about 3.5 mm. Measured: a 400-row job (50 mm), then a job with 508 blank rows (63.5 mm) before a box. The box top landed 117 mm below the first job's top edge, against 113.5 mm expected.

Reinserting the sheet resets the position to the top. Any position tracking has to model both cases.
