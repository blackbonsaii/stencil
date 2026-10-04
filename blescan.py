import asyncio
from bleak import BleakScanner, BleakClient
async def main():
    devs = await BleakScanner.discover(timeout=8, return_adv=True)
    hits = [(d,a) for d,a in devs.values() if d.name and any(k in d.name.upper() for k in ("TP88","PHOMEMO","M08"))]
    for d,a in devs.values():
        if d.name: print(f"seen: {d.name!r} rssi={a.rssi}")
    for d,a in hits:
        print("\n== connecting", d.name, d.address)
        async with BleakClient(d) as c:
            for svc in c.services:
                print("service", svc.uuid)
                for ch in svc.characteristics:
                    print("   char", ch.uuid, ch.properties)
if __name__ == "__main__":
    asyncio.run(main())
