import asyncio, time
from bleak import BleakScanner, BleakClient
W="0000ff02-0000-1000-8000-00805f9b34fb"; N="0000ff03-0000-1000-8000-00805f9b34fb"
async def main():
    d = await BleakScanner.find_device_by_name("TP88", timeout=10)
    async with BleakClient(d) as c:
        t0=time.time()
        await c.start_notify(N, lambda _,b: print(f"  {time.time()-t0:5.2f}s notify {b.hex(' ')}"))
        await asyncio.sleep(2); print("-- idle done")
        for name,cmd in (("battery",[0x1f,0x11,0x08]),("paper",[0x1f,0x11,0x11]),("fw",[0x1f,0x11,0x07]),("serial",[0x1f,0x11,0x09]),("cover",[0x1f,0x11,0x12])):
            print("--", name); await c.write_gatt_char(W, bytes(cmd), response=True); await asyncio.sleep(1.5)
        for ch in c.services.get_service("0000180a-0000-1000-8000-00805f9b34fb").characteristics:
            try: print("devinfo", ch.description, await c.read_gatt_char(ch))
            except Exception as e: pass
if __name__ == "__main__":
    asyncio.run(main())
